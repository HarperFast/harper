/**
 * Manual agent loop for the built-in agent (#626).
 *
 * Wraps `scope.models.generate({ ..., toolMode: 'return' })` and dispatches
 * any tool calls the model returns. This is a temporary stand-in for the
 * unified `toolMode: 'auto'` orchestrator landing in #612 — when that ships,
 * tool-call dispatch and the per-turn loop collapse into a single
 * `generate({ ..., toolMode: 'auto' })` call. The approval/abort gates here
 * still live in the component (the orchestrator won't know about
 * `destructive` or operator approval semantics).
 *
 * Per-session serialization (one concurrent run per session) is handled
 * here via {@link runAgent}'s in-flight map. Multiple sessions interleave
 * on the event loop naturally because each turn is mostly awaiting the LLM
 * or a tool's I/O.
 */

import type { GenerateOpts, GenerateResult, Message, Models, ToolCall, ToolDef } from '../resources/models/types.ts';
import { addPendingApproval, appendMessage, endRun, getSession, markApprovalConsumed, setStatus } from './session.ts';
import type { AgentMessage, AgentScopes, AgentTool, AgentToolContext, ApprovalRequest } from './types.ts';
import { toolMapByName } from './toolset.ts';
import { budgetViolation, callUsage, hasBudget, summarizeSessionUsage } from './budget.ts';

export interface RunAgentOpts {
	sessionId: string;
	models: Pick<Models, 'generate'>;
	tools: AgentTool[];
	scopes: AgentScopes;
	maxTurns: number;
	/** Per-session caps, measured from the transcript, so an approval resume or a new prompt cannot reset them. */
	maxSessionTokens?: number;
	maxCostUsd?: number;
	/** When false, destructive tools pause the loop with a pending approval instead of executing. */
	autoApprove?: boolean;
	signal?: AbortSignal;
	generateOpts?: Omit<GenerateOpts, 'toolMode' | 'signal'>;
	/** System prompt injected as the first turn when the transcript is empty. */
	systemPrompt?: string;
}

const inFlight = new Map<string, Promise<void>>();

export function runAgent(opts: RunAgentOpts): Promise<void> {
	const existing = inFlight.get(opts.sessionId);
	if (existing) return existing;
	const run = doRun(opts).finally(() => {
		if (inFlight.get(opts.sessionId) === run) inFlight.delete(opts.sessionId);
	});
	inFlight.set(opts.sessionId, run);
	return run;
}

async function doRun(opts: RunAgentOpts): Promise<void> {
	const toolMap = toolMapByName(opts.tools);
	const toolDefs: ToolDef[] = opts.tools.map((t) => t.def);
	await setStatus(opts.sessionId, 'running');
	const ctx: AgentToolContext = { sessionId: opts.sessionId, signal: opts.signal, scopes: opts.scopes };

	try {
		// Before the approvals below can execute anything: a cap lowered while a run sat awaiting
		// approval must stop the approved action, not just the next model call.
		if (await stopIfOverBudget(opts)) return;
		// A cancel that landed while the session was read must not let an approved action run; the cancel
		// itself has closed the approvals (`cancelSession`).
		if (opts.signal?.aborted) return;

		// First, drain any resolved-but-unconsumed approvals from a prior pause. Either execute
		// or refuse each saved call, recording an observation, so the next model turn sees the
		// result of the operator decision.
		await consumeResolvedApprovals(opts.sessionId, toolMap, ctx);

		// If a turn produced multiple gated tool calls and the operator has only resolved some of
		// them, the remaining approvals are still pending — meaning the assistant's tool_calls do
		// not yet all have tool responses. Re-entering the generate loop now would send an
		// incomplete tool-response set and the provider would 400. Stay paused until every gated
		// call for this turn is resolved (each `approve_agent_action` re-runs this path).
		const afterConsume = await getSession(opts.sessionId);
		if (afterConsume?.pendingApprovals.some((a) => !a.resolved)) {
			await setStatus(opts.sessionId, 'awaiting_approval');
			return;
		}

		for (let turn = 0; turn < opts.maxTurns; turn++) {
			if (opts.signal?.aborted) return; // status was already set to `aborted` by cancelRun
			const session = await getSession(opts.sessionId);
			if (!session) throw new Error(`Session ${opts.sessionId} vanished mid-run`);
			const messages = toModelMessages(session.messages, opts.systemPrompt);
			const result: GenerateResult = await opts.models.generate(
				{ messages, tools: toolDefs, system: opts.systemPrompt },
				{ ...opts.generateOpts, toolMode: 'return', signal: opts.signal }
			);

			const assistantMessage: AgentMessage = {
				role: 'assistant',
				content: result.content ?? '',
				toolCalls: result.toolCalls,
				createdAt: Date.now(),
			};
			const usage = callUsage(result.usage, result.costUsd);
			if (usage) assistantMessage.usage = usage;

			const violation = hasBudget(opts)
				? budgetViolation(summarizeSessionUsage([...session.messages, assistantMessage]), opts)
				: undefined;
			if (violation) {
				const refusals = (result.toolCalls ?? []).map((call) => budgetRefusal(call.id, violation));
				await endRun(opts.sessionId, {
					append: [assistantMessage, ...refusals],
					status: refusals.length > 0 ? 'error' : 'completed',
					lastError: violation,
				});
				return;
			}

			await appendMessage(opts.sessionId, assistantMessage);

			if (!result.toolCalls || result.toolCalls.length === 0) {
				await setStatus(opts.sessionId, 'completed');
				return;
			}

			const paused = await dispatchToolCalls(result.toolCalls, toolMap, ctx, opts);
			if (paused || opts.signal?.aborted) return;
		}
		await setStatus(opts.sessionId, 'completed', `Reached maxTurns=${opts.maxTurns} without a final answer.`);
	} catch (err) {
		// If the abort signal fired, the cancel path already set the session to `aborted` —
		// don't clobber that with `error`. The rejection here is just the awaited generate/tool
		// honoring the signal, not a real failure.
		if (opts.signal?.aborted) return;
		await setStatus(opts.sessionId, 'error', err instanceof Error ? err.message : String(err));
		throw err;
	}
}

/**
 * Every open approval, resolved or not, is answered without executing it, so no tool call is left
 * without a response once the session leaves `awaiting_approval`.
 */
async function stopIfOverBudget(opts: RunAgentOpts): Promise<boolean> {
	if (!hasBudget(opts)) return false;
	const session = await getSession(opts.sessionId);
	if (!session) return false;
	const violation = budgetViolation(summarizeSessionUsage(session.messages), opts);
	if (!violation) return false;
	const open = session.pendingApprovals.filter((approval) => !approval.consumed);
	await endRun(opts.sessionId, {
		append: open.map((approval) => approvalRefusal(approval, violation)),
		closeApprovals: open.map((approval) => approval.id),
		status: 'error',
		lastError: violation,
	});
	return true;
}

function budgetRefusal(toolCallId: string, reason: string): AgentMessage {
	return {
		role: 'tool',
		content: JSON.stringify({ ok: false, error: 'budget_exceeded', reason }),
		toolCallId,
		createdAt: Date.now(),
	};
}

function approvalRefusal(approval: ApprovalRequest, reason: string): AgentMessage {
	if (!approval.resolved || approval.approved) return budgetRefusal(approval.toolCallId, reason);
	return { role: 'tool', content: deniedObservation(approval), toolCallId: approval.toolCallId, createdAt: Date.now() };
}

function deniedObservation(approval: ApprovalRequest): string {
	return JSON.stringify({ ok: false, error: 'denied_by_operator', tool: approval.toolName });
}

/**
 * Returns `true` when the loop should pause (any destructive tool call required approval).
 * Non-destructive calls execute inline and their observations are appended. Destructive calls
 * register pending approvals but do NOT append a tool message — `consumeResolvedApprovals`
 * writes the single tool response on the next run. This keeps the 1:1 mapping between
 * assistant tool_calls and tool responses that LLM APIs enforce, including when the assistant
 * message mixes destructive and non-destructive calls in the same turn.
 */
async function dispatchToolCalls(
	calls: ToolCall[],
	toolMap: Map<string, AgentTool>,
	ctx: AgentToolContext,
	opts: RunAgentOpts
): Promise<boolean> {
	let needsApproval = false;
	for (const call of calls) {
		if (opts.signal?.aborted) return true;
		const tool = toolMap.get(call.name);
		const destructiveAndGated = tool?.destructive && !opts.autoApprove;
		if (destructiveAndGated) {
			await addPendingApproval(opts.sessionId, {
				toolName: call.name,
				arguments: call.arguments ?? {},
				toolCallId: call.id,
				reason: 'destructive',
			});
			needsApproval = true;
			// Don't break — keep processing remaining calls so non-destructive ones in the same
			// turn still execute and write their tool responses. Their results may be useful
			// context for the operator deciding whether to approve.
			continue;
		}
		const observation = await invokeTool(call, toolMap, ctx);
		await appendMessage(opts.sessionId, {
			role: 'tool',
			content: observation,
			toolCallId: call.id,
			createdAt: Date.now(),
		});
	}
	return needsApproval;
}

async function consumeResolvedApprovals(
	sessionId: string,
	toolMap: Map<string, AgentTool>,
	ctx: AgentToolContext
): Promise<void> {
	const session = await getSession(sessionId);
	if (!session) return;
	const toConsume = session.pendingApprovals.filter((a) => a.resolved && !a.consumed);
	for (const approval of toConsume) {
		const observation = approval.approved
			? await invokeTool(
					{ id: approval.toolCallId, name: approval.toolName, arguments: approval.arguments },
					toolMap,
					ctx
				)
			: deniedObservation(approval);
		await appendMessage(sessionId, {
			role: 'tool',
			content: observation,
			toolCallId: approval.toolCallId,
			createdAt: Date.now(),
		});
		await markApprovalConsumed(sessionId, approval.id);
	}
}

async function invokeTool(call: ToolCall, toolMap: Map<string, AgentTool>, ctx: AgentToolContext): Promise<string> {
	const tool = toolMap.get(call.name);
	if (!tool) return JSON.stringify({ error: 'unknown_tool', name: call.name });
	try {
		const result = await tool.handler(call.arguments ?? {}, ctx);
		return JSON.stringify({ ok: true, result });
	} catch (err) {
		return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}
}

function toModelMessages(items: AgentMessage[], systemPrompt: string | undefined): Message[] {
	const out: Message[] = [];
	if (systemPrompt && !items.some((m) => m.role === 'system')) {
		out.push({ role: 'system', content: systemPrompt });
	}
	for (const item of items) {
		const message: Message = { role: item.role, content: item.content };
		if (item.toolCalls) message.toolCalls = item.toolCalls;
		if (item.toolCallId) message.toolCallId = item.toolCallId;
		out.push(message);
	}
	return out;
}

/** Test-only: clear the in-flight tracking map. */
export function _resetInFlightForTests(): void {
	inFlight.clear();
}
