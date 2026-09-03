/**
 * MCP session store backed by the `system.mcp_session` Harper table.
 *
 * Eviction is delegated to Harper's native TTL (`Table.setTTLExpiration`).
 * Active-session writes use the table default for sliding-window idle expiry.
 *
 * Spec: when a request bears an `Mcp-Session-Id` the server doesn't
 * recognize (expired, terminated, or unknown), the server MUST return HTTP
 * 404 so the client can re-`initialize`. That decision lives in the
 * transport core; this module only reports `null` for "not found".
 */
import { v4 as uuid } from 'uuid';
import { table, type Table } from '../../resources/databases.ts';
import { patchIfExists } from '../../resources/Table.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import type { McpLogLevel } from './logging.ts';
import { clearSessionRateState } from './rateLimit.ts';
import { unregisterSession } from './sessionRegistry.ts';
import { clearSessionCache } from './toolRegistry.ts';

const TABLE_NAME = 'mcp_session';
const DATABASE_NAME = 'system';

/** Default idle timeout when `mcp.session.idleTimeoutSeconds` is omitted. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

/**
 * Window between expiration and physical eviction. Short, but long enough
 * to absorb clock skew before the expired row is physically removed.
 */
const EVICTION_WINDOW_SECONDS = 60;
export interface McpSessionRecord {
	id: string;
	protocolVersion: string;
	initialized: boolean;
	user: string;
	createdAt: number;
	lastActivity: number;
	/**
	 * Minimum `notifications/message` severity set via `logging/setLevel`.
	 * Persisted here (not just on the in-memory SSE record) so it survives an
	 * SSE reconnect and is order-independent of GET-stream open; the live
	 * RegisteredSession is seeded from it. Expires with the session's TTL, so no
	 * separate cache to prune. Undefined = the client hasn't opted into logging.
	 */
	logLevel?: McpLogLevel;
	/**
	 * Resource URIs the client has subscribed to via `resources/subscribe`
	 * (#1349 §3.6). Persisted so they can be restored on an SSE reconnect (the
	 * live per-worker subscription objects can't be). Row-backed URIs only;
	 * undefined/empty = no subscriptions.
	 */
	subscriptions?: string[];
	/**
	 * Client capabilities from `initialize` `params.capabilities` (#1349 §3.7).
	 * Stored so server→client requests (sampling/elicitation/roots) are only sent
	 * to clients that declared support. Undefined = client declared none.
	 */
	clientCapabilities?: Record<string, unknown>;
}

type McpSessionUpdate = Partial<Pick<McpSessionRecord, 'initialized' | 'lastActivity' | 'logLevel' | 'subscriptions'>>;

let _sessionTable: Table | undefined;

/**
 * Lazily declare the system table. Called by `ensureSessionTable()` at
 * component-init. Declaring lazily lets unit tests that don't boot a real
 * Harper instance skip the table entirely.
 */
function declareSessionTable(): Table {
	const idleTimeoutSeconds =
		(env.get(CONFIG_PARAMS.MCP_SESSION_IDLETIMEOUTSECONDS) as number | undefined) ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
	return table<Table>({
		table: TABLE_NAME,
		database: DATABASE_NAME,
		replicate: false,
		expiration: idleTimeoutSeconds,
		eviction: idleTimeoutSeconds + EVICTION_WINDOW_SECONDS,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'protocolVersion' },
			{ name: 'initialized' },
			{ name: 'user' },
			{ name: 'createdAt' },
			{ name: 'lastActivity' },
			{ name: 'logLevel' },
			{ name: 'subscriptions' },
			{ name: 'clientCapabilities' },
		],
	});
}

/**
 * Initialize the session table. Called from `handleApplication(scope)` and
 * `registerMcpProfile()` when the MCP component boots. Idempotent.
 */
export function ensureSessionTable(): Table {
	if (!_sessionTable) {
		_sessionTable = declareSessionTable();
		if (_sessionTable.replicate !== false) {
			harperLogger.warn(`Correcting MCP session table system.${TABLE_NAME} to disable replication`);
			_sessionTable.replicate = false;
		}
		if (_sessionTable.source) harperLogger.fatal(`MCP session table system.${TABLE_NAME} must not be source-backed`);
		harperLogger.trace(`MCP session table system.${TABLE_NAME} initialized`);
	}
	return _sessionTable;
}

/** Test seam: allow tests to inject a fake table without touching Harper. */
export function _setSessionTableForTest(fake: Table | undefined): void {
	_sessionTable = fake;
}

function getTable(): Table {
	if (!_sessionTable) throw new Error('MCP session table not initialized');
	return _sessionTable;
}

export async function createSession({
	user,
	protocolVersion,
	clientCapabilities,
}: {
	user: string;
	protocolVersion: string;
	clientCapabilities?: Record<string, unknown>;
}): Promise<McpSessionRecord> {
	const now = Date.now();
	const record: McpSessionRecord = {
		id: uuid(),
		protocolVersion,
		initialized: false,
		user,
		createdAt: now,
		lastActivity: now,
		...(clientCapabilities ? { clientCapabilities } : {}),
	};
	await (getTable() as any).put(record);
	return record;
}

/**
 * Look up a session by id. Returns the record if present and not expired,
 * else `null`. The transport core maps `null` to HTTP 404.
 */
export async function loadSession(id: string): Promise<McpSessionRecord | null> {
	const record = (await (getTable() as any).get(id)) as McpSessionRecord | undefined | null;
	if (!record || typeof record.createdAt !== 'number' || typeof record.protocolVersion !== 'string') return null;
	return record;
}

export async function saveSession(id: string, changes: McpSessionUpdate): Promise<void> {
	await patchIfExists(getTable(), id, changes);
}

export async function deleteSession(id: string): Promise<void> {
	const SessionTable = getTable() as any;
	do {
		await SessionTable.delete(id);
	} while (await SessionTable.get(id));
	// Tear down ancillary per-session in-memory state — the `tools/list`
	// pagination cache and the per-session rate-limit buckets. Without
	// these, every session that ever paged or called a tool leaves orphan
	// entries until the process restarts.
	clearSessionCache(id);
	clearSessionRateState(id);
	unregisterSession(id);
}

/**
 * Convenience: touch `lastActivity` and persist. Returns the updated
 * record so the caller doesn't re-fetch.
 */
export async function touchSession(record: McpSessionRecord): Promise<McpSessionRecord> {
	const touched: McpSessionRecord = { ...record, lastActivity: Date.now() };
	await saveSession(record.id, { lastActivity: touched.lastActivity });
	return touched;
}
