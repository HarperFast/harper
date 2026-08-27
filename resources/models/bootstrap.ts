/**
 * YAML→registry boot bridge (#629 / #630 of #510), plus hot reload of the
 * `models` block when the root config file changes (#2344) — so an
 * orchestrator can rotate a credential or re-point a baseUrl by rewriting
 * harperdb-config.yaml, without a process restart.
 *
 * Reads the top-level `models` block from the root config and dispatches each
 * `models.embedding.<name>` / `models.generative.<name>` entry to the matching
 * per-backend register function. Backends self-contain in `components/<name>/`
 * (matches the pattern in `components/mcp/index.ts` from PR #649).
 *
 * Boot site: `components/componentLoader.ts` calls this after `getConfigObj()`
 * returns the root config and before per-component iteration, so that
 * `scope.models.embed(...)` works from `handleApplication(scope)`.
 *
 * A `backend` value that is not a built-in name is resolved as a module
 * specifier (a bare package, an instance-root-relative path, or an absolute
 * path), dynamically imported, and its exported factory invoked (#1471). This
 * makes `bootstrapModels` async; the boot site awaits it before per-component
 * iteration so the ordering guarantee above still holds.
 *
 * Env-var expansion: each entry's string leaves are run through
 * `expandEnvVarsDeep` before dispatch — `apiKey: ${OPENAI_API_KEY}` in YAML
 * becomes the resolved process.env value at the backend. Matches the
 * convention from `@harperfast/oauth`'s config loader.
 *
 * Errors per entry are logged and skipped, not thrown — one misconfigured
 * backend should not block Harper boot, and one bad entry in a rewritten file
 * should not tear down the entries that were fine.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';
import { expandEnvVarsDeep, isUnresolvedEnvVarPlaceholder } from '../../utility/expandEnvVar.ts';
import { registerOllamaBackend, type OllamaBackendConfig } from '../../components/ollama/index.ts';
import { registerOpenAIBackend, type OpenAIBackendConfig } from '../../components/openai/index.ts';
import { registerAnthropicBackend, type AnthropicBackendConfig } from '../../components/anthropic/index.ts';
import { registerBedrockBackend, type BedrockBackendConfig } from '../../components/bedrock/index.ts';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { getHdbBasePath } from '../../utility/environment/environmentManager.ts';
import { setFallbackGroup, clearFallbackGroups } from './routing.ts';
import {
	constructBackend,
	getBackend,
	removeIfCurrent,
	replaceIfCurrent,
	type CapturedInstall,
} from './backendRegistry.ts';
import { RootConfigWatcher } from '../../config/RootConfigWatcher.ts';
import { validateModelsBlock } from '../../validation/configValidator.ts';
import type { ModelBackend } from './types.ts';

/**
 * Field names treated as credentials. When present in config as a literal
 * value (not a `${VAR}` placeholder), bootstrap warns the operator at boot
 * — `harperdb-config.yaml` on disk in plaintext is a real anti-pattern.
 * Extend this list as future backends add credential fields.
 */
const CREDENTIAL_FIELDS = new Set(['apiKey']);

type ModelKind = 'embedding' | 'generative';

interface ModelEntry {
	backend?: string;
	host?: string;
	model?: string;
	requestTimeoutMs?: number;
	// openai + anthropic credentials
	apiKey?: string;
	baseUrl?: string;
	organization?: string;
	// bedrock
	region?: string;
	/** Ordered fallback group: other logical names tried, in order, after this one (#1326). */
	fallback?: string[];
}

interface ModelsConfig {
	embedding?: Record<string, ModelEntry>;
	generative?: Record<string, ModelEntry>;
}

interface RootConfig {
	models?: ModelsConfig;
}

type BackendRegisterFn = (args: { logicalName: string; kind: ModelKind; config: object }) => void | Promise<void>;

const FACTORIES: Record<string, BackendRegisterFn> = {
	ollama: (args) => registerOllamaBackend({ ...args, config: args.config as OllamaBackendConfig }),
	openai: (args) => registerOpenAIBackend({ ...args, config: args.config as OpenAIBackendConfig }),
	anthropic: (args) => registerAnthropicBackend({ ...args, config: args.config as AnthropicBackendConfig }),
	bedrock: (args) => registerBedrockBackend({ ...args, config: args.config as BedrockBackendConfig }),
};

// What the config projection currently has installed, per kind+logicalName slot. `backend` is the
// exact instance this module put in the registry: reload swaps compare against it, so a
// programmatic `registerBackend` that overrode a config entry keeps its documented precedence, and
// removal can never delete a slot another writer has since taken over.
interface InstalledSlot {
	kind: ModelKind;
	logicalName: string;
	/** The instance this projection installed; absent while an application override owns the slot. */
	backend?: ModelBackend;
	/** Raw entry as applied, for change detection — an unchanged entry is not reconstructed. */
	entryJson: string;
	/** The entry's fallback group as applied, so a retained backend keeps its routing. */
	fallback?: string[];
	/** Helper registrations the entry's factory made, installed and removed with the entry. */
	extras?: CapturedInstall[];
}

const installedSlots = new Map<string, InstalledSlot>();

/** Release a name held by a projection-installed helper, so a config entry can claim it. */
function claimHelperOccupant(kind: ModelKind, logicalName: string): ModelBackend | undefined {
	for (const slot of installedSlots.values()) {
		const index = slot.extras?.findIndex((e) => e.kind === kind && e.logicalName === logicalName) ?? -1;
		if (index >= 0) {
			const [extra] = slot.extras!.splice(index, 1);
			return extra.backend;
		}
	}
	return undefined;
}

const slotKey = (kind: ModelKind, logicalName: string) => `${kind} ${logicalName}`;

/**
 * Populate the model registry from `rootConfig.models`. No-op if the block
 * is absent or empty. Idempotent within a process: each entry overwrites any
 * prior registration under the same logical name.
 */
export async function bootstrapModels(rootConfig: RootConfig | undefined | null): Promise<void> {
	// The projection is NOT reset here: boot rides the same serialized queue as a reload, so a
	// re-bootstrap in a long-lived process removes entries the new config dropped, keeps retained
	// state (a malformed entry's routing), and cannot corrupt an in-flight apply's swaps.
	return queueModelsApply(rootConfig?.models, true);
}

/** Forget everything the projection installed. Test isolation only — never part of a reload. */
export function resetModelsProjection(): void {
	installedSlots.clear();
}

/**
 * Apply a `models:` block as a hot reload: changed entries are rebuilt through the same factories
 * boot uses and swapped in atomically, removed entries stop serving, and programmatic
 * registrations that overrode a config entry are left in place. Serialized and coalesced —
 * concurrent calls settle on the latest block.
 */
export function applyModelsConfig(models: ModelsConfig | undefined): Promise<void> {
	return queueModelsApply(models, false);
}

// Interleaved applies could install an older credential last; serialized + coalesced, they cannot.
let pendingApply: { block: ModelsConfig | undefined; isBoot: boolean } | undefined;
let applyChain: Promise<void> | undefined;

function queueModelsApply(block: ModelsConfig | undefined, isBoot: boolean): Promise<void> {
	pendingApply = { block, isBoot };
	applyChain ??= (async () => {
		try {
			while (pendingApply) {
				const next = pendingApply;
				pendingApply = undefined;
				try {
					await applyModels(next.block, next.isBoot);
				} catch (err) {
					// Per-entry failures are handled inside applyModels; this catches a failure of the apply
					// itself. The chain must not reject — the watcher calls fire-and-forget, so a rejection
					// would be unhandled — and the loop continues so a newer pending snapshot still applies.
					harperLogger.error(`models: config apply failed (${(err as Error)?.message ?? err})`);
				}
			}
		} finally {
			applyChain = undefined;
		}
	})();
	return applyChain;
}

interface DesiredEntry {
	kind: ModelKind;
	logicalName: string;
	entry: ModelEntry;
	entryJson: string;
}

function collectKind(
	kind: ModelKind,
	entries: Record<string, ModelEntry> | undefined,
	out: DesiredEntry[],
	present: Set<string>
): void {
	if (!entries) return;
	for (const [logicalName, entry] of Object.entries(entries)) {
		// Present even when invalid: a malformed entry keeps its previously applied backend (like a
		// failed rebuild does) rather than reading as removed. Only true absence removes.
		present.add(slotKey(kind, logicalName));
		if (!entry || typeof entry !== 'object') {
			// Schema validation (configValidator.ts) catches this before bootstrap
			// runs, so reaching here means config was loaded by an unusual path
			// (test, programmatic). Log at error so it's visible.
			harperLogger.error(`models.${kind}.${logicalName} is not an object; skipping`);
			continue;
		}
		if (typeof entry.backend !== 'string' || entry.backend.length === 0) {
			harperLogger.error(`models.${kind}.${logicalName}: 'backend' must be a non-empty string; skipping`);
			continue;
		}
		out.push({ kind, logicalName, entry, entryJson: JSON.stringify(entry) });
	}
}

async function applyModels(block: ModelsConfig | null | undefined, isBoot: boolean): Promise<void> {
	if (!isBoot) {
		if (block === undefined) {
			// A snapshot with no `models` key is not evidence of intent: a non-atomic in-place rewrite
			// can be observed as a valid YAML prefix that simply hasn't reached the block yet, and
			// removing every backend on that would be catastrophic. Removal is expressed by an empty
			// or shrunken block — `models: {}`. A bare `models:` key (null) is rejected by validation
			// below, exactly as boot's validator rejects it, so reload cannot accept a file a restart
			// would refuse.
			harperLogger.debug?.('models: watched config has no models block; projection left as-is');
			return;
		}
		// Boot validates the composed config (configValidator); a reload must enforce the same
		// schema, or a typo boot would reject hot-applies silently (e.g. a misspelled baseUrl
		// falling back to the public endpoint).
		const { error } = validateModelsBlock(block);
		if (error) {
			harperLogger.error(`models: rejecting config reload (${error.message}); keeping the previous projection`);
			return;
		}
	}
	const desired: DesiredEntry[] = [];
	const presentKeys = new Set<string>();
	collectKind('embedding', block?.embedding, desired, presentKeys);
	collectKind('generative', block?.generative, desired, presentKeys);

	const staged = new Map<string, { desiredEntry: DesiredEntry; backend: ModelBackend; extras: CapturedInstall[] }>();
	const failedKeys = new Set<string>();
	for (const desiredEntry of desired) {
		const { kind, logicalName, entry, entryJson } = desiredEntry;
		const key = slotKey(kind, logicalName);
		const slot = installedSlots.get(key);
		// Unchanged: skip while ANY occupant serves (rebuilding under an override would run the factory
		// only to lose the swap). Boot is stricter — it must overwrite occupants, so it only skips when
		// the projection's own instance is installed; an emptied registry rebuilds either way.
		const installed = getBackend(kind, logicalName);
		if (slot && slot.entryJson === entryJson && (isBoot ? installed === slot.backend : installed !== undefined))
			continue;
		// Warn before expansion: literal credentials in `harperdb-config.yaml`
		// land on disk, in backups, and (depending on deployment) in replicated
		// config tables. The `${VAR}` indirection pattern from
		// `@harperfast/oauth` is documented but not enforced.
		warnOnLiteralCredentials(kind, logicalName, entry);
		try {
			// Resolve `${VAR}` placeholders on every string leaf before handing the
			// entry to the backend factory. Backends receive concrete values and
			// don't need to know about env-var syntax. Unresolved placeholders
			// (env var unset) pass through unchanged — backend's required-field
			// validation catches them with a meaningful error.
			const config = expandEnvVarsDeep(entry);
			const { backend, extras } = await constructBackend(kind, logicalName, async () => {
				const builtin = FACTORIES[entry.backend as string];
				if (builtin) {
					await builtin({ logicalName, kind, config });
				} else {
					// Not a built-in name: treat `backend` as a module specifier (#1471).
					await registerFromModule(kind, logicalName, entry.backend as string, config);
				}
			});
			if (!backend) {
				harperLogger.error(
					`models.${kind}.${logicalName}: registration installed no backend; skipping ` +
						`(a factory must register before its returned promise resolves)`
				);
				failedKeys.add(key);
				continue;
			}
			staged.set(key, { desiredEntry, backend, extras });
		} catch (err) {
			failedKeys.add(key);
			harperLogger.error(`models.${kind}.${logicalName}: registration failed (${(err as Error)?.message ?? err})`);
		}
	}

	for (const { desiredEntry, backend, extras } of staged.values()) {
		const { kind, logicalName, entry, entryJson } = desiredEntry;
		const key = slotKey(kind, logicalName);
		// Boot overwrites occupants (the documented contract); a reload replaces only what this
		// projection installed — or a helper the projection installed under this name, which a config
		// entry outranks — so genuine application overrides survive.
		const previous = installedSlots.get(key);
		let expected = isBoot ? getBackend(kind, logicalName) : previous?.backend;
		// Spliced at boot too, or a later removal leaves a stale extra record CASing against a vacancy.
		const claimedHelper = claimHelperOccupant(kind, logicalName);
		if (!isBoot && expected === undefined && claimedHelper !== undefined) expected = claimedHelper;
		// Helpers rotate and retire with their entry even when the primary swap is lost to an
		// override — a frozen helper would keep serving a revoked credential.
		const installedExtras: CapturedInstall[] = [];
		for (const extra of extras) {
			const extraExpected = isBoot
				? getBackend(extra.kind, extra.logicalName)
				: previous?.extras?.find((e) => e.kind === extra.kind && e.logicalName === extra.logicalName)?.backend;
			if (replaceIfCurrent(extra.kind, extra.logicalName, extraExpected, extra.backend)) {
				installedExtras.push(extra);
			} else {
				harperLogger.warn(
					`models.${kind}.${logicalName}: helper '${extra.logicalName}' is owned by another registration; leaving it in place`
				);
			}
		}
		for (const old of previous?.extras ?? []) {
			if (!extras.some((e) => e.kind === old.kind && e.logicalName === old.logicalName)) {
				removeIfCurrent(old.kind, old.logicalName, old.backend);
			}
		}
		if (replaceIfCurrent(kind, logicalName, expected, backend)) {
			installedSlots.set(key, {
				kind,
				logicalName,
				backend,
				entryJson,
				fallback: entry.fallback,
				extras: installedExtras,
			});
		} else {
			// Record the ask with no installed instance, so unchanged reloads skip instead of
			// re-losing this swap every apply; installed helpers stay recorded and removable.
			installedSlots.set(key, { kind, logicalName, entryJson, fallback: entry.fallback, extras: installedExtras });
			harperLogger.warn(`models.${kind}.${logicalName}: another registration owns this entry; leaving it in place`);
		}
	}
	const desiredKeys = new Set(desired.map((d) => slotKey(d.kind, d.logicalName)));
	for (const [key, slot] of [...installedSlots]) {
		if (presentKeys.has(key)) continue;
		if (slot.backend) removeIfCurrent(slot.kind, slot.logicalName, slot.backend);
		for (const extra of slot.extras ?? []) removeIfCurrent(extra.kind, extra.logicalName, extra.backend);
		installedSlots.delete(key);
	}
	// Rebuild fallback routing from scratch each apply so a removed/changed `fallback:` (or a
	// removed `models:` block) doesn't leave stale routing behind (#1326).
	clearFallbackGroups();
	for (const { kind, logicalName, entry } of desired) {
		// A failed rebuild keeps its previous backend serving, so it keeps the routing that was
		// applied WITH that backend — not the new entry's group, which belongs to the build that
		// did not happen.
		const key = slotKey(kind, logicalName);
		const group = failedKeys.has(key) ? installedSlots.get(key)?.fallback : entry.fallback;
		if (group?.length && getBackend(kind, logicalName)) setFallbackGroup(kind, logicalName, group);
	}
	// Routing follows the name, not the instance.
	for (const [key, slot] of installedSlots) {
		if (desiredKeys.has(key) || !presentKeys.has(key)) continue;
		if (slot.fallback?.length && getBackend(slot.kind, slot.logicalName)) {
			setFallbackGroup(slot.kind, slot.logicalName, slot.fallback);
		}
	}
}

// ── Hot reload wiring ─────────────────────────────────────────────────────────

let modelsConfigWatcher: RootConfigWatcher | undefined;
let pendingSettle: NodeJS.Timeout | undefined;

/**
 * Watch the root config file and hot-apply `models:` changes. Follows `harper_logger`'s
 * root-config-watch pattern: one watcher per worker, each worker reprojecting its own registry.
 *
 * The watcher sees the FILE, but `HARPER_DEFAULT_CONFIG` / `HARPER_CONFIG` / `HARPER_SET_CONFIG`
 * compose with it at boot — so if any of those names `models`, the file alone is not authoritative
 * for the block and hot reload stays off, preserving boot semantics unchanged. (That is also the
 * compatibility gate: an orchestrator still injecting models through `HARPER_SET_CONFIG` gets
 * today's restart behavior; one that writes the file instead gets live reload.)
 *
 * Returns whether the watch is active.
 */
export function startModelsConfigHotReload(options?: { configFilePath?: string; debounceMs?: number }): boolean {
	if (modelsConfigWatcher) return true;
	const pinnedBy = envLayerNamingModels();
	if (pinnedBy) {
		harperLogger.info(
			`models: hot reload of the config file is disabled: ${pinnedBy} also defines 'models', so the file alone is not authoritative for it`
		);
		return false;
	}
	modelsConfigWatcher = new RootConfigWatcher(options?.configFilePath);
	// An 'error' event with no listener would take the worker down; and `ready` is an events.once
	// promise that rejects on a pre-ready 'error', so it must be observed too.
	modelsConfigWatcher.on('error', (error) => {
		harperLogger.warn(`models: config watcher error: ${(error as Error)?.message ?? error}`);
	});
	modelsConfigWatcher.ready.catch(() => {});
	// 'ready' carries the file state at watch start: a rewrite that lands during the watcher's
	// initial scan arrives there rather than as 'change', and an unchanged block is a no-op anyway.
	// Settle window: a non-atomic in-place rewrite emits an event per write() and an early snapshot
	// can be a schema-valid subset of the final file (a truncated map removes the unwritten
	// entries). Applying only the last event in a quiet window adopts the completed file. The real
	// contract for orchestrators remains an atomic tmp+rename.
	const debounceMs = options?.debounceMs ?? 150;
	const applyFromFile = (config: unknown) => {
		const models = (config as RootConfig | undefined)?.models;
		clearTimeout(pendingSettle);
		pendingSettle = setTimeout(() => {
			void queueModelsApply(models, false);
		}, debounceMs);
		pendingSettle.unref?.();
	};
	modelsConfigWatcher.on('ready', applyFromFile);
	modelsConfigWatcher.on('change', applyFromFile);
	return true;
}

/** Stop watching the config file. The current projection keeps serving. */
export function stopModelsConfigHotReload(): void {
	clearTimeout(pendingSettle);
	pendingSettle = undefined;
	modelsConfigWatcher?.close();
	modelsConfigWatcher = undefined;
}

function envLayerNamingModels(): string | undefined {
	for (const name of ['HARPER_SET_CONFIG', 'HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG']) {
		const raw = process.env[name];
		if (!raw) continue;
		try {
			const parsed = JSON.parse(raw);
			// Dotted top-level keys ("models.embedding.default") compose into the models block too
			// (harperConfigEnvVars flattens/expands them), so they pin exactly like a nested key.
			if (
				parsed &&
				typeof parsed === 'object' &&
				Object.keys(parsed).some((k) => k === 'models' || k.startsWith('models.'))
			)
				return name;
		} catch {
			// Malformed env config is reported by config loading itself; not this watcher's job.
		}
	}
	return undefined;
}

function warnOnLiteralCredentials(kind: ModelKind, logicalName: string, entry: ModelEntry): void {
	for (const field of CREDENTIAL_FIELDS) {
		const value = (entry as Record<string, unknown>)[field];
		if (typeof value !== 'string' || value.length === 0) continue;
		if (isUnresolvedEnvVarPlaceholder(value)) continue; // operator is using ${VAR} indirection
		harperLogger.warn(
			`models.${kind}.${logicalName}: '${field}' is a literal value in harperdb-config.yaml; ` +
				`prefer \${ENV_VAR} indirection for credentials to keep them off disk`
		);
	}
}

/**
 * Resolve a non-built-in `backend` value as a module and invoke its factory (#1471).
 *
 * Specifier forms: a bare package name (resolved from `node_modules` — the
 * Fabric-friendly path: install the backend as a dependency), an instance-root-
 * relative path (`./…`, anchored to the Harper base path), or an absolute path.
 * The module's default export — or a `register` export — is a factory of the
 * same shape as the built-in register functions, and may be async.
 *
 * A name that is neither a built-in nor an importable module throws (caught and
 * logged by the caller), with the known built-ins listed so a value-name typo
 * (`backend: 'openi'`) still gets a helpful message.
 *
 * The specifier is the raw `backend` value — unlike other config leaves it is
 * not `${VAR}`-expanded; a module specifier is not subject to env indirection.
 */
async function registerFromModule(
	kind: ModelKind,
	logicalName: string,
	specifier: string,
	config: object
): Promise<void> {
	let mod: Record<string, unknown>;
	try {
		mod = (await import(resolveBackendSpecifier(specifier))) as Record<string, unknown>;
	} catch (err) {
		const known = Object.keys(FACTORIES).sort().join(', ');
		throw new Error(
			`backend '${specifier}' is neither a built-in (${known}) nor an importable module: ${(err as Error)?.message ?? err}`
		);
	}
	// Probe a `register` export (named, or a static / `.register` on the default
	// export) BEFORE treating the default export as a callable: a `default class`
	// is `typeof === 'function'` and would throw "cannot invoke without 'new'".
	const fromDefault = mod.default as { register?: unknown } | undefined;
	const named = typeof mod.register === 'function' ? mod.register : fromDefault?.register;
	const factory = (
		typeof named === 'function' ? named : typeof mod.default === 'function' ? mod.default : undefined
	) as BackendRegisterFn | undefined;
	if (!factory) {
		throw new Error(
			`backend module '${specifier}' must export a default function (or a 'register' export) that registers the backend`
		);
	}
	await factory({ logicalName, kind, config });
}

/**
 * Resolve a backend module specifier to something `import()` accepts. Relative
 * paths anchor to the Harper instance root; absolute paths become file URLs;
 * bare package names pass through for Node's `node_modules` resolution.
 */
function resolveBackendSpecifier(specifier: string): string {
	// Relative path (`./`, `../`, and Windows `.\` `..\`): anchor to the instance root.
	if (specifier.startsWith('.')) {
		const base = getHdbBasePath();
		if (!base) throw new Error('cannot resolve a relative backend path: the Harper base path is unavailable');
		return pathToFileURL(resolvePath(base, specifier)).href;
	}
	if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
	// Bare package: resolve from the instance root's `node_modules` — where the
	// operator installs the backend — not Harper's own install tree, which
	// diverges from the instance root under a global / Docker / Fabric install.
	// Mirrors the `createRequire`-anchored resolution in `security/jsLoader.ts`.
	const base = getHdbBasePath();
	if (!base) return specifier; // unknown instance root: fall back to default resolution
	const requireFromRoot = createRequire(pathToFileURL(resolvePath(base, 'index.js')).href);
	return pathToFileURL(requireFromRoot.resolve(specifier)).href;
}
