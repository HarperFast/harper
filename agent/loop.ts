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
	getSession,
	markApprovalConsumed,
	setStatus,
	shrinkNewestToolResults,
} from './session.ts';
import type { AgentMessage, AgentScopes, AgentTool, AgentToolContext } from './types.ts';
import { toolMapByName } from './toolset.ts';

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

/** What each of the newest tool results is cut to after a request that included them overflowed the context window. */
const CONTEXT_SHRINK_BYTES = 2048;
const ASK_FOR_LESS =
	'Ask for less: read_file with startLine/lineCount, tail_file with fewer lines, grep_files with a narrower pattern, or a narrower query';

export interface RunAgentOpts {
	sessionId: string;
	models: Pick<Models, 'generate'>;
	tools: AgentTool[];
	scopes: AgentScopes;
	maxTurns: number;
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
	const ctx: AgentToolContext = {
		sessionId: opts.sessionId,
		signal: opts.signal,
		scopes: opts.scopes,
		maxResultBytes: opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES,
	};

	try {
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
			const result = await generateTurn(opts, toolDefs);
			if (opts.signal?.aborted) return;

			await appendMessage(opts.sessionId, {
				role: 'assistant',
				content: result.content ?? '',
				toolCalls: result.toolCalls,
				createdAt: Date.now(),
			});

			if (!result.toolCalls || result.toolCalls.length === 0) {
				if (opts.signal?.aborted) return;
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
			: JSON.stringify({ ok: false, error: 'denied_by_operator', tool: approval.toolName });
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
}
