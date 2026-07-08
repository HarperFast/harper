/**
 * YAML→registry boot bridge (#629 / #630 of #510).
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
 * backend should not block Harper boot.
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

/**
 * Populate the model registry from `rootConfig.models`. No-op if the block
 * is absent or empty. Idempotent within a process: each entry overwrites any
 * prior registration under the same logical name (registry uses `.set()`).
 */
export async function bootstrapModels(rootConfig: RootConfig | undefined | null): Promise<void> {
	// Rebuild fallback groups from scratch each (re)load so a removed/changed `fallback:`
	// (or a removed `models:` block) doesn't leave stale routing behind (#1326).
	clearFallbackGroups();
	const block = rootConfig?.models;
	if (!block) return;
	await registerKind('embedding', block.embedding);
	await registerKind('generative', block.generative);
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

async function registerKind(kind: ModelKind, entries: Record<string, ModelEntry> | undefined): Promise<void> {
	if (!entries) return;
	for (const [logicalName, entry] of Object.entries(entries)) {
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
			const builtin = FACTORIES[entry.backend];
			if (builtin) {
				await builtin({ logicalName, kind, config });
			} else {
				// Not a built-in name: treat `backend` as a module specifier (#1471).
				await registerFromModule(kind, logicalName, entry.backend, config);
			}
			// Record the ordered fallback group (other logical names) for the router (#1326).
			if (entry.fallback?.length) setFallbackGroup(kind, logicalName, entry.fallback);
		} catch (err) {
			harperLogger.error(`models.${kind}.${logicalName}: registration failed (${(err as Error)?.message ?? err})`);
		}
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
