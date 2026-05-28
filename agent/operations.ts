/**
 * Operations API surface for the built-in agent (#626).
 *
 * Six handlers, all super_user-only — the auth check is inline because none
 * of these ops are registered in `utility/operation_authorization.ts`'s
 * `requiredPermissions` map. Without the inline gate, a non-SU request would
 * fall through the standard flow and be allowed.
 */

import type { OperationDefinition } from '../server/serverHelpers/serverUtilities.ts';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { createSession, getSession, listSessions, appendMessage, resolveApproval, setStatus } from './session.ts';
import type { AgentConfig, AgentMessage, AgentRunStatus } from './types.ts';

export interface OperationDeps {
	getConfig: () => AgentConfig;
	setConfig: (patch: Partial<AgentConfig>) => AgentConfig;
	startRun: (sessionId: string) => void;
	cancelRun: (sessionId: string) => boolean;
}

export function buildOperations(deps: OperationDeps): OperationDefinition[] {
	return [
		{
			name: OPERATIONS_ENUM.AGENT_PROMPT,
			execute: async (op) => agentPrompt(op, deps),
		},
		{
			name: OPERATIONS_ENUM.GET_AGENT_SESSION,
			execute: async (op) => getAgentSession(op),
		},
		{
			name: OPERATIONS_ENUM.LIST_AGENT_SESSIONS,
			execute: async (op) => listAgentSessions(op),
		},
		{
			name: OPERATIONS_ENUM.CANCEL_AGENT_RUN,
			execute: async (op) => cancelAgentRun(op, deps),
		},
		{
			name: OPERATIONS_ENUM.APPROVE_AGENT_ACTION,
			execute: async (op) => approveAgentAction(op, deps),
		},
		{
			name: OPERATIONS_ENUM.SET_AGENT_CONFIG,
			execute: async (op) => setAgentConfig(op, deps),
		},
	];
}

function requireSuperUser(op: any): void {
	if (!op?.hdb_user?.role?.permission?.super_user) {
		throw new ClientError('Agent operations require super_user', 403);
	}
}

async function agentPrompt(op: any, deps: OperationDeps) {
	requireSuperUser(op);
	const config = deps.getConfig();
	if (!config.enabled) {
		throw new ClientError('Agent component is disabled (agent.enabled=false)', 409);
	}
	const message = String(op?.message ?? '').trim();
	if (!message) throw new ClientError('message is required', 400);

	let sessionId: string = op?.session_id;
	if (sessionId) {
		const existing = await getSession(sessionId);
		if (!existing) throw new ClientError(`Unknown session ${sessionId}`, 404);
		if (existing.status === 'running' || existing.status === 'awaiting_approval') {
			throw new ClientError(
				`Session ${sessionId} is ${existing.status}; resolve or cancel before sending another prompt`,
				409
			);
		}
		await appendMessage(sessionId, asUserMessage(message));
	} else {
		const created = await createSession({
			user: op?.hdb_user?.username ?? config.user,
			model: config.model,
			provider: config.provider,
			initialMessage: asUserMessage(message),
		});
		sessionId = created.session_id;
	}

	deps.startRun(sessionId);
	return { session_id: sessionId, status: 'running' satisfies AgentRunStatus };
}

async function getAgentSession(op: any) {
	requireSuperUser(op);
	const sessionId = String(op?.session_id ?? '');
	if (!sessionId) throw new ClientError('session_id is required', 400);
	const session = await getSession(sessionId);
	if (!session) throw new ClientError(`Unknown session ${sessionId}`, 404);
	return session;
}

async function listAgentSessions(op: any) {
	requireSuperUser(op);
	const limit = Number.isFinite(op?.limit) ? Number(op.limit) : undefined;
	return { sessions: await listSessions({ limit }) };
}

async function cancelAgentRun(op: any, deps: OperationDeps) {
	requireSuperUser(op);
	const sessionId = String(op?.session_id ?? '');
	if (!sessionId) throw new ClientError('session_id is required', 400);
	const session = await getSession(sessionId);
	if (!session) throw new ClientError(`Unknown session ${sessionId}`, 404);
	// Abort any active controller (best-effort — there may not be one if the loop is paused
	// in `awaiting_approval` or sitting `idle` between turns). Always update the persisted
	// status so a paused session can still be terminated by the operator.
	const signalledLiveRun = deps.cancelRun(sessionId);
	const wasTerminal = session.status === 'completed' || session.status === 'aborted' || session.status === 'error';
	if (!wasTerminal) await setStatus(sessionId, 'aborted', 'Cancelled by operator');
	return { cancelled: !wasTerminal, signalledLiveRun };
}

async function approveAgentAction(op: any, deps: OperationDeps) {
	requireSuperUser(op);
	const sessionId = String(op?.session_id ?? '');
	const approvalId = String(op?.approval_id ?? '');
	if (!sessionId || !approvalId) {
		throw new ClientError('session_id and approval_id are required', 400);
	}
	const approved = op?.approved !== false;
	const resolved = await resolveApproval(sessionId, approvalId, approved);
	// Either decision should resume the loop: an approval means execute the saved tool call;
	// a denial means hand the operator-rejection observation back to the model so it can adjust.
	deps.startRun(sessionId);
	return resolved;
}

async function setAgentConfig(op: any, deps: OperationDeps) {
	requireSuperUser(op);
	const patch: Partial<AgentConfig> = {};
	for (const key of ['enabled', 'provider', 'model', 'maxTurns', 'maxCostUsd', 'autoApprove', 'allowDestructive']) {
		if (op?.[key] !== undefined) (patch as any)[key] = op[key];
	}
	return deps.setConfig(patch);
}

function asUserMessage(content: string): AgentMessage {
	return { role: 'user', content, createdAt: Date.now() };
}
