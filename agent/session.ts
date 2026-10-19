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
import type { ToolCall } from '../resources/models/types.ts';
import type { AgentCallUsage, AgentMessage, AgentRunStatus, AgentSessionRow, ApprovalRequest } from './types.ts';

let cachedTable: any;

/** `listSessions` sorts on `updatedAt`, which Table.search serves only from an index. */
export const AGENT_SESSION_ATTRIBUTES = [
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
	{ name: 'rejectedCalls' },
];

export function getAgentSessionTable(): any {
	if (cachedTable) return cachedTable;
	cachedTable = table({
		table: SYSTEM_TABLE_NAMES.AGENT_SESSION_TABLE_NAME,
		database: SYSTEM_SCHEMA_NAME,
		audit: true,
		trackDeletes: false,
		attributes: AGENT_SESSION_ATTRIBUTES,
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
	// Write through the Resource-level `put` (transactional), NOT `primaryStore.put`: the transactional
	// path stages the version/local-timestamp metadata so the record is stored with the metadata prefix.
	// A raw `primaryStore.put` writes a prefix-less record, which — when it begins with classic shared-
	// structure record-id #2 (byte 0x42 == 66) — is misread by the RocksDB decode heuristic as a
	// timestamp-prefixed record (8 bytes stripped → corrupt → "Could not find typed structure"). See
	// RecordEncoder.ts:328-335.
	await getAgentSessionTable().put(row);
	return row;
}

export async function getSession(sessionId: string): Promise<AgentSessionRow | undefined> {
	return getAgentSessionTable().primaryStore.get(sessionId);
}

export async function listSessions(opts: { limit?: number } = {}): Promise<AgentSessionRow[]> {
	const limit = opts.limit ?? 100;
	const out: AgentSessionRow[] = [];
	// Sort with no conditions on purpose: Table.search pushes an order-aligned pseudo-condition when
	// the sort attribute is indexed, and throws 404 when it is not. Adding a `updatedAt > 0` sentinel
	// to force the index would make conditions non-empty, so losing `indexed` on the attribute would
	// silently degrade to decoding every session (full transcripts) and sorting in memory instead of
	// failing. The sentinel would also drop rows whose updatedAt is absent or 0.
	for await (const row of getAgentSessionTable().search({
		sort: { attribute: 'updatedAt', descending: true },
		limit,
	})) {
		if (row != null) out.push(row as AgentSessionRow);
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
		await getAgentSessionTable().put(session);
		return session;
	});
}

export function setStatus(sessionId: string, status: AgentRunStatus, lastError?: string): Promise<AgentSessionRow> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		session.status = status;
		session.lastError = lastError;
		session.updatedAt = Date.now();
		await getAgentSessionTable().put(session);
		return session;
	});
}

/**
 * Find the newest tool message larger than `maxBytes` and replace every message over `maxBytes` in
 * its run of consecutive tool messages with `shrink(content)`, which must return at most `maxBytes`.
 * Returns how many messages changed; 0 means no tool message is over `maxBytes`.
 */
export function shrinkNewestToolResults(
	sessionId: string,
	maxBytes: number,
	shrink: (content: string) => string
): Promise<number> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const { messages } = session;
		const oversized = (message: AgentMessage) =>
			message.role === 'tool' && Buffer.byteLength(message.content, 'utf8') > maxBytes;
		let index = messages.length - 1;
		while (index >= 0 && !oversized(messages[index])) index--;
		if (index < 0) return 0;
		while (index > 0 && messages[index - 1].role === 'tool') index--;
		let shrunk = 0;
		for (; index < messages.length && messages[index].role === 'tool'; index++) {
			if (!oversized(messages[index])) continue;
			messages[index] = { ...messages[index], content: shrink(messages[index].content) };
			shrunk++;
		}
		session.updatedAt = Date.now();
		await getAgentSessionTable().put(session);
		return shrunk;
	});
}

/**
 * Every status the loop writes after `running` goes through here, in one write with its closing messages
 * and any open approvals answered under the lock: a crash cannot persist an assistant's tool calls
 * without the responses a provider requires before the next call, and a cancel that landed first keeps
 * its `aborted` status.
 */
export function endRun(
	sessionId: string,
	end: {
		append?: AgentMessage[];
		answerOpenApprovals?: (approval: ApprovalRequest) => string;
		rejectedCall?: AgentCallUsage;
		/** Answers each tool call of the last assistant turn that is still without a response. */
		answerUnansweredCalls?: (toolName: string) => string;
		/** Leave the status alone when no approval is still unresolved under the lock. */
		pauseWhileApprovalsOpen?: boolean;
		status: AgentRunStatus;
		lastError?: string;
	}
): Promise<AgentSessionRow> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		if (end.append) session.messages.push(...end.append);
		if (end.rejectedCall) (session.rejectedCalls ??= []).push(end.rejectedCall);
		const now = Date.now();
		if (end.answerOpenApprovals) closeOpenApprovals(session, end.answerOpenApprovals, now);
		if (end.answerUnansweredCalls) answerUnansweredCalls(session, end.answerUnansweredCalls, now);
		const nothingToPauseFor = end.pauseWhileApprovalsOpen && !session.pendingApprovals.some((a) => !a.resolved);
		if (session.status !== 'aborted' && !nothingToPauseFor) {
			session.status = end.status;
			session.lastError = end.lastError;
		}
		session.updatedAt = now;
		await getAgentSessionTable().put(session);
		return session;
	});
}

/**
 * Cancel a session and answer every open approval in the same write, so the cancel is acknowledged only
 * once no approved action is left to run on a later prompt, and no tool call is left without a response.
 * Decided under the lock: a session a run already finished is left as it is. Returns whether it cancelled.
 */
export function cancelSession(sessionId: string): Promise<boolean> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		if (session.status === 'completed' || session.status === 'aborted' || session.status === 'error') return false;
		const now = Date.now();
		closeOpenApprovals(session, (approval) => cancelledObservation(approval.toolName), now);
		session.status = 'aborted';
		session.lastError = 'Cancelled by operator';
		session.updatedAt = now;
		await getAgentSessionTable().put(session);
		return true;
	});
}

/**
 * Inserted right after the turn's existing responses, so the transcript stays sendable even when a prompt
 * was appended after the turn. Returns whether it answered anything.
 */
function answerUnansweredCalls(session: AgentSessionRow, answer: (toolName: string) => string, now: number): boolean {
	const unanswered = unansweredCalls(session);
	if (!unanswered) return false;
	session.messages.splice(
		unanswered.at,
		0,
		...unanswered.calls.map((call) => ({
			role: 'tool' as const,
			content: answer(call.name),
			toolCallId: call.id,
			createdAt: now,
		}))
	);
	return true;
}

/** Decided on the row read under the lock, so an approval another writer already claimed is never answered twice. */
function closeOpenApprovals(
	session: AgentSessionRow,
	answer: (approval: ApprovalRequest) => string,
	now: number
): void {
	for (const approval of session.pendingApprovals) {
		if (approval.consumed) continue;
		session.messages.splice(responseIndex(session, approval.toolCallId), 0, {
			role: 'tool',
			content: answer(approval),
			toolCallId: approval.toolCallId,
			createdAt: now,
		});
		approval.approved ??= false;
		approval.resolvedAt ??= now;
		approval.resolved = true;
		approval.consumed = true;
	}
}

/**
 * Runs are serialized per session, so a tool call of the latest turn still without a response belongs to
 * a run that died before writing it: an approval claimed but never given its result, or an inline call.
 * Each is answered `interrupted`. Nothing is run again.
 */
export async function answerInterruptedCalls(sessionId: string): Promise<void> {
	const current = await getSession(sessionId);
	if (!current || !unansweredCalls(current)) return;
	await withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const now = Date.now();
		const interrupted = (toolName: string) =>
			JSON.stringify({ ok: false, error: 'interrupted', outcome: 'unknown', tool: toolName });
		if (!answerUnansweredCalls(session, interrupted, now)) return;
		session.updatedAt = now;
		await getAgentSessionTable().put(session);
	});
}

/**
 * Matched on the latest turn only, as a provider may reuse a tool-call id. A call still waiting on its
 * approval is left for the drain or `closeOpenApprovals` to answer.
 */
function unansweredCalls(session: AgentSessionRow): { calls: ToolCall[]; at: number } | undefined {
	let turn = session.messages.length - 1;
	while (turn >= 0 && session.messages[turn].role !== 'assistant') turn--;
	if (turn < 0) return undefined;
	const answered = new Set(session.messages.slice(turn + 1).map((message) => message.toolCallId));
	const awaitingApproval = new Set(session.pendingApprovals.filter((a) => !a.consumed).map((a) => a.toolCallId));
	const calls = (session.messages[turn].toolCalls ?? []).filter(
		(call) => !answered.has(call.id) && !awaitingApproval.has(call.id)
	);
	if (calls.length === 0) return undefined;
	return { calls, at: endOfResponses(session, turn) };
}

/**
 * Where a response to `toolCallId` goes: after the responses that already follow the latest turn calling
 * it, so a prompt appended after that turn stays after its responses, as a provider requires.
 */
function responseIndex(session: AgentSessionRow, toolCallId: string): number {
	let turn = session.messages.length - 1;
	while (turn >= 0 && !session.messages[turn].toolCalls?.some((call) => call.id === toolCallId)) turn--;
	return turn < 0 ? session.messages.length : endOfResponses(session, turn);
}

function endOfResponses(session: AgentSessionRow, turn: number): number {
	let at = turn + 1;
	while (at < session.messages.length && session.messages[at].role === 'tool') at++;
	return at;
}

/** An approval's result, which a prompt appended while it waited must not precede. */
export function answerToolCall(sessionId: string, toolCallId: string, content: string): Promise<AgentSessionRow> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const now = Date.now();
		session.messages.splice(responseIndex(session, toolCallId), 0, {
			role: 'tool',
			content,
			toolCallId,
			createdAt: now,
		});
		session.updatedAt = now;
		await getAgentSessionTable().put(session);
		return session;
	});
}

/**
 * Park a gated tool call for the operator. On a session a cancel already marked `aborted`, the call is
 * answered `cancelled_by_operator` instead, so the cancel is not undone and the call is not left open.
 */
export function addPendingApproval(
	sessionId: string,
	approval: Omit<ApprovalRequest, 'id' | 'createdAt'>
): Promise<ApprovalRequest | undefined> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const now = Date.now();
		let entry: ApprovalRequest | undefined;
		if (session.status === 'aborted') {
			session.messages.push({
				role: 'tool',
				content: cancelledObservation(approval.toolName),
				toolCallId: approval.toolCallId,
				createdAt: now,
			});
		} else {
			entry = { ...approval, id: randomUUID(), createdAt: now };
			session.pendingApprovals.push(entry);
			session.status = 'awaiting_approval';
		}
		session.updatedAt = now;
		await getAgentSessionTable().put(session);
		return entry;
	});
}

export function cancelledObservation(toolName: string): string {
	return JSON.stringify({ ok: false, error: 'cancelled_by_operator', tool: toolName });
}

/**
 * Claim a resolved approval before its action runs; only the first claim wins. A cancel or budget stop
 * therefore closes only approvals whose action has not started, and no tool call gets two responses.
 * The cost is at-most-once: a crash between the claim and the result write leaves that call unanswered
 * rather than running an operator-approved action twice.
 */
export function claimApproval(sessionId: string, approvalId: string): Promise<boolean> {
	return withSessionLock(sessionId, async () => {
		const session = await requireSession(sessionId);
		const entry = session.pendingApprovals.find((a) => a.id === approvalId);
		if (!entry?.resolved || entry.consumed) return false;
		entry.consumed = true;
		session.updatedAt = Date.now();
		await getAgentSessionTable().put(session);
		return true;
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
		await getAgentSessionTable().put(session);
		return entry;
	});
}

async function requireSession(sessionId: string): Promise<AgentSessionRow> {
	const session = await getSession(sessionId);
	if (!session) throw new Error(`No agent session ${sessionId}`);
	// The store returns a frozen record, so the read-modify-write mutators below (status, messages,
	// approvals) would throw "Cannot assign to read only property" if they mutated it in place.
	// Return a mutable deep copy; the mutator writes it back with `put`.
	return structuredClone(session);
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
