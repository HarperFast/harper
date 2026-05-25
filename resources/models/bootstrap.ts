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
}

interface ModelsConfig {
	embedding?: Record<string, ModelEntry>;
	generative?: Record<string, ModelEntry>;
}

interface RootConfig {
	models?: ModelsConfig;
}

type BackendRegisterFn = (args: { logicalName: string; kind: ModelKind; config: object }) => void;

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
export function bootstrapModels(rootConfig: RootConfig | undefined | null): void {
	const block = rootConfig?.models;
	if (!block) return;
	registerKind('embedding', block.embedding);
	registerKind('generative', block.generative);
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

function registerKind(kind: ModelKind, entries: Record<string, ModelEntry> | undefined): void {
	if (!entries) return;
	for (const [logicalName, entry] of Object.entries(entries)) {
		if (!entry || typeof entry !== 'object') {
			// Schema validation (configValidator.ts) catches this before bootstrap
			// runs, so reaching here means config was loaded by an unusual path
			// (test, programmatic). Log at error so it's visible.
			harperLogger.error(`models.${kind}.${logicalName} is not an object; skipping`);
			continue;
		}
		const factory = entry.backend ? FACTORIES[entry.backend] : undefined;
		if (!factory) {
			// Loud because the operator opted into `models:` specifically to enable
			// a backend — silently registering nothing is a footgun. Schema-level
			// typo guards (`.unknown(false)` on modelEntrySchema) catch field-name
			// typos before this point; reaching here means `backend:` itself names
			// a type Harper doesn't ship a factory for in this version. List the
			// known backends so operators can spot value-name typos
			// (`backend: 'openi'` instead of `'openai'`).
			const known = Object.keys(FACTORIES).sort().join(', ');
			harperLogger.error(
				`models.${kind}.${logicalName}: unknown backend '${entry.backend ?? '(missing)'}'; skipping. Known backends: ${known}.`
			);
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
			const resolved = expandEnvVarsDeep(entry);
			factory({ logicalName, kind, config: resolved });
		} catch (err) {
			harperLogger.error(`models.${kind}.${logicalName}: registration failed (${(err as Error)?.message ?? err})`);
		}
	}
}
