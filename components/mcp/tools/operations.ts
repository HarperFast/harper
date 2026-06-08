/**
 * Operations-profile tool generation. Walks Harper's `OPERATION_FUNCTION_MAP`
 * and registers one MCP tool per operation that survives the
 * `mcp.operations.allow` / `deny` filter.
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
import { addTool, canRoleInvokeOperation, type AuthedUser, type ToolResult } from '../toolRegistry.ts';
import { OPERATION_INPUT_SCHEMAS, PERMISSIVE_SCHEMA } from './schemas/operations.ts';

// Eager-resolved at module load. The map is built at Harper boot and
// doesn't mutate, so caching here is safe.
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

function isReadOnly(operationName: string): boolean {
	if (READ_ONLY_NAMES.has(operationName)) return true;
	return READ_ONLY_PREFIXES.some((p) => operationName.startsWith(p));
}

function isDestructive(operationName: string): boolean {
	return DESTRUCTIVE_OPERATIONS.has(operationName);
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
 * Idempotent registration: walk the op map, register every operation that
 * passes the allow/deny filter. Safe to invoke multiple times — `addTool`
 * is `Map.set`-backed.
 */
export function registerOperationsTools(): void {
	const opMap = getOperationFunctionMap();
	if (!opMap) {
		harperLogger.warn('MCP operations profile: OPERATION_FUNCTION_MAP not available; no tools registered');
		return;
	}
	const config = getOperationsConfig();
	let registered = 0;
	for (const operationName of opMap.keys()) {
		if (!isOperationAllowed(operationName, config)) continue;
		const inputSchema = OPERATION_INPUT_SCHEMAS[operationName] ?? PERMISSIVE_SCHEMA;
		const annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
		if (isReadOnly(operationName)) annotations.readOnlyHint = true;
		if (isDestructive(operationName)) annotations.destructiveHint = true;
		addTool({
			name: operationName,
			description: buildDescription(operationName, operationName in OPERATION_INPUT_SCHEMAS),
			inputSchema,
			profile: 'operations',
			...(Object.keys(annotations).length > 0 ? { annotations } : {}),
			visibleTo: (user) => canRoleInvokeOperation(user, operationName),
			handler: makeOperationToolHandler(operationName),
		});
		registered++;
	}
	harperLogger.info(`MCP operations profile: registered ${registered} tool(s)`);
}
