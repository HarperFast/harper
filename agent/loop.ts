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
import { errorInfo, serializeToolResult, truncateWithMarker } from '../resources/models/agentLoop.ts';
import { isContextWindowExceeded } from '../resources/models/backendHelpers.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import {
	addPendingApproval,
	appendMessage,
	cancelledObservation,
	claimApproval,
	endRun,
	getSession,
	setStatus,
	shrinkNewestToolResults,
} from './session.ts';
import type { AgentMessage, AgentScopes, AgentTool, AgentToolContext, ApprovalRequest } from './types.ts';
import { toolMapByName } from './toolset.ts';
import { budgetViolation, callUsage, hasBudget, summarizeSessionUsage } from './budget.ts';

const log = harperLogger.loggerWithTag('agent');

/** The `toolMode: 'auto'` orchestrator's default `toolResultMaxBytes`. */
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 65_536;
// Below the minimum the truncation marker leaves almost no room for the result; above the maximum
// (~250k tokens) the cap no longer keeps one result inside any model's context window.
export const MIN_MAX_TOOL_RESULT_BYTES = 1024;
export const MAX_MAX_TOOL_RESULT_BYTES = 1_048_576;

export function isValidMaxToolResultBytes(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= MIN_MAX_TOOL_RESULT_BYTES &&
		(value as number) <= MAX_MAX_TOOL_RESULT_BYTES
	);
}

const CONTEXT_SHRINK_BYTES = 2048;
const ASK_FOR_LESS =
	'Ask for less: read_file with startLine/lineCount, tail_file with fewer lines, grep_files with a narrower pattern, or a narrower query';

export interface RunAgentOpts {
	sessionId: string;
	models: Pick<Models, 'generate'>;
	tools: AgentTool[];
	scopes: AgentScopes;
	maxTurns: number;
	/** Per-session caps, measured from the transcript, so an approval resume or a new prompt cannot reset them. */
	maxSessionTokens?: number;
	maxCostUsd?: number;
	/** From `admitRun` when the request that starts this run was admitted; a cancel since then fences it out. */
	admitted?: number;
	/** When false, destructive tools pause the loop with a pending approval instead of executing. */
	autoApprove?: boolean;
	signal?: AbortSignal;
	generateOpts?: Omit<GenerateOpts, 'toolMode' | 'signal'>;
	/** Sent as `system` with every request; never stored in the transcript. */
	systemPrompt?: string;
	/** Cap on each tool result appended to the transcript. Default {@link DEFAULT_MAX_TOOL_RESULT_BYTES}. */
	maxToolResultBytes?: number;
}

const inFlight = new Map<string, Promise<void>>();
const cancels = new Map<string, number>();

/** A token for a run admitted now. Take it before the request's first await. */
export function admitRun(sessionId: string): number {
	return cancels.get(sessionId) ?? 0;
}

/**
 * Called on every cancel, including one that finds no live run to abort: a request admitted before it,
 * still writing when the cancel arrived, must not start a run that writes `running` over `aborted`.
 */
export function fenceRuns(sessionId: string): void {
	cancels.set(sessionId, admitRun(sessionId) + 1);
}

export function runAgent(opts: RunAgentOpts): Promise<void> {
	if (opts.admitted !== undefined && opts.admitted !== admitRun(opts.sessionId)) return Promise.resolve();
	const existing = inFlight.get(opts.sessionId);
	if (existing) return existing;
	const run = doRun(opts).finally(() => {
		if (inFlight.get(opts.sessionId) === run) inFlight.delete(opts.sessionId);
	});
	inFlight.set(opts.sessionId, run);
	return run;
}

/** Includes a cancelled run still finishing a model call or a handler. */
export function isRunInFlight(sessionId: string): boolean {
	return inFlight.has(sessionId);
}

async function doRun(opts: RunAgentOpts): Promise<void> {
	const toolMap = toolMapByName(opts.tools);
	const toolDefs: ToolDef[] = opts.tools.map((t) => t.def);
	// The cancel path already wrote `aborted`; `running` must not replace it. Every later status write
	// goes through `endRun`, which keeps `aborted` under the session lock.
	if (opts.signal?.aborted) return;
	await setStatus(opts.sessionId, 'running');
	const ctx: AgentToolContext = {
		sessionId: opts.sessionId,
		signal: opts.signal,
		scopes: opts.scopes,
		maxResultBytes: opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES,
	};

	try {
		// Before the approvals below can execute anything: a cap lowered while a run sat awaiting
		// approval must stop the approved action, not just the next model call.
		if (await stopIfOverBudget(opts)) return;

		// Drain resolved approvals until none is left. An approval resolved while the drain runs joins this run
		// (`startRun`), so it is drained here, not left unanswered for the next model call. While any approval
		// is unresolved the run pauses: generating now would send tool calls without their responses, which
		// the provider rejects.
		for (;;) {
			if (opts.signal?.aborted) return;
			await consumeResolvedApprovals(opts.sessionId, toolMap, ctx);
			const approvals = (await getSession(opts.sessionId))?.pendingApprovals ?? [];
			if (approvals.some((a) => a.resolved && !a.consumed)) continue;
			if (!approvals.some((a) => !a.resolved)) break;
			const paused = await endRun(opts.sessionId, { status: 'awaiting_approval', pauseWhileApprovalsOpen: true });
			if (paused.status === 'aborted' || paused.pendingApprovals.some((a) => !a.resolved)) return;
		}

		for (let turn = 0; turn < opts.maxTurns; turn++) {
			if (opts.signal?.aborted) return; // status was already set to `aborted` by cancelRun
			const result = await generateTurn(opts, toolDefs);
			if (opts.signal?.aborted) {
				// The call returned after the cancel; its reply is discarded but it was billed, so it is counted.
				await endRun(opts.sessionId, {
					status: 'aborted',
					lastError: 'Cancelled by operator',
					rejectedCall: callUsage(result.usage, result.costUsd) ?? {},
				});
				return;
			}
			log.debug?.(
				`Session ${opts.sessionId} turn ${turn}: finishReason=${result.finishReason} toolCalls=${result.toolCalls?.length ?? 0} contentChars=${result.content?.length ?? 0} completionTokens=${result.usage?.completionTokens ?? 'unknown'}`
			);

			// Must run before appendMessage: nothing from a rejected turn may reach the transcript (agent/DESIGN.md).
			const rejection = rejectTurn(result, opts.generateOpts?.maxTokens);
			if (rejection) {
				// The rejected call was still billed, so its usage is kept on the session, outside the transcript.
				await endRun(opts.sessionId, {
					status: 'error',
					lastError: rejection,
					rejectedCall: callUsage(result.usage, result.costUsd) ?? {},
				});
				return;
			}

			const assistantMessage: AgentMessage = {
				role: 'assistant',
				content: result.content ?? '',
				toolCalls: result.toolCalls,
				createdAt: Date.now(),
			};
			const usage = callUsage(result.usage, result.costUsd);
			if (usage) assistantMessage.usage = usage;

			const session = hasBudget(opts) ? await getSession(opts.sessionId) : undefined;
			const violation = session
				? budgetViolation(summarizeSessionUsage([...session.messages, assistantMessage], session.rejectedCalls), opts)
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
				await endRun(opts.sessionId, { status: 'completed' });
				return;
			}

			const paused = await dispatchToolCalls(result.toolCalls, toolMap, ctx, opts);
			if (paused || opts.signal?.aborted) return;
		}
		await endRun(opts.sessionId, {
			status: 'completed',
			lastError: `Reached maxTurns=${opts.maxTurns} without a final answer.`,
		});
	} catch (err) {
		// If the abort signal fired, the cancel path already set the session to `aborted` —
		// don't clobber that with `error`. The rejection here is just the awaited generate/tool
		// honoring the signal, not a real failure.
		if (opts.signal?.aborted) return;
		await endRun(opts.sessionId, { status: 'error', lastError: err instanceof Error ? err.message : String(err) });
		throw err;
	}
}

function rejectTurn(result: GenerateResult, maxTokens: number | undefined): string | undefined {
	const toolCallCount = result.toolCalls?.length ?? 0;
	const notExecuted = toolCallCount > 0 ? `; its ${toolCallCount} tool call(s) were not executed` : '';
	if (result.finishReason === 'length') {
		return `Model response was cut off (finishReason=length)${notExecuted}: it reached either the output-token limit (maxTokens=${maxTokens ?? 'backend default'}; raise agent.maxTokens) or the model's context window (start a new session).`;
	}
	if (result.finishReason === 'content_filter') {
		return `Model response was stopped by the provider's content filter or a model refusal${notExecuted}.`;
	}
	if (toolCallCount > 0) return undefined;
	if (result.finishReason === 'tool_calls') return 'Model requested a tool call that could not be parsed.';
	if (!result.content?.trim()) return `Model returned an empty response (finishReason=${result.finishReason}).`;
	return undefined;
}

/**
 * When the provider says the request does not fit the model's context window, shrink the newest
 * oversized tool results in the stored transcript and retry once. Best effort: the overflow can also
 * come from a long prompt or a long history, which shrinking the newest results does not fix.
 */
async function generateTurn(opts: RunAgentOpts, toolDefs: ToolDef[]): Promise<GenerateResult> {
	try {
		return await requestTurn(opts, toolDefs);
	} catch (err) {
		if (!isContextWindowExceeded(err) || opts.signal?.aborted) throw err;
		const shrunk = await shrinkNewestToolResults(opts.sessionId, CONTEXT_SHRINK_BYTES, shrinkForContext);
		if (shrunk === 0) {
			throw contextWindowError(
				err,
				`no tool result over ${CONTEXT_SHRINK_BYTES} bytes is left to shrink; shorten the prompt or start a new session`
			);
		}
		log.warn?.(
			`Session ${opts.sessionId}: request exceeded the model's context window; shrank ${shrunk} tool result(s) to ${CONTEXT_SHRINK_BYTES} bytes and retrying once`
		);
		if (opts.signal?.aborted) throw err;
		try {
			return await requestTurn(opts, toolDefs);
		} catch (retryErr) {
			if (!isContextWindowExceeded(retryErr)) throw retryErr;
			throw contextWindowError(
				retryErr,
				'it still does not fit after shrinking the newest tool results; start a new session'
			);
		}
	}
}

async function requestTurn(opts: RunAgentOpts, toolDefs: ToolDef[]): Promise<GenerateResult> {
	const session = await getSession(opts.sessionId);
	if (!session) throw new Error(`Session ${opts.sessionId} vanished mid-run`);
	opts.signal?.throwIfAborted();
	return opts.models.generate(
		{ messages: toModelMessages(session.messages), tools: toolDefs, system: opts.systemPrompt },
		{ ...opts.generateOpts, toolMode: 'return', signal: opts.signal }
	);
}

function shrinkForContext(content: string): string {
	const marker = `…[cut from ${Buffer.byteLength(content, 'utf8')} bytes: a request including this result exceeded the model's context window. ${ASK_FOR_LESS}.]`;
	return truncateWithMarker(content, CONTEXT_SHRINK_BYTES, marker);
}

function contextWindowError(cause: unknown, detail: string): Error {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new Error(`The conversation no longer fits the model's context window: ${detail}. (${reason})`, { cause });
}

/**
 * Every open approval, resolved or not, is answered without executing it, so no tool call is left
 * without a response once the session leaves `awaiting_approval`.
 */
async function stopIfOverBudget(opts: RunAgentOpts): Promise<boolean> {
	if (!hasBudget(opts)) return false;
	const session = await getSession(opts.sessionId);
	if (!session) return false;
	const violation = budgetViolation(summarizeSessionUsage(session.messages, session.rejectedCalls), opts);
	if (!violation) return false;
	await endRun(opts.sessionId, {
		answerOpenApprovals: (approval) => approvalRefusal(approval, violation),
		status: 'error',
		lastError: violation,
	});
	return true;
}

function budgetRefusal(toolCallId: string, reason: string): AgentMessage {
	return { role: 'tool', content: budgetExceeded(reason), toolCallId, createdAt: Date.now() };
}

function budgetExceeded(reason: string): string {
	return JSON.stringify({ ok: false, error: 'budget_exceeded', reason });
}

function approvalRefusal(approval: ApprovalRequest, reason: string): string {
	return !approval.resolved || approval.approved ? budgetExceeded(reason) : deniedObservation(approval);
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
	for (const [index, call] of calls.entries()) {
		if (opts.signal?.aborted) {
			// Answer the rest of the turn in one write, so the transcript stays sendable after the cancel.
			await endRun(opts.sessionId, {
				append: calls.slice(index).map((unanswered) => ({
					role: 'tool',
					content: cancelledObservation(unanswered.name),
					toolCallId: unanswered.id,
					createdAt: Date.now(),
				})),
				status: 'aborted',
				lastError: 'Cancelled by operator',
			});
			return true;
		}
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
	// A claimed approval with no response belongs to a run that died between the claim and its result
	// (runs are serialized per session, so none is still running). Answer it, without running it again.
	const answered = new Set(session.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
	for (const approval of session.pendingApprovals) {
		if (!approval.consumed || answered.has(approval.toolCallId)) continue;
		await appendMessage(sessionId, {
			role: 'tool',
			content: JSON.stringify({ ok: false, error: 'interrupted', outcome: 'unknown', tool: approval.toolName }),
			toolCallId: approval.toolCallId,
			createdAt: Date.now(),
		});
	}
	const toConsume = session.pendingApprovals.filter((a) => a.resolved && !a.consumed);
	for (const approval of toConsume) {
		if (ctx.signal?.aborted) return;
		if (!(await claimApproval(sessionId, approval.id))) continue;
		// The claim makes this run the only writer that can answer the call; a cancel that landed during
		// the claim gets that answer instead of the action.
		if (ctx.signal?.aborted) {
			await appendMessage(sessionId, {
				role: 'tool',
				content: cancelledObservation(approval.toolName),
				toolCallId: approval.toolCallId,
				createdAt: Date.now(),
			});
			return;
		}
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
	}
}

async function invokeTool(call: ToolCall, toolMap: Map<string, AgentTool>, ctx: AgentToolContext): Promise<string> {
	const tool = toolMap.get(call.name);
	if (!tool) return capObservation({ error: 'unknown_tool', name: call.name }, ctx);
	try {
		const result = await tool.handler(call.arguments ?? {}, ctx);
		return capObservation({ ok: true, result }, ctx);
	} catch (err) {
		return capObservation({ ok: false, error: errorInfo(err).message }, ctx);
	}
}

function capObservation(observation: object, ctx: AgentToolContext): string {
	return serializeToolResult(observation, ctx.maxResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES, ASK_FOR_LESS).content;
}

function toModelMessages(items: AgentMessage[]): Message[] {
	return items.map((item) => {
		const message: Message = { role: item.role, content: item.content };
		if (item.toolCalls) message.toolCalls = item.toolCalls;
		if (item.toolCallId) message.toolCallId = item.toolCallId;
		return message;
	});
}

/** Test-only: clear the in-flight tracking map. */
export function _resetInFlightForTests(): void {
	inFlight.clear();
	cancels.clear();
}
