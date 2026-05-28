/**
 * Built-in agent session storage. Backed by `system.hdb_agent_session` so
 * transcripts and pending approvals survive restarts. The exported helpers
 * are async to keep the surface uniform — once the underlying store gains
 * non-blocking paths the call sites won't have to change.
 *
 * Intentionally separate from #511's `ConversationResource`: that primitive
 * is app-facing (per-tenant, multi-user, user-defined schema) while this
 * table is server-local and operator-owned.
 */

import { randomUUID } from 'node:crypto';
import { table } from '../resources/databases.ts';
import { SYSTEM_SCHEMA_NAME, SYSTEM_TABLE_NAMES } from '../utility/hdbTerms.ts';
import type { AgentMessage, AgentRunStatus, AgentSessionRow, ApprovalRequest } from './types.ts';

let cachedTable: any;

export function getAgentSessionTable(): any {
	if (cachedTable) return cachedTable;
	cachedTable = table({
		table: SYSTEM_TABLE_NAMES.AGENT_SESSION_TABLE_NAME,
		database: SYSTEM_SCHEMA_NAME,
		audit: true,
		trackDeletes: false,
		attributes: [
			{ name: 'session_id', isPrimaryKey: true },
			{ name: 'user', type: 'string', indexed: true },
			{ name: 'status', type: 'string', indexed: true },
			{ name: 'messages' },
			{ name: 'pendingApprovals' },
			{ name: 'model', type: 'string' },
			{ name: 'provider', type: 'string' },
			{ name: 'createdAt', type: 'number', indexed: true },
			{ name: 'updatedAt', type: 'number', indexed: true },
			{ name: 'lastError', type: 'string' },
		],
	});
	return cachedTable;
}

export interface CreateSessionOpts {
	sessionId?: string;
	user: string;
	model?: string;
	provider?: string;
	initialMessage?: AgentMessage;
}

export async function createSession(opts: CreateSessionOpts): Promise<AgentSessionRow> {
	const now = Date.now();
	const row: AgentSessionRow = {
		session_id: opts.sessionId ?? randomUUID(),
		user: opts.user,
		status: 'idle',
		messages: opts.initialMessage ? [opts.initialMessage] : [],
		pendingApprovals: [],
		model: opts.model,
		provider: opts.provider,
		createdAt: now,
		updatedAt: now,
	};
	await getAgentSessionTable().primaryStore.put(row.session_id, row);
	return row;
}

export async function getSession(sessionId: string): Promise<AgentSessionRow | undefined> {
	return getAgentSessionTable().primaryStore.get(sessionId);
}

export async function listSessions(opts: { limit?: number } = {}): Promise<AgentSessionRow[]> {
	const limit = opts.limit ?? 100;
	const out: AgentSessionRow[] = [];
	for (const entry of getAgentSessionTable().primaryStore.getRange({ reverse: true, limit })) {
		if (entry.value) out.push(entry.value as AgentSessionRow);
	}
	return out;
}

/**
 * Per-session mutation lock. Each row mutation is a read-modify-write against the table; without
 * serialization, two concurrent mutations on the same session (e.g. the loop appending an assistant
 * message while the operator resolves an approval) both read the same row and the second `put`
 * clobbers the first — a lost update. This chains all mutations for a given session id so they
 * apply sequentially. Reads (`getSession`/`listSessions`) intentionally don't take the lock.
 */
const sessionLocks = new Map<string, Promise<unknown>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
	const prev = (sessionLocks.get(sessionId) ?? Promise.resolve()).catch(() => {});
	const result = prev.then(() => fn());
	const tail = result.catch(() => {});
	sessionLocks.set(sessionId, tail);
	void tail.then(() => {
		if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
	});
	return result;
}

export function appendMessage(sessionId: string, message: AgentMessage): Promise<AgentSessionRow> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		session.messages.push(message);
		session.updatedAt = Date.now();
		await getAgentSessionTable().primaryStore.put(sessionId, session);
		return session;
	});
}

export function setStatus(sessionId: string, status: AgentRunStatus, lastError?: string): Promise<AgentSessionRow> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		session.status = status;
		session.lastError = lastError;
		session.updatedAt = Date.now();
		await getAgentSessionTable().primaryStore.put(sessionId, session);
		return session;
	});
}

export function addPendingApproval(
	sessionId: string,
	approval: Omit<ApprovalRequest, 'id' | 'createdAt'>
): Promise<ApprovalRequest> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const entry: ApprovalRequest = { ...approval, id: randomUUID(), createdAt: Date.now() };
		session.pendingApprovals.push(entry);
		session.status = 'awaiting_approval';
		session.updatedAt = Date.now();
		await getAgentSessionTable().primaryStore.put(sessionId, session);
		return entry;
	});
}

export function markApprovalConsumed(sessionId: string, approvalId: string): Promise<void> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const entry = session.pendingApprovals.find((a) => a.id === approvalId);
		if (!entry) throw new Error(`No pending approval ${approvalId} on session ${sessionId}`);
		if (!entry.resolved) throw new Error(`Approval ${approvalId} not yet resolved`);
		if (entry.consumed) return;
		entry.consumed = true;
		session.updatedAt = Date.now();
		await getAgentSessionTable().primaryStore.put(sessionId, session);
	});
}

export function resolveApproval(sessionId: string, approvalId: string, approved: boolean): Promise<ApprovalRequest> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const entry = session.pendingApprovals.find((a) => a.id === approvalId);
		if (!entry) throw new Error(`No pending approval ${approvalId} on session ${sessionId}`);
		if (entry.resolved) throw new Error(`Approval ${approvalId} already resolved`);
		entry.resolved = true;
		entry.approved = approved;
		entry.resolvedAt = Date.now();
		// Either decision (approve or deny) returns the session to a resumable `idle` state so the
		// loop can run again and deliver the resulting observation to the model. Operators who want
		// to terminate the whole run should use `cancel_agent_run` instead of denying.
		if (!session.pendingApprovals.some((a) => !a.resolved)) {
			session.status = 'idle';
		}
		session.updatedAt = Date.now();
		await getAgentSessionTable().primaryStore.put(sessionId, session);
		return entry;
	});
}

async function requireSession(sessionId: string): Promise<AgentSessionRow> {
	const session = await getSession(sessionId);
	if (!session) throw new Error(`No agent session ${sessionId}`);
	return session;
}

/**
 * Reset the cached table reference. Test-only seam; production code lets the
 * lazy-getter initialize once per process.
 */
export function _resetForTests(): void {
	cachedTable = undefined;
}

/** Inject a mock table accessor for unit tests. Pass `undefined` to restore the lazy default. */
export function _setTableForTests(mock: any): void {
	cachedTable = mock;
}
