/**
 * Operations-profile tool generation. Exposes one MCP tool per Harper
 * operation that survives the `mcp.operations.allow` / `deny` filter, computed
 * *lazily* by walking Harper's live `OPERATION_FUNCTION_MAP` on each
 * `tools/list` / `tools/call`.
 *
 * The list is computed lazily (not snapshotted at registration) because
 * components register their operations via `server.registerOperation` during
 * `startOnMainThread`, which runs AFTER the MCP operations profile registers
 * (see components/mcp/index.ts → registerMcpProfile). A one-time walk at
 * registration time would miss every component-registered operation (e.g. the
 * built-in agent's `agent_prompt`), so `mcp.operations.allow` listing them
 * would silently have no effect — #1562. Walking the live map per request
 * removes the ordering dependence and stays consistent as components load.
 *
 * The default v1 allow list is read-only and intentionally narrow:
 * `describe_*`, `list_*`, `search_*`, plus an explicit set of safe
 * getters (`get_job`, `get_status`, `get_analytics`, `get_metrics`),
 * `system_information`, `read_log`, `read_audit_log`. A `get_*` glob
 * was rejected because it would have matched `get_configuration`
 * (TLS/S3/auth secrets), `get_components` + `get_component_file` +
 * `get_custom_function*` (component source code, which can embed
 * secrets), `get_backup`, and `get_deployment{,_payload}` — none of
 * which should default into the MCP surface even though
 * `verifyPerms` still gates the actual call. Operators who want any
 * of those opt in via `mcp.operations.allow`. Destructive ops carry
 * `destructiveHint: true` so well-behaved MCP clients can surface a
 * confirmation prompt.
 *
 * Tool dispatch delegates to `chooseOperation` + `processLocalTransaction`
 * — the same path Harper's REST `/operation` endpoint uses. That means
 * `verifyPerms` runs unchanged, replication catchup runs unchanged, and
 * server-side validation errors surface as `isError: true` results without
 * the MCP layer needing to know what each operation expects.
 */
import * as env from '../../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../../utility/hdbTerms.ts';
import harperLogger from '../../../utility/logging/harper_logger.ts';
import {
	canRoleInvokeOperation,
	setProfileToolProvider,
	type AuthedUser,
	type ProfileToolProvider,
	type ToolDef,
	type ToolResult,
} from '../toolRegistry.ts';
import { OPERATION_INPUT_SCHEMAS, PERMISSIVE_SCHEMA } from './schemas/operations.ts';
import { OPERATION_DESCRIPTIONS } from './schemas/operationDescriptions.ts';

// Resolved from Harper's server-helpers graph on demand. The map is built at
// Harper boot but keeps mutating as components register operations during
// `startOnMainThread` — the provider below re-reads it per request rather than
// snapshotting (#1562).
type OperationFunction = (json: object) => unknown | Promise<unknown>;
type OperationFunctionMap = Map<string, { operation_function: OperationFunction }>;

type ChooseOperation = (body: object) => OperationFunction;
type ProcessLocalTransaction = (req: { body: object }, fn: OperationFunction) => Promise<unknown>;

interface OperationsConfig {
	allow?: readonly string[];
	deny?: readonly string[];
}

// Test seams. Avoids importing Harper's heavy server-helpers graph from unit
// tests that only want to exercise the registration logic.
let _opMapOverride: OperationFunctionMap | undefined;
let _chooseOperationOverride: ChooseOperation | undefined;
let _processLocalTransactionOverride: ProcessLocalTransaction | undefined;

export function _setOperationFunctionMapForTest(m: OperationFunctionMap | undefined): void {
	_opMapOverride = m;
}
export function _setChooseOperationForTest(fn: ChooseOperation | undefined): void {
	_chooseOperationOverride = fn;
}
export function _setProcessLocalTransactionForTest(fn: ProcessLocalTransaction | undefined): void {
	_processLocalTransactionOverride = fn;
}

function loadServerUtilities():
	| {
			OPERATION_FUNCTION_MAP?: OperationFunctionMap;
			chooseOperation?: ChooseOperation;
			processLocalTransaction?: ProcessLocalTransaction;
	  }
	| undefined {
	try {
		// Lazy require: Harper's server-helpers graph initializes eagerly
		// (RocksDB lock acquisition, schema preload). Loading it from a unit
		// test that hasn't booted Harper throws; treat that as "we're not in
		// a Harper process" and let callers gracefully no-op.
		return require('../../../server/serverHelpers/serverUtilities');
	} catch (err) {
		harperLogger.trace(`MCP operations tools: serverUtilities unavailable (${(err as Error).message})`);
		return undefined;
	}
}

function getOperationFunctionMap(): OperationFunctionMap | undefined {
	if (_opMapOverride) return _opMapOverride;
	const utils = loadServerUtilities();
	return utils?.OPERATION_FUNCTION_MAP;
}

function getChooseOperation(): ChooseOperation | undefined {
	if (_chooseOperationOverride) return _chooseOperationOverride;
	return loadServerUtilities()?.chooseOperation;
}

function getProcessLocalTransaction(): ProcessLocalTransaction | undefined {
	if (_processLocalTransactionOverride) return _processLocalTransactionOverride;
	return loadServerUtilities()?.processLocalTransaction;
}

/**
 * Default v1 allow list — read-only operations only. Operators who want
 * destructive ops on the MCP surface opt in via `mcp.operations.allow`.
 */
export const DEFAULT_ALLOW: readonly string[] = [
	'describe_*',
	'list_*',
	'search_*',
	// Explicit safe getters only — see file-header rationale. `get_*` would
	// pull in `get_configuration`, `get_components`, `get_custom_function*`,
	// `get_backup`, and `get_deployment*`, all of which can leak secrets or
	// source code into the LLM context even with `verifyPerms` enforcing.
	'get_job',
	'get_status',
	'get_analytics',
	'get_metrics',
	'system_information',
	'read_log',
	'read_audit_log',
];

/**
 * Operations that carry `destructiveHint: true` when opted into the allow
 * list. The hint lets MCP clients surface a confirmation prompt before
 * calling. It is **not** an authorization check — Harper's `verifyPerms`
 * still runs at the actual dispatch site.
 */
const DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set([
	'drop_schema',
	'drop_database',
	'drop_table',
	'drop_attribute',
	'delete',
	'delete_files_before',
	'delete_records_before',
	'delete_audit_logs_before',
	'delete_transaction_logs_before',
	'drop_user',
	'drop_role',
	'restart',
	'restart_service',
	'set_configuration',
	'remove_node',
]);

/**
 * Read-only operations carry `readOnlyHint: true`. The category is wider
 * than the default allow list (some custom-allowed ops are also read-only
 * — `system_information`, for example). Any op matching one of these
 * prefixes or names is treated as read-only.
 */
const READ_ONLY_PREFIXES: readonly string[] = ['describe_', 'list_', 'search_', 'get_', 'read_'];
const READ_ONLY_NAMES: ReadonlySet<string> = new Set(['system_information', 'status']);

/**
 * Operations annotated with `idempotentHint: true`. Under MCP semantics this
 * is a STRONGER claim than "doesn't crash on retry": the second call must
 * produce the same observable outcome as the first. `add_user` is NOT
 * idempotent in this sense — the second call returns an "already exists"
 * error rather than the created user.
 *
 * Default-empty. Entries are added only after verifying the handler's
 * repeat-call behavior end-to-end. Under-annotate before mis-annotate.
 *
 * Note: read-only operations (DESCRIBE_*, LIST_*, SEARCH_*, GET_*, READ_*,
 * system_information) are covered by `readOnlyHint: true` — that's the
 * stronger and correct signal for queries.
 */
const IDEMPOTENT_OPERATIONS: ReadonlySet<string> = new Set([
	// Intentionally empty for v1. Candidates that need pre-merge verification:
	// - upsert (atomic insert-or-update; same payload should yield same state)
	// - set_configuration (state-set semantics — confirm; if it's state-merge, NOT idempotent)
]);

function isReadOnly(operationName: string): boolean {
	if (READ_ONLY_NAMES.has(operationName)) return true;
	return READ_ONLY_PREFIXES.some((p) => operationName.startsWith(p));
}

function isDestructive(operationName: string): boolean {
	return DESTRUCTIVE_OPERATIONS.has(operationName);
}

function isIdempotent(operationName: string): boolean {
	return IDEMPOTENT_OPERATIONS.has(operationName);
}

/**
 * Translates a single glob pattern (only `*` is supported) into a regex.
 * `describe_*` matches `describe_schema`, `describe_table`, etc.; literals
 * like `system_information` match exactly. No escape hatch yet — operators
 * should use literals when they need them; the glob language is delibarately
 * minimal to keep behavior predictable in audit/security reviews.
 */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`);
}

function matchesAny(operation: string, patterns: readonly string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	for (const p of patterns) {
		if (globToRegex(p).test(operation)) return true;
	}
	return false;
}

function isOperationAllowed(operation: string, config: OperationsConfig): boolean {
	const allowList = config.allow && config.allow.length > 0 ? config.allow : DEFAULT_ALLOW;
	if (!matchesAny(operation, allowList)) return false;
	if (matchesAny(operation, config.deny)) return false;
	return true;
}

function getOperationsConfig(): OperationsConfig {
	const allow = env.get(CONFIG_PARAMS.MCP_OPERATIONS_ALLOW);
	const deny = env.get(CONFIG_PARAMS.MCP_OPERATIONS_DENY);
	return {
		allow: Array.isArray(allow) ? (allow as readonly string[]) : undefined,
		deny: Array.isArray(deny) ? (deny as readonly string[]) : undefined,
	};
}

function buildDescription(operationName: string, hasCuratedSchema: boolean): string {
	const curated = OPERATION_DESCRIPTIONS[operationName];
	if (curated) return curated;
	const base = `Harper operation '${operationName}'.`;
	const schemaNote = hasCuratedSchema
		? ' Arguments validated against the curated schema below.'
		: ' Arguments forwarded as-is; the server validates and returns a structured error on rejection.';
	return base + schemaNote;
}

/**
 * Build the dispatch handler for one operation. Returns a function suitable
 * for `ToolDef.handler` that delegates to Harper's normal operation pipeline.
 *
 * Errors from `chooseOperation` (permission denied) or from the operation
 * itself surface as `isError: true` MCP results, not JSON-RPC errors —
 * matches the MCP spec's `tools/call` convention so the LLM sees and can
 * adapt to the failure.
 */
function makeOperationToolHandler(operationName: string) {
	return async function operationToolHandler(args: unknown, context: { user: AuthedUser }): Promise<ToolResult> {
		const body: Record<string, unknown> = {
			...(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}),
			operation: operationName,
			hdb_user: context.user,
		};
		try {
			const chooseOperation = getChooseOperation();
			const processLocalTransaction = getProcessLocalTransaction();
			if (!chooseOperation || !processLocalTransaction) {
				throw new Error('Harper operations runtime unavailable');
			}
			const operationFn = chooseOperation(body);
			const data = await processLocalTransaction({ body }, operationFn);
			const text = typeof data === 'string' ? data : JSON.stringify(data ?? null);
			const result: ToolResult = {
				content: [{ type: 'text', text }],
			};
			if (data !== null && typeof data === 'object') {
				result.structuredContent = data as object;
			}
			return result;
		} catch (err) {
			const e = err as { message?: string; http_resp_msg?: string; statusCode?: number };
			const message = e?.http_resp_msg ?? e?.message ?? `operation '${operationName}' failed`;
			harperLogger.trace(`MCP operations/${operationName} threw: ${(err as Error).stack ?? message}`);
			return {
				isError: true,
				content: [
					{
						type: 'text',
						text: JSON.stringify({ kind: 'harper_error', operation: operationName, message }),
					},
				],
			};
		}
	};
}

/**
 * Build the `ToolDef` for one operation. Cheap and stateless — a def is a pure
 * function of the operation name (its schema, description, annotations, RBAC
 * predicate, and handler don't depend on the allow/deny config, which only
 * decides *whether* the op is exposed, checked per request in the provider).
 * `tools/list` isn't a hot path, so the provider rebuilds defs per call rather
 * than caching (no module-level state to leak or stale-cache across tests).
 */
function buildOperationToolDef(operationName: string): ToolDef {
	const inputSchema = OPERATION_INPUT_SCHEMAS[operationName] ?? PERMISSIVE_SCHEMA;
	const annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {};
	if (isReadOnly(operationName)) annotations.readOnlyHint = true;
	if (isDestructive(operationName)) annotations.destructiveHint = true;
	if (isIdempotent(operationName)) annotations.idempotentHint = true;
	return {
		name: operationName,
		description: buildDescription(operationName, operationName in OPERATION_INPUT_SCHEMAS),
		inputSchema,
		profile: 'operations',
		...(Object.keys(annotations).length > 0 ? { annotations } : {}),
		visibleTo: (user) => canRoleInvokeOperation(user, operationName),
		handler: makeOperationToolHandler(operationName),
	};
}

/**
 * Lazy operations-profile tool provider. Consulted by the registry on every
 * `tools/list` / `tools/call`, so it reflects the live `OPERATION_FUNCTION_MAP`
 * — including operations registered by components after MCP boot (#1562).
 */
const operationsToolProvider: ProfileToolProvider = {
	list(): ToolDef[] {
		const opMap = getOperationFunctionMap();
		if (!opMap) {
			harperLogger.warn('MCP operations profile: OPERATION_FUNCTION_MAP not available; no tools listed');
			return [];
		}
		const config = getOperationsConfig();
		const defs: ToolDef[] = [];
		for (const operationName of opMap.keys()) {
			if (!isOperationAllowed(operationName, config)) continue;
			defs.push(buildOperationToolDef(operationName));
		}
		return defs;
	},
	get(operationName: string): ToolDef | undefined {
		const opMap = getOperationFunctionMap();
		if (!opMap || !opMap.has(operationName)) return undefined;
		if (!isOperationAllowed(operationName, getOperationsConfig())) return undefined;
		return buildOperationToolDef(operationName);
	},
};

/**
 * Install the operations-profile tool provider. The provider is walked lazily
 * per request rather than snapshotting the op map here, so component operations
 * registered after this runs still surface once allow-listed (#1562).
 * Idempotent — re-installing the provider is a no-op swap.
 */
export function registerOperationsTools(): void {
	setProfileToolProvider('operations', operationsToolProvider);
	harperLogger.info('MCP operations profile: lazy tool provider installed');
}
