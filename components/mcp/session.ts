/**
 * MCP session store backed by the `system.mcp_session` Harper table.
 *
 * Eviction is delegated to Harper's native TTL (`Table.setTTLExpiration`):
 * every write to a session record updates its `version`, which Harper uses
 * to determine expiration. So calling `saveSession(record)` on each request
 * gives sliding-window idle semantics for free — no custom timer, no sweep.
 *
 * Spec: when a request bears an `Mcp-Session-Id` the server doesn't
 * recognize (expired, terminated, or unknown), the server MUST return HTTP
 * 404 so the client can re-`initialize`. That decision lives in the
 * transport core; this module only reports `null` for "not found".
 */
import { v4 as uuid } from 'uuid';
import { table, type Table } from '../../resources/databases.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { clearSessionCache } from './toolRegistry.ts';

const TABLE_NAME = 'mcp_session';
const DATABASE_NAME = 'system';

/** Default idle timeout when `mcp.session.idleTimeoutSeconds` is omitted. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

/**
 * Window between expiration and physical eviction. Short, but long enough
 * to absorb clock skew and let a late client request resolve to a tombstone
 * 404 rather than a "session never existed" 404. (The client recovery path
 * is identical either way.)
 */
const EVICTION_WINDOW_SECONDS = 60;

export interface McpSessionRecord {
	id: string;
	protocolVersion: string;
	initialized: boolean;
	user: string;
	createdAt: number;
	lastActivity: number;
}

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
		expiration: idleTimeoutSeconds,
		eviction: idleTimeoutSeconds + EVICTION_WINDOW_SECONDS,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'protocolVersion' },
			{ name: 'initialized' },
			{ name: 'user' },
			{ name: 'createdAt' },
			{ name: 'lastActivity' },
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
}: {
	user: string;
	protocolVersion: string;
}): Promise<McpSessionRecord> {
	const now = Date.now();
	const record: McpSessionRecord = {
		id: uuid(),
		protocolVersion,
		initialized: false,
		user,
		createdAt: now,
		lastActivity: now,
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
	if (!record) return null;
	return record;
}

/**
 * Persist updated session state. Used to bump `lastActivity` (sliding-window
 * idle reset) and to flip `initialized` after `notifications/initialized`.
 */
export async function saveSession(record: McpSessionRecord): Promise<void> {
	await (getTable() as any).put(record);
}

export async function deleteSession(id: string): Promise<void> {
	await (getTable() as any).delete(id);
	// Tear down ancillary per-session in-memory state (e.g., the
	// `tools/list` pagination cache). Without this, every paged session
	// leaves an orphan entry in toolRegistry's sessionListCache until the
	// process restarts.
	clearSessionCache(id);
}

/**
 * Convenience: touch `lastActivity` and persist. Returns the updated
 * record so the caller doesn't re-fetch.
 */
export async function touchSession(record: McpSessionRecord): Promise<McpSessionRecord> {
	const touched: McpSessionRecord = { ...record, lastActivity: Date.now() };
	await saveSession(touched);
	return touched;
}
