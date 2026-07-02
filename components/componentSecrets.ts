/**
 * Component-facing consumption of the hdb_secret store (#1550) — two delivery tiers:
 *
 * - Global tier: rows with EMPTY `grants` are decrypted at startup (before components load) and
 *   materialized into the REAL `process.env`, exactly like `.env` values. Precedence: a
 *   pre-existing real environment variable always wins over the store. Child processes inherit
 *   these values (same as `.env` today). There is no isolation promise on this tier.
 * - Scoped tier: rows with NON-EMPTY `grants` NEVER land in `process.env` — they are exposed only
 *   through the per-component accessor (`import { secrets } from 'harper'` / `scope.secrets`), so
 *   they are not inherited by child processes and are invisible to env dumps. The `grants` list on
 *   the row is the authority for which components see them.
 *
 * Component configs declare their environment expectations in an `env:` block:
 *
 *   env:
 *     NODE_ENV: production                                  # string = inline literal → process.env
 *     STRIPE_KEY: { required: true, description: Stripe }   # object = declaration, satisfied from the store
 *     SENTRY_DSN: { required: false }                       # optional declaration
 *
 * Declarations are requests, never grants — a declaration cannot widen access to a scoped secret.
 * A `required: true` declaration that is unsatisfied stops that component from loading (the
 * instance keeps running); the failure reason is one of `missing` (no row, no env var),
 * `ungranted` (a scoped row exists but this component is not in its grants), or
 * `custody-unavailable` (a row exists but cannot be decrypted on this node).
 *
 * Scoping caveat (documented, deliberate): JS-level scoping is a slowdown layer, not a security
 * boundary — component code shares a process, so containers/uids remain the real boundary. Under
 * the vm/compartment loaders the `harper` module is per-scope, so `import { secrets } from
 * 'harper'` binds exactly; under the native loader (and for bundler-loaded code) the `harper`
 * package is a process-wide singleton, so `secrets` binds via the component-load AsyncLocalStorage
 * context. Accessing the process-wide `secrets` outside a component-load context fails loudly
 * rather than guessing. The recommended idiom is a module-top-level destructure
 * (`const { MY_KEY } = secrets;`), where binding is exact in every mode.
 *
 * Late custody / changed secrets heal on restart or component reload (each load cycle re-reads the
 * store) — there is no live re-materialization.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { databases } from '../resources/databases.ts';
import { SYSTEM_TABLE_NAMES } from '../utility/hdbTerms.ts';
import { getSecretDecryptor } from '../resources/secretDecryptor.ts';
import { isEncryptedEnvValue } from '../utility/envFile.ts';
import logger from '../utility/logging/harper_logger.ts';
import { _assignPackageExport } from '../globals.js';

const SECRET_TABLE = SYSTEM_TABLE_NAMES.SECRET_TABLE_NAME;

export type UnsatisfiedReason = 'missing' | 'ungranted' | 'custody-unavailable';

/** A declared-but-unsatisfied env expectation — metadata only, never values. */
export interface UnsatisfiedDeclaration {
	name: string;
	required: boolean;
	description?: string;
	reason: UnsatisfiedReason;
	/** The store tier of the matching row, when one exists (`missing` has no row, so no tier). */
	tier?: 'global' | 'scoped';
	/** Human-readable detail (e.g. the decrypt failure) — never the value. */
	detail?: string;
}

interface EnvDeclaration {
	required: boolean;
	description?: string;
}

interface SecretRowState {
	grants: string[];
	/** Decrypted plaintext; undefined when this node could not decrypt the envelope. */
	value?: string;
	/** Why decryption failed, when it did. */
	failure?: string;
}

// Snapshot of the store, refreshed by materializeGlobalSecrets() at the start of each load cycle.
let secretRows = new Map<string, SecretRowState>();
let storeAvailable = false;
// Keys THIS module wrote into process.env, so a reload can update them (changed secret) or retract
// them (row deleted / grants tightened to scoped) without ever touching genuinely pre-existing env.
const ownedEnvKeys = new Set<string>();

// Per-component registries, rebuilt as each component's env block is processed.
const declaredEnvNames = new Map<string, Set<string>>();
const unsatisfiedEnv = new Map<string, UnsatisfiedDeclaration[]>();
const accessorCache = new Map<string, Readonly<Record<string, string>>>();

/**
 * Read the hdb_secret store, decrypt what this node's custody allows, materialize the global tier
 * (empty `grants`) into the real process.env, and snapshot the scoped tier for the accessor. Runs
 * at the start of each load cycle, and again per env-declaring component load so out-of-cycle
 * loads (e.g. deploy validation in a long-lived worker) gate against a fresh snapshot. Never
 * throws — every degraded mode (table missing pre-upgrade, no custody registered, undecryptable
 * rows) logs and leaves the node bootable; the unsatisfied state surfaces per-component when
 * declarations are evaluated.
 *
 * The per-component declaration registries are deliberately NOT reset here: on the main thread
 * `loadedPaths` is never cleared in production, so already-loaded components are not reprocessed
 * on a reload cycle — a cycle-level wipe would permanently empty their status state. Registries
 * are overwrite-on-reprocess instead; state for a deleted component is unreachable from
 * `get_components` (which is keyed by the existing component directories).
 */
export function materializeGlobalSecrets(): Promise<void> {
	// Single-flight: concurrent callers (the load-cycle call plus per-env-component refreshes fanned
	// out by Promise.all over component loads) join one table scan instead of issuing N scans with
	// N×rows RSA decrypts, and two scans can never interleave — so an older, slower scan cannot
	// overwrite newer state. A caller arriving after completion starts a fresh scan, preserving the
	// deploy-validation freshness guarantee (set_secret → deploy is sequential).
	return (materializeInFlight ??= doMaterializeGlobalSecrets().finally(() => {
		materializeInFlight = undefined;
	}));
}
let materializeInFlight: Promise<void> | undefined;

async function doMaterializeGlobalSecrets(): Promise<void> {
	const table = (databases as { system?: Record<string, any> }).system?.[SECRET_TABLE];
	if (!table) {
		storeAvailable = false;
		secretRows = new Map();
		accessorCache.clear();
		logger.debug?.(
			`Secrets store not initialized (system.${SECRET_TABLE} missing); component env declarations can only be satisfied from process.env`
		);
		return;
	}
	const rows = new Map<string, SecretRowState>();
	const decryptor = getSecretDecryptor();
	try {
		for await (const row of table.search([])) {
			const name = row.name;
			if (typeof name !== 'string' || !name) continue;
			const state: SecretRowState = { grants: Array.isArray(row.grants) ? [...new Set(row.grants as string[])] : [] };
			if (typeof row.envelope === 'string') {
				if (!decryptor) {
					state.failure = 'no secrets custody is registered on this node';
				} else {
					try {
						state.value = decryptor(row.envelope);
					} catch (error) {
						state.failure = `decrypt failed: ${(error as Error).message}`;
					}
				}
			} else {
				state.failure = 'stored row has no envelope';
			}
			rows.set(name, state);
		}
	} catch (error) {
		// Leave the previous snapshot (and process.env) untouched rather than acting on a partial read.
		logger.error(`Failed to read the secrets store (system.${SECRET_TABLE}): ${(error as Error).message}`);
		return;
	}
	storeAvailable = true;

	for (const [name, state] of rows) {
		if (state.grants.length > 0) {
			// Scoped tier: never in process.env. If a previous cycle materialized this name as
			// global-tier and its grants have since been tightened, retract our value.
			if (ownedEnvKeys.has(name)) {
				delete process.env[name];
				ownedEnvKeys.delete(name);
			}
			continue;
		}
		if (state.value === undefined) {
			// Undecryptable global row: loud, never silent. If we own a previously-materialized value,
			// keep it (last known good) — a restart with custody heals.
			logger.error(`Secret '${name}' could not be materialized into process.env: ${state.failure}`);
			continue;
		}
		if (process.env[name] !== undefined && !ownedEnvKeys.has(name)) {
			logger.warn(`Secret '${name}' is already set on process.env; the pre-existing environment value wins`);
			continue;
		}
		process.env[name] = state.value;
		ownedEnvKeys.add(name);
	}
	// Rows deleted from the store since we materialized them: retract our value.
	for (const name of [...ownedEnvKeys]) {
		if (!rows.has(name)) {
			delete process.env[name];
			ownedEnvKeys.delete(name);
		}
	}
	secretRows = rows;
	accessorCache.clear();
}

function parseDeclaration(componentName: string, name: string, spec: unknown): EnvDeclaration {
	if (spec === null) return { required: false }; // bare `NAME:` in YAML — an optional declaration
	if (typeof spec !== 'object' || Array.isArray(spec)) {
		throw new Error(
			`env.${name} for component '${componentName}' must be a string literal or a declaration object like { required: true, description: ... }`
		);
	}
	const { required, description } = spec as { required?: unknown; description?: unknown };
	if (required !== undefined && typeof required !== 'boolean') {
		throw new Error(`env.${name} for component '${componentName}': 'required' must be a boolean`);
	}
	if (description !== undefined && typeof description !== 'string') {
		throw new Error(`env.${name} for component '${componentName}': 'description' must be a string`);
	}
	return { required: required === true, description: description as string | undefined };
}

// Inline string literal — same semantics as a `.env` line loaded by resources/loadEnv.ts:
// `enc:v1:` envelopes are decrypted via the registered decryptor (undecryptable → error log + skip,
// so the app fails on a missing var rather than receiving ciphertext), and a value already present
// on process.env wins. Like `.env` files today, literals mutate the SHARED process.env: another
// component's declaration of the same name can be satisfied (or its store row shadowed) depending
// on load order — an inherent property of the global env tier, not per-component isolation.
function applyEnvLiteral(componentName: string, name: string, value: string): void {
	if (isEncryptedEnvValue(value)) {
		const decryptor = getSecretDecryptor();
		if (!decryptor) {
			logger.error(
				`env.${name} for component '${componentName}' is encrypted but no secret decryptor is registered; skipping`
			);
			return;
		}
		try {
			value = decryptor(value);
		} catch (error) {
			logger.error(
				`Failed to decrypt env.${name} for component '${componentName}': ${(error as Error).message}; skipping`
			);
			return;
		}
	}
	if (process.env[name] !== undefined) {
		logger.warn(
			`Environment variable conflict: env.${name} from component '${componentName}' is already set on process.env; keeping the existing value`
		);
		return;
	}
	process.env[name] = value;
}

function evaluateDeclaration(
	componentName: string,
	name: string,
	declaration: EnvDeclaration
): UnsatisfiedDeclaration | undefined {
	const unsatisfied = (
		reason: UnsatisfiedReason,
		tier?: 'global' | 'scoped',
		detail?: string
	): UnsatisfiedDeclaration => ({
		name,
		required: declaration.required,
		description: declaration.description,
		reason,
		tier,
		detail,
	});
	const row = secretRows.get(name);
	if (row && row.grants.length > 0) {
		if (row.grants.includes(componentName)) {
			if (row.value !== undefined) return undefined; // satisfied via the scoped accessor
			// The accessor serves a real env var for declared names when the row is undecryptable, so
			// the gate must accept the same fallback — never gate out a value the runtime would have.
			if (process.env[name] !== undefined) return undefined;
			return unsatisfied('custody-unavailable', 'scoped', row.failure);
		}
		if (process.env[name] !== undefined) return undefined; // a real env var still satisfies the request
		return unsatisfied('ungranted', 'scoped', `the secret exists but is not granted to component '${componentName}'`);
	}
	if (process.env[name] !== undefined) return undefined; // global tier materialized, literal, or real env
	if (row) return unsatisfied('custody-unavailable', 'global', row.failure);
	return unsatisfied(
		'missing',
		undefined,
		storeAvailable ? 'not in the secrets store or process.env' : 'not in process.env (secrets store unavailable)'
	);
}

/**
 * Process a component's `env:` config block: evaluate declarations against the store snapshot +
 * process.env, and inject string literals into process.env. Two passes so nothing is mutated
 * before the whole block validates and the load-gate passes: an invalid shape or an unsatisfied
 * `required: true` declaration throws (naming each variable and why) WITHOUT applying any of the
 * block's literals. Optional unsatisfied declarations log a warning and are recorded for status
 * exposure.
 */
export function processComponentEnv(componentName: string, envConfig: unknown): void {
	if (envConfig === null || typeof envConfig !== 'object' || Array.isArray(envConfig)) {
		throw new Error(
			`the 'env' config block must be a mapping of environment variable names to a string value or a declaration object`
		);
	}
	const declared = new Set<string>();
	const literals: [string, string][] = [];
	const unsatisfied: UnsatisfiedDeclaration[] = [];
	const requiredFailures: string[] = [];
	for (const [name, spec] of Object.entries(envConfig)) {
		if (typeof spec === 'string' || typeof spec === 'number' || typeof spec === 'boolean') {
			literals.push([name, String(spec)]);
			continue;
		}
		const declaration = parseDeclaration(componentName, name, spec);
		declared.add(name);
		const problem = evaluateDeclaration(componentName, name, declaration);
		if (problem) {
			unsatisfied.push(problem);
			if (declaration.required) {
				requiredFailures.push(`${name} (${problem.reason}${problem.detail ? ` — ${problem.detail}` : ''})`);
			} else {
				logger.warn(
					`Optional environment variable '${name}' declared by component '${componentName}' is unsatisfied (${problem.reason}); omitting`
				);
			}
		}
	}
	declaredEnvNames.set(componentName, declared);
	unsatisfiedEnv.set(componentName, unsatisfied);
	accessorCache.delete(componentName);
	if (requiredFailures.length > 0) {
		throw new Error(`unsatisfied required environment variables: ${requiredFailures.join('; ')}`);
	}
	for (const [name, value] of literals) applyEnvLiteral(componentName, name, value);
}

/** Declared-but-unsatisfied env expectations for a component — metadata only, for status surfaces. */
export function getUnsatisfiedEnv(componentName: string): UnsatisfiedDeclaration[] {
	return unsatisfiedEnv.get(componentName) ?? [];
}

/**
 * The secrets view for a component: scoped-tier rows granted to it, plus its DECLARED names
 * resolved from process.env (global-tier materialized values, env literals, or real env vars).
 * The superset lets app code use `secrets.FOO` uniformly, and lets ops later tighten a secret from
 * global to granted without breaking the app. Values are decrypted eagerly at load; the object is
 * frozen and enumerable (`Object.keys`, spread).
 */
export function getSecretsForComponent(componentName: string): Readonly<Record<string, string>> {
	let view = accessorCache.get(componentName);
	if (view) return view;
	// Null prototype so inherited Object.prototype members (toString, hasOwnProperty, constructor)
	// can never masquerade as secret values under dynamic access like `secrets[key]`.
	const entries: Record<string, string> = Object.create(null);
	const declared = declaredEnvNames.get(componentName);
	if (declared) {
		for (const name of declared) {
			const value = process.env[name];
			if (value !== undefined) entries[name] = value;
		}
	}
	// Scoped rows granted to this component; on a name collision the scoped value wins.
	for (const [name, row] of secretRows) {
		if (row.value !== undefined && row.grants.length > 0 && row.grants.includes(componentName)) {
			entries[name] = row.value;
		}
	}
	view = Object.freeze(entries);
	accessorCache.set(componentName, view);
	return view;
}

// Component-load binding for the process-wide `secrets` export: the loader runs each component's
// module loading inside this context, so the singleton `harper` package (native loader, bundled
// code, natively-loaded deps) can still resolve which component is loading.
const componentBinding = new AsyncLocalStorage<string>();

/** Run `fn` with `secrets` bound to the named component (no-op when name is undefined). */
export function runWithComponentBinding<T>(componentName: string | undefined, fn: () => T): T {
	return componentName === undefined ? fn() : componentBinding.run(componentName, fn);
}

function resolveBoundSecrets(): Readonly<Record<string, string>> {
	const componentName = componentBinding.getStore();
	if (componentName === undefined) {
		throw new Error(
			`The 'secrets' accessor was used outside of a component-loading context, so Harper cannot resolve which ` +
				`component's secrets to expose (and will not guess — that could hand one component another component's ` +
				`scoped secrets). Read secrets at module top level during component load ` +
				`(e.g. \`const { MY_KEY } = secrets;\`) or use \`scope.secrets\` in an extension.`
		);
	}
	return getSecretsForComponent(componentName);
}

function readOnly(): never {
	throw new TypeError('secrets is read-only');
}

/**
 * The process-wide `secrets` export (`import { secrets } from 'harper'` under the native loader /
 * bundled code; under vm and compartment loaders the per-scope `harper` module carries an exactly
 * bound view instead). Resolves the current component from the component-load context; access from
 * an ambiguous context fails loudly. Symbols and `then` return undefined so awaiting/inspecting
 * the object does not throw.
 */
export const secrets: Readonly<Record<string, string>> = new Proxy(
	{},
	{
		get(_target, property) {
			if (typeof property === 'symbol' || property === 'then') return undefined;
			return resolveBoundSecrets()[property];
		},
		has(_target, property) {
			if (typeof property === 'symbol') return false;
			return property in resolveBoundSecrets();
		},
		ownKeys() {
			return Reflect.ownKeys(resolveBoundSecrets());
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property === 'symbol') return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(resolveBoundSecrets(), property);
			// The views are frozen; report configurable so the proxy invariant against its (extensible,
			// empty) target holds.
			return descriptor && { ...descriptor, configurable: true };
		},
		set: readOnly,
		defineProperty: readOnly,
		deleteProperty: readOnly,
		// Never allow the (shared, extensible) target to be made non-extensible — a successful
		// Object.freeze/preventExtensions would pin the proxy's key-set invariants to the empty
		// target and break enumeration for every later consumer.
		preventExtensions: readOnly,
		setPrototypeOf: readOnly,
	}
);
_assignPackageExport('secrets', secrets);

/** Reset all module state and retract materialized env values. Intended for tests. */
export function resetComponentSecrets(): void {
	for (const name of ownedEnvKeys) delete process.env[name];
	ownedEnvKeys.clear();
	secretRows = new Map();
	storeAvailable = false;
	declaredEnvNames.clear();
	unsatisfiedEnv.clear();
	accessorCache.clear();
}
