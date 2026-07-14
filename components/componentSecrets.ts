/**
 * Component-facing consumption of the hdb_secret store (#1550) — two explicit, mutually-exclusive
 * delivery tiers keyed off the row itself (set_secret decides the tier; see components/secretOperations.ts):
 *
 * - Global tier: rows flagged `processEnv: true` are decrypted at startup (before components load)
 *   and materialized into the REAL `process.env`, exactly like `.env` values. Precedence: a
 *   pre-existing real environment variable always wins over the store. Child processes inherit
 *   these values (same as `.env` today). There is no isolation promise on this tier.
 * - Scoped tier: rows with `grants` (and no `processEnv`) NEVER land in `process.env` — they are
 *   exposed only through the per-component accessor (`import { secrets } from 'harper'` /
 *   `scope.secrets`), so they are not inherited by child processes and are invisible to env dumps.
 *   The `grants` list on the row is the authority for which components see them; a row with neither
 *   `processEnv` nor any grant is inert (visible to no component) until it is granted.
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
 * Liveness (#1776): a change watcher on the store keeps the SCOPED tier live — the per-component
 * accessor (`secrets.NAME`) and `secrets.subscribe(name)` reflect a later set_secret/grant/revoke/delete
 * without a reload. The GLOBAL (`process.env`) tier stays reload-only: a live change never re-mutates
 * `process.env` under already-running code (child processes have inherited it; arbitrary code has cached
 * it), so materialized env values still heal only on restart or component reload. Late custody likewise
 * heals on reload (each load cycle re-reads and re-decrypts the store).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { databases } from '../resources/databases.ts';
import { SYSTEM_TABLE_NAMES } from '../utility/hdbTerms.ts';
import { getSecretDecryptor } from '../resources/secretDecryptor.ts';
import { isEncryptedEnvValue } from '../utility/envFile.ts';
import logger from '../utility/logging/harper_logger.ts';
import { _assignPackageExport } from '../globals.js';

const SECRET_TABLE = SYSTEM_TABLE_NAMES.SECRET_TABLE_NAME;

/**
 * Subscribe to a secret's current value and any subsequent changes (#1776). Yields the current value
 * first, then on each change; `undefined` means the component has no access right now (never granted,
 * revoked, or deleted) — the same thing `secrets[name]` reads as. The stream stays open across that,
 * so a re-grant/re-add resumes on the same iterator.
 */
export type SecretSubscribe = (name: string) => AsyncIterableIterator<string | undefined>;

/**
 * A per-component secrets view: read-only name→value map exposed as `import { secrets } from 'harper'`,
 * plus the reserved, non-enumerable `subscribe(name)` method for live change subscription.
 */
export type SecretsView = Readonly<Record<string, string>> & { readonly subscribe: SecretSubscribe };

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
	/** Whether this row is materialized into the real process.env (the global delivery tier). */
	processEnv: boolean;
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
// Cached LIVE per-component view proxies (stable per component; they resolve values on each read, so
// they never need invalidating on a secret change — only on reset).
const accessorCache = new Map<string, SecretsView>();
// Components already warned about a secret named `subscribe` shadowing the reserved method.
const warnedSubscribeShadow = new Set<string>();

/**
 * Build the in-memory state for one hdb_secret row: normalize grants, read the tier flag, and
 * decrypt the envelope with this node's custody. The single source of truth for turning a stored
 * record into a {grants, processEnv, value?, failure?} — shared by the load-cycle scan
 * (doMaterializeGlobalSecrets) and the live change watcher (dispatchSecretChange), so both paths
 * apply identical decrypt/failure semantics.
 */
function rowStateFromRecord(record: any): SecretRowState {
	const state: SecretRowState = {
		grants: Array.isArray(record.grants) ? [...new Set(record.grants as string[])] : [],
		processEnv: record.processEnv === true,
	};
	if (typeof record.envelope === 'string') {
		const decryptor = getSecretDecryptor();
		if (!decryptor) {
			state.failure = 'no secrets custody is registered on this node';
		} else {
			try {
				state.value = decryptor(record.envelope);
			} catch (error) {
				state.failure = `decrypt failed: ${(error as Error).message}`;
			}
		}
	} else {
		state.failure = 'stored row has no envelope';
	}
	return state;
}

/**
 * Read the hdb_secret store, decrypt what this node's custody allows, materialize the global tier
 * (`processEnv: true` rows) into the real process.env, and snapshot the scoped tier for the accessor. Runs
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

// Bump on every applied live change, so a full rescan can detect that its stable-snapshot view raced
// a newer watcher update and retry rather than clobber it (see scanIntoSecretRows).
let secretEventSeq = 0;
const SCAN_RETRY_LIMIT = 5;

/**
 * Rebuild `secretRows` (the live snapshot behind the scoped accessor and subscriptions) from a full
 * table scan, then re-deliver current values to every open stream. `table.search` uses a stable
 * snapshot, so a scan that started before a revoke could otherwise complete afterward and re-authorize
 * the just-revoked secret; to prevent that we retry the scan when a live change was applied while it
 * ran, and the final assignment is synchronous (no await) so no event can interleave between the guard
 * check and the assignment. Does NOT touch process.env — callers that must (re)materialize the global
 * tier do that separately (it stays reload-only).
 */
async function scanIntoSecretRows(table: any): Promise<Map<string, SecretRowState>> {
	let rows: Map<string, SecretRowState>;
	let before: number;
	let attempts = 0;
	do {
		before = secretEventSeq;
		rows = new Map();
		for await (const record of table.search([])) {
			const name = record.name;
			if (typeof name !== 'string' || !name) continue;
			rows.set(name, rowStateFromRecord(record));
		}
	} while (before !== secretEventSeq && ++attempts < SCAN_RETRY_LIMIT);
	if (before !== secretEventSeq) {
		logger.warn(
			'Secrets store changed repeatedly during a rescan; applying the latest scan (heals on the next change)'
		);
	}
	secretRows = rows;
	storeAvailable = true;
	redispatchAllStreams();
	return rows;
}

async function doMaterializeGlobalSecrets(): Promise<void> {
	const table = (databases as { system?: Record<string, any> }).system?.[SECRET_TABLE];
	if (!table) {
		storeAvailable = false;
		secretRows = new Map();
		accessorCache.clear();
		redispatchAllStreams(); // reflect the store going away to any open streams
		logger.debug?.(
			`Secrets store not initialized (system.${SECRET_TABLE} missing); component env declarations can only be satisfied from process.env`
		);
		return;
	}
	// Start the watcher BEFORE the scan so a change committed during the scan bumps secretEventSeq and
	// forces a retry (closing the scan→attach gap where a deletion would otherwise be lost). Non-fatal:
	// a subscribe failure leaves the node bootable with reload-only secrets.
	try {
		await ensureSecretWatcher(table);
	} catch (error) {
		logger.warn(
			`Could not start the live secrets change watcher (secrets will be reload-only): ${(error as Error).message}`
		);
	}
	let rows: Map<string, SecretRowState>;
	try {
		rows = await scanIntoSecretRows(table);
	} catch (error) {
		// Leave the previous snapshot (and process.env) untouched rather than acting on a partial read.
		logger.error(`Failed to read the secrets store (system.${SECRET_TABLE}): ${(error as Error).message}`);
		return;
	}

	for (const [name, state] of rows) {
		if (!state.processEnv) {
			// Scoped tier (or an inert un-granted row): never in process.env. If a previous cycle
			// materialized this name as a processEnv secret and it has since been converted to scoped,
			// retract our value.
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
	if (row && !row.processEnv) {
		// Scoped tier: satisfied only through the accessor for a granted component. An empty-grants row
		// is inert (granted to nobody), so it falls through to the `ungranted` branch.
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
	if (process.env[name] !== undefined) return undefined; // processEnv tier materialized, literal, or real env
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

// ── Live secret change subscription (#1776) ────────────────────────────────────────────────────
//
// `secrets.subscribe(name)` returns an async iterable that yields the secret's current effective
// value (if the component has access now) and then a new value on every change — so an app can
// hot-swap an API key without a restart. It is a decrypted, grant-filtered PROJECTION over the
// replicated `system.hdb_secret` table's own subscription: a `set_secret`/`grant_secret` on ANY
// node replicates the row, the one shared table watcher observes the commit, and the change fans
// out to the subscribers of that name. Change authority is re-evaluated per event through the SAME
// resolver as the read accessor (continuous re-authorization, the property #1414 enforces), so a
// `revoke_secret`/`delete_secret` that removes the component's access hands the stream `undefined`
// (and retains no plaintext) rather than the last value — the app can never keep receiving a secret
// it has lost rights to. The stream stays open across that, so a later re-grant/re-add resumes on it.
//
// Tier semantics: the SCOPED tier is fully live (value resolved from the freshly decrypted row).
// The global (processEnv) tier stays reload-only for `process.env` itself — a live change never
// silently re-mutates process.env under already-running code — but a subscriber to a declared
// global name still receives the fresh decrypted value through this channel.

/**
 * A single (component, secret-name) live subscription: a minimal push async-iterator that yields the
 * secret's current effective value and then a new value on every change. A value of `undefined` means
 * the component has no access right now (never granted, revoked, or the secret was deleted) — the same
 * thing `secrets[name]` reads as. The stream stays open across that transition, so a delete-then-re-add
 * or revoke-then-re-grant resumes on the SAME iterator with no re-subscribe. It ends only when the
 * consumer breaks out, the component is unloaded, or the store is unavailable.
 */
type SecretValue = string | undefined;
class SecretChangeStream implements AsyncIterableIterator<SecretValue> {
	// At most one undelivered value: this is a current-state stream, so a newer value COALESCES over an
	// unconsumed older one. That also means a revoke (deliver `undefined`) drops any queued plaintext a
	// slow consumer had not yet read — no stale secret is handed out after access is lost.
	#queued: { value: SecretValue } | null = null;
	// FIFO of parked next() resolvers, so concurrent next() calls each settle (a single slot would drop
	// all but the last).
	#waiters: Array<(result: IteratorResult<SecretValue>) => void> = [];
	#closed = false;
	/** Whether any value has been delivered yet, so the first (possibly `undefined`) value always emits. */
	#hasEmitted = false;
	/** Last value delivered, so an unrelated row change doesn't re-emit an unchanged value. */
	lastValue: SecretValue;
	readonly componentName: string;
	readonly name: string;

	constructor(componentName: string, name: string) {
		this.componentName = componentName;
		this.name = name;
	}

	get closed(): boolean {
		return this.#closed;
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<SecretValue> {
		return this;
	}

	next(): Promise<IteratorResult<SecretValue>> {
		if (this.#queued) {
			const { value } = this.#queued;
			this.#queued = null;
			return Promise.resolve({ value, done: false });
		}
		if (this.#closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.#waiters.push(resolve));
	}

	// Consumer breaking out of `for await` — tear down and stop tracking this stream.
	return(): Promise<IteratorResult<SecretValue>> {
		this.#close();
		return Promise.resolve({ value: undefined, done: true });
	}

	// Producer side: deliver the current effective value (bespoke iterator rather than IterableEventQueue
	// so an `undefined`/empty-string value can't be misread as an empty queue). Dedups so an unrelated
	// row change doesn't re-emit an unchanged value; the first value always emits so a currently-absent
	// secret yields `undefined` up front.
	deliver(value: SecretValue): void {
		if (this.#closed) return;
		if (this.#hasEmitted && value === this.lastValue) return;
		this.#hasEmitted = true;
		this.lastValue = value;
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.#queued = { value }; // replace: coalesce to the latest, dropping any stale queued value
	}

	// Producer side: end the stream (consumer/component gone, or the store is unavailable). Access loss
	// is NOT an end — it is delivered as an `undefined` value via deliver().
	end(): void {
		this.#close();
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		// Drop any queued plaintext and the retained last value so nothing is readable after close.
		this.#queued = null;
		this.lastValue = undefined;
		unregisterStream(this);
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const waiter of waiters) waiter({ value: undefined, done: true });
	}
}

// name → active streams for that name. Keyed by secret name so a change dispatches only to the
// streams that care, without every stream filtering every commit.
const secretSubscribers = new Map<string, Set<SecretChangeStream>>();

function registerStream(stream: SecretChangeStream): void {
	let streams = secretSubscribers.get(stream.name);
	if (!streams) secretSubscribers.set(stream.name, (streams = new Set()));
	streams.add(stream);
}

function unregisterStream(stream: SecretChangeStream): void {
	const streams = secretSubscribers.get(stream.name);
	if (!streams) return;
	streams.delete(stream);
	if (streams.size === 0) secretSubscribers.delete(stream.name);
}

/**
 * Resolve a component's effective view of one secret from a freshly-decrypted row state — the SAME
 * authority the read accessor applies (scoped rows require a grant; global/absent rows require a
 * declaration), so the subscription can never widen access. Returns the value when available.
 */
function resolveSubscribedSecret(
	componentName: string,
	name: string,
	row: SecretRowState | undefined
): { available: boolean; value?: string } {
	// `subscribe` is the reserved accessor method, never a readable secret (it is shadowed on the view),
	// so it must be uniformly invisible as a value here too — otherwise subscribe('subscribe') would leak
	// the plaintext of a secret literally named `subscribe` that the accessor hides.
	if (name === 'subscribe') return { available: false };
	// Exactly the read accessor's authority (getSecretsForComponent), so a subscription can never
	// widen access beyond a fresh `secrets[name]` read:
	//  1. a scoped row granted to this component and decryptable → its live decrypted value;
	//  2. otherwise, a name this component DECLARED → its process.env value (global-materialized,
	//     literal, or a real env var — reload-only, precedence already resolved in process.env).
	// The process.env fallback is gated on declaration: an undeclared, ungranted component must never
	// read a still-materialized global value out of process.env (that would bypass the grant model).
	if (row && !row.processEnv && row.value !== undefined && row.grants.includes(componentName)) {
		return { available: true, value: row.value };
	}
	if (declaredEnvNames.get(componentName)?.has(name)) {
		const envValue = process.env[name];
		if (envValue !== undefined) return { available: true, value: envValue };
	}
	return { available: false };
}

// The one shared subscription to system.hdb_secret. Lazily started on the first subscribe; a
// single watcher feeds every stream.
let secretWatcher: Promise<void> | undefined;
let secretWatcherSubscription: { emit?: (event: string) => void; end?: () => void } | undefined;

function restartSecretWatcher(): void {
	// Drop the memo (and any live subscription) so the next ensureSecretWatcher() re-attaches.
	const sub = secretWatcherSubscription;
	secretWatcher = undefined;
	secretWatcherSubscription = undefined;
	sub?.emit?.('close');
	sub?.end?.();
}

function ensureSecretWatcher(table: any): Promise<void> {
	// Reset the memo on failure so a transient table.subscribe() error doesn't permanently disable live
	// secrets — the next caller retries instead of reusing a rejected promise.
	return (secretWatcher ??= (async () => {
		// omitCurrent: the load-cycle scan (scanIntoSecretRows) seeds and re-syncs the snapshot, and the
		// watcher is attached BEFORE that scan, so it need not (and should not) replay current rows here —
		// it only needs subsequent commits, local or replicated.
		secretWatcherSubscription = await table.subscribe({ omitCurrent: true, listener: onSecretEvent });
	})().catch((error) => {
		secretWatcher = undefined;
		throw error;
	}));
}

// Fired for every commit to system.hdb_secret (local or replicated). event.value is the full record
// on put; null-valued on delete. Keeps `secretRows` (the live view's source) current and fans the
// change out to any subscribers, WITHOUT touching process.env — the global tier stays reload-only.
function onSecretEvent(event: any): void {
	try {
		// Table.subscribe surfaces an async retained-state/replay failure by delivering the Error THROUGH
		// the listener (not by rejecting subscribe()), so detect it here and restart the watcher —
		// otherwise the memo stays fulfilled and every future ensureSecretWatcher reuses a dead subscription.
		if (event instanceof Error) {
			logger.warn(`secrets change watcher errored; restarting it: ${event.message}`);
			restartSecretWatcher();
			return;
		}
		// Base-copy replication of a system table delivers a single `{type:'reload', id:null}` marker
		// instead of per-row events (harper-pro#495): the whole table was reseeded, so re-scan the LIVE
		// snapshot to resync adds AND removals (and re-deliver to streams). It does NOT re-materialize
		// process.env — the global tier stays reload-only even under replicated reloads.
		if (event?.type === 'reload') {
			const table = (databases as { system?: Record<string, any> }).system?.[SECRET_TABLE];
			if (table)
				scanIntoSecretRows(table).catch((error) =>
					logger.warn(`secrets store rescan after a reload marker failed: ${(error as Error).message}`)
				);
			return;
		}
		const name = (event?.value?.name ?? event?.id) as unknown;
		if (typeof name !== 'string' || !name) return;
		secretEventSeq++; // let a concurrent rescan know its snapshot is now stale
		const record = event?.type === 'delete' ? null : (event?.value ?? null);
		const row = record ? rowStateFromRecord(record) : undefined;
		if (row) secretRows.set(name, row);
		else secretRows.delete(name);
		// The cached views are live proxies (they read secretRows on each access), so no invalidation is
		// needed here — a fresh `secrets[name]` read already reflects this update.
		dispatchSecretChange(name, row);
	} catch (error) {
		logger.warn(`secrets change subscription failed to dispatch an event: ${(error as Error).message}`);
	}
}

function dispatchSecretChange(name: string, row: SecretRowState | undefined): void {
	const streams = secretSubscribers.get(name);
	if (!streams || streams.size === 0) return;
	for (const stream of [...streams]) {
		// Authority is re-evaluated on EVERY event (continuous re-authorization, the property #1414
		// enforces): a revoke/delete/custody-loss resolves to unavailable → the stream is handed
		// `undefined` (no plaintext retained), not the last value. A later re-grant/re-add resolves to a
		// value again and resumes on the same stream. deliver() dedups unchanged values.
		const { available, value } = resolveSubscribedSecret(stream.componentName, name, row);
		stream.deliver(available ? value : undefined);
	}
}

// Re-deliver the current effective value to every open stream from the present `secretRows` — used
// after a full rescan (reload marker or load cycle), where individual per-row events were not seen so
// a removed row's subscribers would otherwise keep their stale value.
function redispatchAllStreams(): void {
	for (const [name, streams] of secretSubscribers) {
		const row = secretRows.get(name);
		for (const stream of [...streams]) {
			const { available, value } = resolveSubscribedSecret(stream.componentName, name, row);
			stream.deliver(available ? value : undefined);
		}
	}
}

/**
 * `secrets.subscribe(name)` for a component: the current effective value (matching `secrets[name]`)
 * then a stream of changes. Returned synchronously for direct use in `for await`. The initial value is
 * delivered SYNCHRONOUSLY from the live snapshot before the watcher is (re)started, so no change event
 * can interleave ahead of it and a stale value can never land after a newer one.
 */
function subscribeSecret(componentName: string, name: string): AsyncIterableIterator<SecretValue> {
	const stream = new SecretChangeStream(componentName, name);
	registerStream(stream);
	// Initial value from the current snapshot (scoped-granted live, or a declared name's process.env
	// value even when the store is unavailable — accessor-equivalent).
	const initial = resolveSubscribedSecret(componentName, name, secretRows.get(name));
	stream.deliver(initial.available ? initial.value : undefined);
	const table = (databases as { system?: Record<string, any> }).system?.[SECRET_TABLE];
	if (table) {
		// Start (or reuse) the one shared watcher so subsequent changes flow to this stream.
		ensureSecretWatcher(table).catch((error) => {
			logger.warn(`secrets.subscribe('${name}'): live change watcher unavailable: ${(error as Error).message}`);
		});
	} else {
		// No store to watch: the stream keeps its initial value and simply won't receive live updates
		// (nothing can change without the store); a reload/restart re-establishes it.
		logger.debug?.(
			`secrets.subscribe('${name}'): secrets store (system.${SECRET_TABLE}) is unavailable; no live updates`
		);
	}
	return stream;
}

/** Close every live subscription owned by a component (component reload/unload). */
export function closeComponentSubscriptions(componentName: string): void {
	for (const streams of secretSubscribers.values()) {
		for (const stream of [...streams]) if (stream.componentName === componentName) stream.end();
	}
}

/** The component's current effective value for one name (scoped-granted live, else declared→process.env). */
function currentSecretValue(componentName: string, name: string): string | undefined {
	const { available, value } = resolveSubscribedSecret(componentName, name, secretRows.get(name));
	return available ? value : undefined;
}

/**
 * Whether a secret named exactly `name` WOULD be readable to the component if it weren't reserved —
 * used only to detect (and warn about) a secret named `subscribe` shadowed by the reserved method.
 */
function hasRawSecretNamed(componentName: string, name: string): boolean {
	const row = secretRows.get(name);
	if (row && !row.processEnv && row.value !== undefined && row.grants.includes(componentName)) return true;
	return (declaredEnvNames.get(componentName)?.has(name) ?? false) && process.env[name] !== undefined;
}

/** The names currently visible to a component (granted scoped rows + declared names present in env). */
function currentSecretNames(componentName: string): string[] {
	const names = new Set<string>();
	const declared = declaredEnvNames.get(componentName);
	if (declared) for (const name of declared) if (process.env[name] !== undefined) names.add(name);
	for (const [name, row] of secretRows) {
		if (row.value !== undefined && !row.processEnv && row.grants.includes(componentName)) names.add(name);
	}
	names.delete('subscribe'); // reserved for the method — never surfaced as a value key
	return [...names];
}

/**
 * The secrets view for a component: scoped-tier rows granted to it, plus its DECLARED names resolved
 * from process.env (global-tier materialized values, env literals, or real env vars). The superset
 * lets app code use `secrets.FOO` uniformly, and lets ops later tighten a secret from global to
 * granted without breaking the app.
 *
 * It is a LIVE view (#1776): a Proxy that resolves each read from the current snapshot, so a scoped
 * secret's rotation/revoke is reflected by a fresh `secrets.FOO` read under every loader — including a
 * view captured once by the vm/compartment loader or held as `const v = scope.secrets` (only a
 * value destructured out, `const { FOO } = secrets`, is a point-in-time copy). Declared global names
 * still resolve from `process.env` (reload-only). Read-only and null-prototype, so Object.prototype
 * members can't masquerade as secrets and the view can't be mutated. `subscribe` is a reserved,
 * non-enumerable method (skipped by Object.keys/spread); a secret literally named `subscribe` is
 * shadowed by it — logged once when observed.
 */
export function getSecretsForComponent(componentName: string): SecretsView {
	let view = accessorCache.get(componentName);
	if (view) return view;
	const subscribe: SecretSubscribe = (name: string) => subscribeSecret(componentName, name);
	view = new Proxy(Object.create(null) as Record<string, string>, {
		get(_target, property) {
			if (property === 'subscribe') {
				// Advisory: warn once per component if a real secret named `subscribe` is shadowed by the
				// reserved method (it is then unreadable via dot/bracket access — an accepted #1776 tradeoff).
				if (!warnedSubscribeShadow.has(componentName)) {
					warnedSubscribeShadow.add(componentName);
					if (hasRawSecretNamed(componentName, 'subscribe')) {
						logger.warn(
							`Component '${componentName}' has a secret named 'subscribe'; it is shadowed by the reserved secrets.subscribe() method and is not readable through the secrets accessor`
						);
					}
				}
				return subscribe;
			}
			if (typeof property === 'symbol') return undefined;
			return currentSecretValue(componentName, property);
		},
		has(_target, property) {
			if (property === 'subscribe') return true;
			if (typeof property === 'symbol') return false;
			return currentSecretValue(componentName, property) !== undefined;
		},
		ownKeys() {
			// Include `subscribe` so own-property reflection is consistent (getOwnPropertyDescriptor
			// reports it); it is non-enumerable, so spread/Object.keys still skip it.
			return [...currentSecretNames(componentName), 'subscribe'];
		},
		getOwnPropertyDescriptor(_target, property) {
			if (property === 'subscribe') {
				return { value: subscribe, writable: false, enumerable: false, configurable: true };
			}
			if (typeof property === 'symbol') return undefined;
			const value = currentSecretValue(componentName, property);
			if (value === undefined) return undefined;
			return { value, writable: false, enumerable: true, configurable: true };
		},
		set: readOnly,
		defineProperty: readOnly,
		deleteProperty: readOnly,
		preventExtensions: readOnly,
		setPrototypeOf: readOnly,
	}) as unknown as SecretsView;
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

function resolveBoundSecrets(): SecretsView {
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
 * the object does not throw, and the enumeration traps (`has`/`ownKeys`/`getOwnPropertyDescriptor`)
 * report an empty object outside a binding context so inspectors/serializers (`util.inspect`,
 * spread) never crash the process — only direct property reads are loud.
 */
export const secrets: SecretsView = new Proxy(
	{},
	{
		// `subscribe` resolves like any other own property of the bound view (it is a non-enumerable
		// method there); it therefore reads through here, appears in ownKeys as non-enumerable, and is
		// skipped by spread/Object.keys — no special-casing needed in the traps.
		get(_target, property) {
			if (typeof property === 'symbol' || property === 'then') return undefined;
			return resolveBoundSecrets()[property];
		},
		has(_target, property) {
			if (typeof property === 'symbol') return false;
			if (componentBinding.getStore() === undefined) return false;
			return property in resolveBoundSecrets();
		},
		ownKeys() {
			if (componentBinding.getStore() === undefined) return [];
			return Reflect.ownKeys(resolveBoundSecrets());
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property === 'symbol' || componentBinding.getStore() === undefined) return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(resolveBoundSecrets(), property);
			// Report configurable so the proxy invariant against this (extensible, empty) target holds.
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
	// The empty target can't carry the reserved `subscribe` member statically; the get trap supplies it.
) as unknown as SecretsView;
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
	warnedSubscribeShadow.clear();
	for (const streams of secretSubscribers.values()) for (const stream of [...streams]) stream.end();
	secretSubscribers.clear();
	// Tear down the shared table watcher too, so a reset doesn't leak an audit-log listener.
	secretWatcherSubscription?.emit?.('close');
	secretWatcherSubscription?.end?.();
	secretWatcher = undefined;
	secretWatcherSubscription = undefined;
}
