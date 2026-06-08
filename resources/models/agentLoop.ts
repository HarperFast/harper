/**
 * In-process tool-call agent loop for `Models.generate({ toolMode: 'auto' })`.
 *
 * Each iteration: (1) call `models.generate` with the running message list,
 * (2) if the model emitted tool calls, dispatch each via `opts.toolHandlers`,
 * (3) append the tool results to the message list, repeat. Terminate when the
 * model returns a non-`tool_calls` finish reason or when the iteration cap trips.
 *
 * Analytics: the loop calls back through `models.generate(..., {toolMode: 'return'})`
 * per iteration so each backend round flows the single-shot path in `Models.ts` and
 * writes its own `hdb_model_calls` row. The outer auto call stays out of the table.
 *
 * **Abort wiring** (commit 3). Each invocation creates a loop-level
 * `AbortController` composed with the caller's signal via `AbortSignal.any`. The
 * composed signal flows to both the inner `models.generate` call and the
 * `ToolHandlerContext.signal` handlers receive. Today the loop-level controller is
 * only fired externally (caller aborts → composed signal aborts); commit 4 wires
 * it to also fire on budget trips so an in-flight LLM call cancels cleanly.
 *
 * Streaming auto path + `opts.conversation.append` hook on both sync and streaming.
 * The streaming loop yields each round's content / tool-call deltas to the caller as
 * they arrive, accumulates the round's tool-call assembly internally, and treats
 * `finishReason` as an INTERNAL signal: it is stripped from every forwarded chunk and
 * re-emitted as exactly one terminal chunk AFTER the terminal assistant turn has been
 * persisted, so a consumer that stops on the finish-reason chunk can never race past
 * the conversation append. Tools run between rounds; the next backend stream resumes.
 * Budget / abort / error-mode semantics match the sync path, with one streaming-specific
 * gap: `maxToolTokens` / `maxCostUsd` are not yet enforced for streamed calls because
 * `GenerateChunk` doesn't expose `usage` in v1 (follow-up to extend the chunk shape +
 * backend final-chunk handling).
 *
 * Resilience posture (this module is foundational infra — fail loud, never silent):
 *   - Handler lookup uses `Object.hasOwn` + a callable check; a model-emitted tool name
 *     that collides with an Object prototype member (`toString`, `constructor`, …) does
 *     NOT resolve a built-in as a handler.
 *   - Missing handler splits two ways: a name the caller DECLARED in `tools` but didn't
 *     supply a handler for is a caller config bug (hard `ClientError(400)`); an UNdeclared
 *     name is a model hallucination, surfaced as a recoverable tool error (`toolErrorMode`
 *     decides recover-vs-abort).
 *   - A token/cost budget set against a backend that reports no `usage` warns once that it
 *     is unenforceable rather than silently no-opping.
 *   - An incomplete streamed tool call (id without a name) is recorded in the trace + warned,
 *     not silently dropped.
 *   - `toolErrorMode: 'abort'` throws BEFORE the conversation sink sees the round's tool
 *     turns, so the store never holds a recover-style error turn the model never consumed.
 *
 * Modes still deferred to follow-ups throw 501 at entry:
 *   - `toolArgValidation: 'strict' | 'lenient'`  → JSON Schema validator (TBD)
 *   - `maxToolTokens` / `maxCostUsd` (streaming) → backend `usage` on chunks (TBD)
 *
 * Registry seam: v1 dispatches via caller-supplied `opts.toolHandlers`. #615 replaces
 * that lookup with a `scope.resources` resolution using the same call signature — the
 * declared-vs-undeclared split maps onto resolvable-but-misconfigured vs unknown.
 */
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import { logger } from '../../utility/logging/logger.ts';
import type {
	AccountingContext,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	Message,
	Models,
	TokenUsage,
	ToolCall,
	ToolDef,
	ToolHandler,
	ToolHandlerContext,
	ToolTraceEntry,
} from './types.ts';

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_RESULT_BYTES = 65_536;

export interface RunAgentLoopArgs {
	models: Models;
	input: GenerateInput;
	opts: GenerateOpts;
	accounting: AccountingContext;
	signal?: AbortSignal;
}

export async function runAgentLoop(args: RunAgentLoopArgs): Promise<GenerateResult> {
	const { models, opts, accounting, signal: callerSignal } = args;

	// v1 gates: surface declared on GenerateOpts, runtime fills in incrementally.
	// Throw a clear 501 at entry rather than silently downgrading to default behavior —
	// the alternative (ignore unsupported mode) would mask caller mistakes.
	guardUnsupportedModes(opts);

	const maxIterations = opts.maxToolIterations ?? DEFAULT_MAX_ITERATIONS;
	const maxResultBytes = opts.toolResultMaxBytes ?? DEFAULT_MAX_RESULT_BYTES;
	const handlers = opts.toolHandlers ?? {};
	const parallelism = opts.toolParallelism ?? 'parallel';
	const errorMode = opts.toolErrorMode ?? 'recover';
	const maxToolTokens = opts.maxToolTokens;
	const maxCostUsd = opts.maxCostUsd;
	const conversation = opts.conversation;

	const { messages, tools, system } = normalizeInput(args.input);
	// Names the CALLER declared as tools (object-form input). Used to split the
	// missing-handler case: a declared tool with no handler is a caller config bug
	// (hard fail); an UNdeclared name is a model hallucination (recover). See
	// `runSingleToolCall`.
	const declaredToolNames = collectDeclaredToolNames(tools);
	const trace: ToolTraceEntry[] = [];
	// Cumulative usage tallies across all iterations of this loop invocation. Used to
	// trip `maxToolTokens` / `maxCostUsd` after each backend round.
	let totalTokens = 0;
	let totalCostUsd = 0;
	// Warn-once latch: a token/cost budget is set but the backend isn't reporting
	// usage, so the cap can't be measured. We refuse to silently pretend it's enforced.
	let budgetUnmeasurableWarned = false;

	// `conversation` is a one-way SINK for NEW turns produced by this loop — the loop
	// does NOT re-append the caller's input messages, even when they include user
	// turns. Echoing input back into the caller's store would corrupt it (the caller
	// already added their own prompt) and scramble ordering for multi-turn history.
	// The caller owns turn 0; the loop owns whatever assistant/tool turns it produces.

	// Loop-level abort controller — fired internally on budget trips (commit 4 wires
	// that) and on every loop exit (success, throw, abort) via the `finally` below.
	// Composed with the caller's signal so an external `caller.abort()` ALSO fires
	// the loop's signal (handlers and the in-flight backend call both react). The
	// composed signal is the only signal that flows to inner calls.
	const loopController = new AbortController();
	const composedSignal = composeAbortSignal(callerSignal, loopController.signal);

	// Strip loop-only knobs from what flows back into `models.generate`. The `toolMode:
	// 'return'` override is what prevents the outer entry point from re-entering this loop.
	// `signal` is swapped to the composed signal so `Models.generate` (and through it,
	// the backend) see budget-trip and caller-abort cancellations the same way.
	const innerOpts: GenerateOpts = { ...opts, toolMode: 'return', signal: composedSignal };

	try {
		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			// Pre-iteration abort check — if the caller (or a future budget trip) fired
			// the composed signal between rounds, bail before paying for another backend
			// call. The inner `models.generate` would itself throw on the in-flight check,
			// but throwing here saves the round-trip and the spurious analytics row.
			composedSignal.throwIfAborted();

			const result = await models.generate(buildInnerInput(messages, tools, system), innerOpts);

			// Re-check abort the instant the backend round returns, BEFORE any budget
			// accounting, assistant append, or tool dispatch. A well-behaved backend
			// throws on an in-flight abort; an ill-behaved one (community backend that
			// ignores its signal) can resolve normally after the caller aborted. Without
			// this check the loop would run side-effecting handlers for a cancelled
			// request and then misreport the outcome as a budget/tool error instead of
			// an abort.
			composedSignal.throwIfAborted();

			logger.debug?.(
				`[models] auto-loop iteration ${iteration}: finishReason=${result.finishReason} toolCalls=${result.toolCalls?.length ?? 0} cumulativeTokens=${totalTokens}`
			);

			// A token/cost budget is only as good as the backend's usage reporting. If a
			// cap is set but this round reported no usage, the cap is unmeasurable — warn
			// once rather than letting the caller believe spend is bounded when it isn't.
			if (
				(maxToolTokens !== undefined || maxCostUsd !== undefined) &&
				result.usage === undefined &&
				!budgetUnmeasurableWarned
			) {
				budgetUnmeasurableWarned = true;
				logger.warn?.(
					`[models] auto-loop token/cost budget set but backend '${opts.model ?? 'default'}' reported no usage; budget is unenforceable for this run (maxToolIterations still applies)`
				);
			}

			// Tally this round's usage BEFORE deciding terminal vs continue. A round
			// that crosses the cap trips even if it would otherwise have been the last
			// one — the cap is on what we paid for, not on what we'd have paid for next.
			// Cost trip semantics: `>= cap`, so `maxCostUsd: 0` blocks every call rather
			// than dormantly admitting all of them until a real rate card lands and then
			// abruptly blocking everything. Token trip uses `>=` for symmetry.
			//
			// Discarded-content asymmetry: a TERMINAL round that trips returns
			// BudgetExceededError instead of the final assistant content. The content is
			// in `messages` (the loop's running state) but neither `partialTrace` nor the
			// thrown error surfaces it. Callers that need terminal content even on
			// budget-trip should set `maxToolTokens` / `maxCostUsd` conservatively or read
			// the per-iteration analytics rows (one row per round in `hdb_model_calls`).
			totalTokens += sumTokens(result.usage);
			totalCostUsd += computeCallCostUsd(result.usage, opts.model);
			if (maxToolTokens !== undefined && totalTokens >= maxToolTokens) {
				throw new BudgetExceededError(
					'tokens',
					`agent loop exceeded maxToolTokens=${maxToolTokens} (cumulative=${totalTokens})`,
					trace
				);
			}
			if (maxCostUsd !== undefined && totalCostUsd >= maxCostUsd) {
				throw new BudgetExceededError(
					'cost',
					`agent loop exceeded maxCostUsd=${maxCostUsd} (cumulative=${totalCostUsd})`,
					trace
				);
			}

			const calls = result.toolCalls;
			// Backends (notably OpenAI) leave `content` as `null` / undefined on tool-call
			// rounds. `Message.content` and `ConversationTurn.content` are typed as a
			// required string — coerce to '' at the seam.
			const assistantContent = result.content ?? '';
			if (result.finishReason !== 'tool_calls' || !calls || calls.length === 0) {
				// Terminal: model produced a final answer (stop / length / content_filter), or it
				// signaled tool_calls but emitted none. Append final assistant turn to the
				// conversation hook (if set), then pass the result through; attach the trace
				// when the caller asked for it.
				if (conversation && assistantContent) {
					await conversation.append({ role: 'assistant', content: assistantContent });
				}
				// A `tool_calls` finishReason with no dispatchable calls (e.g. the backend
				// dropped malformed tool-call args) is terminal — coerce it to 'stop' so an
				// auto-mode caller never sees a `tool_calls` finishReason (auto resolves calls
				// internally) pointing at calls that aren't there, and never a `null` content.
				// Mirrors the streaming path's terminalReason fold.
				const terminal: GenerateResult =
					result.finishReason === 'tool_calls'
						? { ...result, finishReason: 'stop', content: assistantContent }
						: result;
				return opts.includeToolTrace ? { ...terminal, trace } : terminal;
			}

			messages.push({ role: 'assistant', content: assistantContent, toolCalls: calls });
			if (conversation) {
				await conversation.append({
					role: 'assistant',
					content: assistantContent,
					toolCalls: calls,
				});
			}

			const ctx: ToolHandlerContext = { signal: composedSignal, accounting };
			const dispatched = await dispatchToolCalls(
				calls,
				handlers,
				declaredToolNames,
				ctx,
				iteration,
				maxResultBytes,
				parallelism
			);

			// Post-dispatch abort check — covers the LAST-iteration case: if the signal
			// fired during this round's handlers, we'd otherwise skip the top-of-loop check
			// and throw `BudgetExceededError` (misleading: the budget never tripped). Fire
			// the abort here so the caller gets the correct error class. Earlier iterations
			// pick this up on the next round's top-of-loop check.
			composedSignal.throwIfAborted();

			// Trace + the in-memory message list always record every tool result in CALL
			// order (the trace mirrors what the model emitted, not which handler finished
			// first). The EXTERNAL conversation sink is handled separately below so the
			// abort-mode throw can run BEFORE we persist turns the model never consumes.
			for (const dispatchResult of dispatched) {
				trace.push(dispatchResult.entry);
				messages.push({
					role: 'tool',
					content: dispatchResult.toolMessageContent,
					toolCallId: dispatchResult.entry.toolCallId,
				});
			}

			// `toolErrorMode: 'abort'`: any handler failure terminates the loop. Throw
			// BEFORE the conversation sink sees this round's tool turns — abort mode
			// returns the error to the caller instead of recovering, so persisting a
			// recover-style tool-error turn the model never reads would leave the store
			// inconsistent with what actually happened. The trace (built above) still
			// carries the failing entry via `ToolHandlerError.partialTrace`.
			if (errorMode === 'abort') {
				const failed = dispatched.find((d) => d.originalError !== undefined);
				if (failed) {
					throw new ToolHandlerError(failed.entry.toolName, failed.entry.toolCallId, trace, failed.originalError);
				}
			}

			// Continue path: persist this round's tool turns to the conversation sink.
			if (conversation) {
				for (const dispatchResult of dispatched) {
					await conversation.append({
						role: 'tool',
						toolCallId: dispatchResult.entry.toolCallId,
						content: dispatchResult.toolMessageContent,
					});
				}
			}
		}

		// Hit `maxToolIterations` without a terminal finishReason — the model kept calling tools.
		// Always include the trace on the error path (independent of `includeToolTrace`) so
		// callers can debug an exhausted budget without re-running with tracing on.
		throw new BudgetExceededError('iterations', `agent loop exceeded maxToolIterations=${maxIterations}`, trace);
	} finally {
		// Always abort the loop controller on exit (success, throw, or external abort).
		// Cleans up `AbortSignal.any`'s listener on `callerSignal` so a session-scoped caller
		// signal doesn't accumulate listeners across many `runAgentLoop` invocations, and
		// signals any sibling handlers still running in the background after a Promise.all
		// rejection (missing-handler or aborted-mid-flight) to bail out promptly.
		loopController.abort();
	}
}

interface DispatchedToolCall {
	entry: ToolTraceEntry;
	toolMessageContent: string;
	/**
	 * The original thrown value when the handler / serialization failed and recover
	 * mode caught it. Preserved alongside the formatted `entry.error` so abort mode
	 * can surface the cause unmodified via `ToolHandlerError.cause`. Undefined when
	 * the handler succeeded.
	 */
	originalError?: unknown;
}

async function dispatchToolCalls(
	calls: ToolCall[],
	handlers: Record<string, ToolHandler>,
	declaredToolNames: Set<string>,
	ctx: ToolHandlerContext,
	iteration: number,
	maxResultBytes: number,
	parallelism: 'parallel' | 'serial'
): Promise<DispatchedToolCall[]> {
	// Single-call rounds use the serial path even when 'parallel' is selected — the
	// settled-wrapping path adds nothing on one element and the serial path's stack
	// trace is more readable in errors.
	if (parallelism === 'serial' || calls.length <= 1) {
		const out: DispatchedToolCall[] = [];
		for (const call of calls) {
			out.push(await runSingleToolCall(call, handlers, declaredToolNames, ctx, iteration, maxResultBytes));
		}
		return out;
	}
	// Parallel: handlers race concurrently. `runSingleToolCall` only throws on missing
	// handler or cooperative abort — handler errors are caught inline and surface via
	// `originalError`. `Promise.all` rejects on first throw, which is what we want for
	// those two cases: surface the throw immediately so the loop's `finally` can fire
	// `loopController.abort` and cancel siblings still in flight, instead of waiting
	// for every sibling to complete (which `Promise.allSettled` would force).
	//
	// Concurrent-rejection caveat: when MULTIPLE siblings reject at the same time
	// (e.g. several missing handlers, or several handlers reacting to a cooperative
	// abort), `Promise.all` only awaits the first rejection — the rest become
	// unhandled-rejection warnings (and crash under `--unhandled-rejections=throw`).
	// Attach a no-op catch to each promise so the runtime sees every rejection as
	// handled while still letting `Promise.all` settle on the first one.
	const promises = calls.map((call) =>
		runSingleToolCall(call, handlers, declaredToolNames, ctx, iteration, maxResultBytes)
	);
	for (const p of promises) p.catch(() => {});
	return Promise.all(promises);
}

async function runSingleToolCall(
	call: ToolCall,
	handlers: Record<string, ToolHandler>,
	declaredToolNames: Set<string>,
	ctx: ToolHandlerContext,
	iteration: number,
	maxResultBytes: number
): Promise<DispatchedToolCall> {
	const entry: ToolTraceEntry = {
		iteration,
		toolCallId: call.id,
		toolName: call.name,
		// Shallow-copy so the trace's view of "what the model emitted" doesn't shift if a
		// handler mutates its `args` parameter (legitimate pattern). Deep mutations to
		// nested objects can still leak — common-case flat-object args are covered.
		arguments: { ...call.arguments },
		durationMs: 0,
	};

	// Handler resolution. Use `Object.hasOwn` + a callable check rather than a plain
	// `handlers[call.name]` lookup: a model can emit a tool name that collides with an
	// inherited Object prototype member (`toString`, `constructor`, `__proto__`, ...),
	// and a bare index would resolve that built-in as a "handler" and invoke it. Model
	// output is untrusted input at this boundary — only an own, callable property counts.
	const handler =
		Object.hasOwn(handlers, call.name) && typeof handlers[call.name] === 'function' ? handlers[call.name] : undefined;
	if (!handler) {
		if (declaredToolNames.has(call.name)) {
			// The caller DECLARED this tool but supplied no (callable) handler for it.
			// That's a caller config bug, not something the model can recover from —
			// hard fail. (#615 swaps this lookup for a `scope.resources` registry
			// resolution; same split — resolvable-but-misconfigured stays a hard fail.)
			throw new ClientError(`No handler registered for declared tool '${call.name}' (call id ${call.id})`, 400);
		}
		// Undeclared tool name: the model hallucinated a tool that doesn't exist. This is
		// the EXPECTED failure mode for an LLM, not a caller fault — surface it as a
		// recoverable tool error so `toolErrorMode: 'recover'` feeds it back and the model
		// can self-correct, while `'abort'` (via `originalError`) still stops the loop.
		logger.warn?.(
			`[models] auto-loop: model called unknown tool '${call.name}' (call id ${call.id}); no such tool declared`
		);
		const unknownToolError = new ClientError(`Unknown tool '${call.name}': no such tool is available`, 400);
		entry.error = errorInfo(unknownToolError);
		return {
			entry,
			toolMessageContent: JSON.stringify({ error: entry.error.message }),
			originalError: unknownToolError,
		};
	}

	const handlerStart = performance.now();
	let toolMessageContent: string;
	let originalError: unknown;
	// Wrap BOTH the handler call AND result serialization in the recover catch.
	// `JSON.stringify` throws on BigInt and circular refs — both trivially produced by
	// handlers that return raw DB rows or Resource instances. Without this, a
	// serialization failure crashes the entire loop instead of becoming a tool error
	// the model can react to (the `toolErrorMode: 'recover'` contract).
	try {
		const handlerOutput = await handler(call.arguments, ctx);
		const serialized = serializeToolResult(handlerOutput, maxResultBytes);
		entry.result = serialized.content;
		if (serialized.truncated) {
			entry.truncated = true;
			entry.totalBytes = serialized.totalBytes;
		}
		toolMessageContent = serialized.content;
	} catch (err) {
		// Cooperative cancellation is NOT a tool error — rethrow so the loop's
		// abort path (top-of-loop / post-dispatch `throwIfAborted`) classifies it
		// correctly. Without this, AbortError would land in `entry.error` and the
		// caller would see `BudgetExceededError` on the last iteration, or a
		// bogus `{error: 'aborted'}` tool message threaded into the conversation.
		// The trace entry is abandoned (the loop builds an aborted-path trace later).
		if (ctx.signal?.aborted) throw err;
		// Handler error. Populate entry.error so the trace records the failure, build
		// the recover-mode tool-message envelope, and stash the original throw so
		// `toolErrorMode: 'abort'` (checked in the main loop after dispatch) can
		// surface the cause unmodified.
		originalError = err;
		entry.error = errorInfo(err);
		toolMessageContent = JSON.stringify({ error: entry.error.message });
	}
	entry.durationMs = performance.now() - handlerStart;

	return { entry, toolMessageContent, originalError };
}

/**
 * Mirror of `backendHelpers.composeSignal` but composing a caller signal with an
 * INTERNAL controller's signal (not a timeout). Returns the internal signal alone
 * when no caller signal exists, the caller signal alone when no internal controller
 * is needed (today never — we always create one), and a composed signal otherwise.
 *
 * `AbortSignal.any` requires Node 20+, which matches Harper's engines floor.
 */
function composeAbortSignal(caller: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
	if (!caller) return internal;
	return AbortSignal.any([caller, internal]);
}

export async function* runAgentLoopStream(args: RunAgentLoopArgs): AsyncIterable<GenerateChunk> {
	const { models, opts, accounting, signal: callerSignal } = args;

	guardUnsupportedModes(opts);

	const maxIterations = opts.maxToolIterations ?? DEFAULT_MAX_ITERATIONS;
	const maxResultBytes = opts.toolResultMaxBytes ?? DEFAULT_MAX_RESULT_BYTES;
	const handlers = opts.toolHandlers ?? {};
	const parallelism = opts.toolParallelism ?? 'parallel';
	const errorMode = opts.toolErrorMode ?? 'recover';
	const conversation = opts.conversation;
	// Streaming + token/cost budgets: backends don't emit `usage` on `GenerateChunk`
	// in v1 (the type has no `usage` field on chunks), so cumulative usage isn't
	// observable from the stream. The iteration budget still applies. Wiring
	// streaming budgets requires extending `GenerateChunk` and updating each
	// backend's stream-final-chunk handling — a follow-up to this PR.
	if (opts.maxToolTokens !== undefined || opts.maxCostUsd !== undefined) {
		throw new ServerError(
			`maxToolTokens / maxCostUsd are not yet supported for generateStream (streamed usage not exposed in v1)`,
			501
		);
	}

	const { messages, tools, system } = normalizeInput(args.input);
	const declaredToolNames = collectDeclaredToolNames(tools);
	const trace: ToolTraceEntry[] = [];

	const loopController = new AbortController();
	const composedSignal = composeAbortSignal(callerSignal, loopController.signal);
	const innerOpts: GenerateOpts = { ...opts, toolMode: 'return', signal: composedSignal };

	// `conversation` is a one-way SINK for NEW turns produced by this loop — see
	// `runAgentLoop` for the rationale. Streaming path applies the same contract.

	try {
		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			composedSignal.throwIfAborted();

			// Stream this round: yield content + tool-call deltas to the caller as they
			// arrive, while internally assembling the round's content and tool-call shape.
			let accumulatedContent = '';
			const toolCallAssembly = new Map<string, Partial<ToolCall>>();
			let finishReason: GenerateResult['finishReason'] | undefined;

			const stream = models.generateStream(buildInnerInput(messages, tools, system), innerOpts);
			for await (const chunk of stream) {
				// Defense-in-depth: well-behaved backends honor `opts.signal` via the
				// fetch they hand it to. An ill-behaved community backend that doesn't
				// observe its signal would otherwise keep streaming after a caller abort.
				composedSignal.throwIfAborted();

				if (chunk.deltaContent !== undefined) {
					accumulatedContent += chunk.deltaContent;
				}
				if (chunk.deltaToolCalls) {
					for (const delta of chunk.deltaToolCalls) {
						mergeToolCallDelta(toolCallAssembly, delta);
					}
				}
				if (chunk.finishReason) {
					finishReason = chunk.finishReason;
				}
				// `finishReason` is an INTERNAL signal — never forward it inline. We re-emit
				// exactly one terminal chunk after the loop, AFTER the terminal turn has been
				// appended to the conversation sink (see below). Forwarding it here would let a
				// consumer that stops on the first finish-reason chunk close this generator at
				// the `yield` before the append runs, delivering a response that never persists.
				// The deltas (content / tool-call shape) still flow through untouched.
				if (chunk.deltaContent !== undefined || chunk.deltaToolCalls) {
					const cleaned: GenerateChunk = {};
					if (chunk.deltaContent !== undefined) cleaned.deltaContent = chunk.deltaContent;
					if (chunk.deltaToolCalls) cleaned.deltaToolCalls = chunk.deltaToolCalls;
					yield cleaned;
				}
			}

			const finalToolCalls = completeToolCallAssembly(toolCallAssembly);
			// Surface any assembled-but-incomplete tool calls (id arrived, name never did)
			// instead of silently dropping them. `completeToolCallAssembly` keeps only
			// dispatchable (id + name) calls; a missing-name partial usually means a
			// truncated stream. Record it in the trace + warn so the drop is observable.
			if (finalToolCalls.length < toolCallAssembly.size) {
				for (const [id, partial] of toolCallAssembly) {
					if (!partial.name) {
						logger.warn?.(
							`[models] auto-loop: dropping incomplete streamed tool call id=${id} (no tool name assembled; stream likely truncated)`
						);
						trace.push({
							iteration,
							toolCallId: id,
							toolName: '<incomplete>',
							arguments: partial.arguments ?? {},
							durationMs: 0,
							error: { name: 'IncompleteToolCall', message: 'streamed tool call missing name; dropped' },
						});
					}
				}
			}

			logger.debug?.(
				`[models] auto-loop stream iteration ${iteration}: finishReason=${finishReason ?? 'none'} toolCalls=${finalToolCalls.length}`
			);

			// Continue-vs-terminal:
			// - Hand off to tool dispatch when calls assembled AND the backend signalled
			//   tool_calls OR didn't signal anything at all. The "no finishReason" case
			//   covers proxy-truncated streams: every in-tree backend (openai, anthropic,
			//   bedrock) emits a tail-flush `deltaToolCalls` without a finishReason when
			//   the upstream connection drops mid-stream. Treating that as terminal would
			//   silently drop the assembled tool calls — the backend's recovery would be
			//   undone by this loop.
			// - Otherwise, terminal: yield a synthetic 'stop' chunk if the consumer didn't
			//   receive a terminal finishReason inline (degenerate streams, or the
			//   suppressed `tool_calls` finishReason with zero assembled calls).
			const hasToolCalls = finalToolCalls.length > 0;
			const continueWithToolCalls = hasToolCalls && (finishReason === 'tool_calls' || finishReason === undefined);

			if (!continueWithToolCalls) {
				// Terminal. Persist the final assistant turn to the conversation sink FIRST,
				// then emit exactly one terminal chunk. Because the loop suppressed every
				// inline finishReason, this `yield` is the only finish-reason the consumer
				// sees — and it lands after the append, so a consumer that stops on it cannot
				// race past the persistence.
				if (conversation && accumulatedContent) {
					await conversation.append({ role: 'assistant', content: accumulatedContent });
				}
				// `tool_calls` with zero dispatchable calls can't honestly be reported as the
				// terminal reason (there are no calls); fold it and the no-signal case to 'stop'.
				const terminalReason = finishReason && finishReason !== 'tool_calls' ? finishReason : 'stop';
				yield { finishReason: terminalReason };
				return;
			}

			// Continue the loop: dispatch tools, append messages, resume on next iteration.
			const assistantMessage: Message = {
				role: 'assistant',
				content: accumulatedContent,
				toolCalls: finalToolCalls,
			};
			messages.push(assistantMessage);
			if (conversation) {
				await conversation.append({
					role: 'assistant',
					content: accumulatedContent,
					toolCalls: finalToolCalls,
				});
			}

			const ctx: ToolHandlerContext = { signal: composedSignal, accounting };
			const dispatched = await dispatchToolCalls(
				finalToolCalls,
				handlers,
				declaredToolNames,
				ctx,
				iteration,
				maxResultBytes,
				parallelism
			);

			composedSignal.throwIfAborted();

			// Trace + in-memory messages always record every result; the external
			// conversation sink is deferred past the abort-mode throw (same rationale as
			// the sync path — don't persist tool turns the model never consumes on abort).
			for (const d of dispatched) {
				trace.push(d.entry);
				messages.push({
					role: 'tool',
					content: d.toolMessageContent,
					toolCallId: d.entry.toolCallId,
				});
			}

			if (errorMode === 'abort') {
				const failed = dispatched.find((d) => d.originalError !== undefined);
				if (failed) {
					throw new ToolHandlerError(failed.entry.toolName, failed.entry.toolCallId, trace, failed.originalError);
				}
			}

			if (conversation) {
				for (const d of dispatched) {
					await conversation.append({
						role: 'tool',
						toolCallId: d.entry.toolCallId,
						content: d.toolMessageContent,
					});
				}
			}
		}

		throw new BudgetExceededError('iterations', `agent loop exceeded maxToolIterations=${maxIterations}`, trace);
	} finally {
		loopController.abort();
	}
}

/**
 * Update the in-flight assembly map with one streamed tool-call delta. Streaming
 * backends may send the same `id` multiple times with partial `name` / `arguments`;
 * we merge them in arrival order. Some backends pre-assemble and send the full
 * call as a single delta — same code path, single update.
 *
 * Backends that stream `arguments` as accumulating JSON string fragments must
 * parse before yielding (delta.arguments is typed as `object`); shape assembly
 * lives in this loop, fragment assembly lives in the backend.
 */
function mergeToolCallDelta(map: Map<string, Partial<ToolCall>>, delta: Partial<ToolCall>): void {
	if (!delta.id) return;
	const existing: Partial<ToolCall> = map.get(delta.id) ?? { id: delta.id };
	if (delta.name) existing.name = delta.name;
	if (delta.arguments) {
		existing.arguments = { ...existing.arguments, ...delta.arguments };
	}
	map.set(delta.id, existing);
}

function completeToolCallAssembly(map: Map<string, Partial<ToolCall>>): ToolCall[] {
	const out: ToolCall[] = [];
	for (const partial of map.values()) {
		if (partial.id && partial.name) {
			out.push({
				id: partial.id,
				name: partial.name,
				arguments: partial.arguments ?? {},
			});
		}
	}
	return out;
}

function guardUnsupportedModes(opts: GenerateOpts): void {
	const validationMode = opts.toolArgValidation ?? 'none';
	if (validationMode !== 'none') {
		throw new ServerError(
			`toolArgValidation: '${validationMode}' is not yet implemented; v1 supports 'none' only`,
			501
		);
	}
}

function buildInnerInput(
	messages: Message[],
	tools: ToolDef[] | undefined,
	system: string | undefined
): { messages: Message[]; tools?: ToolDef[]; system?: string } {
	const inner: { messages: Message[]; tools?: ToolDef[]; system?: string } = { messages };
	if (tools) inner.tools = tools;
	if (system) inner.system = system;
	return inner;
}

function normalizeInput(input: GenerateInput): {
	messages: Message[];
	tools?: ToolDef[];
	system?: string;
} {
	if (typeof input === 'string') {
		return { messages: [{ role: 'user', content: input }] };
	}
	if (Array.isArray(input)) {
		return { messages: [...input] };
	}
	return { messages: [...input.messages], tools: input.tools, system: input.system };
}

function collectDeclaredToolNames(tools: ToolDef[] | undefined): Set<string> {
	const names = new Set<string>();
	if (tools) for (const t of tools) names.add(t.name);
	return names;
}

function errorInfo(err: unknown): { name: string; message: string } {
	if (err instanceof Error) {
		return { name: err.name, message: err.message };
	}
	// Some thrown values are plain objects with a `message` field but no Error chain —
	// e.g. Harper's `BigInt.prototype.toJSON` throws `{message: 'Cannot serialize BigInt …'}`
	// (server/serverHelpers/JSONStream.ts) to skip the cost of capturing a stack on a hot
	// serialization path. Surface their message instead of String()-ing the whole object.
	if (err && typeof err === 'object' && 'message' in err) {
		const e = err as { name?: unknown; message?: unknown };
		const name = typeof e.name === 'string' ? e.name : 'Error';
		const message = typeof e.message === 'string' ? e.message : String(e.message);
		return { name, message };
	}
	return { name: 'Error', message: String(err) };
}

interface SerializedResult {
	content: string;
	totalBytes: number;
	truncated: boolean;
}

function serializeToolResult(value: unknown, maxBytes: number): SerializedResult {
	// `JSON.stringify(Symbol())` (and `JSON.stringify(function(){})`) return `undefined`.
	// `value ?? null` only catches null/undefined inputs, not unsupported types — fall
	// back to the string 'null' so downstream `Buffer.byteLength` never sees undefined.
	const json = JSON.stringify(value ?? null) ?? 'null';
	const totalBytes = Buffer.byteLength(json, 'utf8');
	// Common case: result fits. Skip buffer allocation entirely — read byte length
	// without materializing a copy.
	if (totalBytes <= maxBytes) {
		return { content: json, totalBytes, truncated: false };
	}
	// Truncated form: head of the JSON + a marker that names the original size. The
	// content is no longer valid JSON — that's intentional, the model reads it as text
	// alongside the marker. Pre-slice the JSON string by CHARACTERS to `headBudget`
	// before converting to a Buffer — any character takes at least one UTF-8 byte, so
	// the pre-sliced string already fits in (4 * headBudget) bytes worst-case. Without
	// this, a multi-MB JSON result would materialize a multi-MB Buffer copy just to
	// throw away >99 % of it via `subarray`. After conversion, `subarray(0, headBudget)`
	// trims to exact byte budget; `toString('utf8')` folds a split codepoint at the
	// boundary into U+FFFD.
	const marker = `…[truncated; full result is ${totalBytes} bytes]`;
	const markerBytes = Buffer.byteLength(marker, 'utf8');
	const headBudget = Math.max(0, maxBytes - markerBytes);
	const buf = Buffer.from(json.slice(0, headBudget), 'utf8');
	const body = buf.subarray(0, headBudget).toString('utf8');
	return { content: body + marker, totalBytes, truncated: true };
}

/**
 * Loop tripped one of its budgets (iterations, tokens, cost). The trace built so
 * far rides along on `partialTrace` so callers can inspect what already ran. The
 * loop always populates this regardless of `opts.includeToolTrace` so debugging an
 * exhausted budget never needs a second run with tracing turned on.
 *
 * Extends `ClientError` — the caller set the budget, so exceeding it is a 4xx
 * caller-bounds condition, not a Harper-internal fault. Anything that branches on
 * `err instanceof ClientError` (e.g. "don't page on this") classifies it correctly.
 */
export class BudgetExceededError extends ClientError {
	kind: 'iterations' | 'tokens' | 'cost';
	partialTrace: ToolTraceEntry[];
	constructor(kind: 'iterations' | 'tokens' | 'cost', message: string, partialTrace: ToolTraceEntry[]) {
		// 429 (Too Many Requests) maps cleanest to "you exceeded the budget you set".
		super(message, 429);
		this.name = 'BudgetExceededError';
		this.kind = kind;
		this.partialTrace = partialTrace;
	}
}

/**
 * Surfaced under `toolErrorMode: 'abort'` when a tool handler throws (or its
 * result fails to serialize). Carries the original throw on `.cause` and the
 * partial trace — including the failing entry — on `.partialTrace` so callers
 * always have the full picture on the abort path.
 *
 * `statusCode` mirrors the underlying error when it carries one (e.g. a handler
 * throwing `ClientError(400)` surfaces as `ToolHandlerError(400)`), otherwise
 * defaults to 500.
 *
 * **`instanceof` caveat:** extends `ServerError` regardless of `statusCode`, so a
 * handler-thrown `ClientError(403)` becomes a `ToolHandlerError` whose `statusCode`
 * is 403 but where `instanceof ClientError === false`. Callers that route on
 * client-vs-server class should branch on `err.statusCode` or
 * `err.cause instanceof ClientError`, not on `err instanceof ClientError` directly.
 */
export class ToolHandlerError extends ServerError {
	toolName: string;
	toolCallId: string;
	partialTrace: ToolTraceEntry[];
	constructor(toolName: string, toolCallId: string, partialTrace: ToolTraceEntry[], cause: unknown) {
		const causeMessage = errorInfo(cause).message;
		const causeStatus =
			cause &&
			typeof cause === 'object' &&
			'statusCode' in cause &&
			typeof (cause as { statusCode: unknown }).statusCode === 'number'
				? (cause as { statusCode: number }).statusCode
				: 500;
		super(`Tool handler '${toolName}' (call ${toolCallId}) failed: ${causeMessage}`, causeStatus);
		this.name = 'ToolHandlerError';
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.partialTrace = partialTrace;
		this.cause = cause;
	}
}

/**
 * Cost computation hook. v1 returns 0 — no per-model rate card is wired today —
 * so `maxCostUsd` never trips in production. The cap, the trip path, and the
 * `BudgetExceededError({kind: 'cost'})` shape ARE wired and exercised by tests
 * that inject a non-zero function via `_setComputeCallCostUsdForTests`. When the
 * rate card lands, replace this implementation; no surface change needed.
 */
let computeCallCostUsd: (usage: TokenUsage | undefined, model: string | undefined) => number = () => 0;

/**
 * Test-only override. Public callers must not depend on this — it exists so unit
 * tests can prove the `maxCostUsd` trip path works end-to-end before a real rate
 * card lands. Leading underscore marks the intent.
 */
export function _setComputeCallCostUsdForTests(
	fn: (usage: TokenUsage | undefined, model: string | undefined) => number
): void {
	computeCallCostUsd = fn;
}

/**
 * Reset the cost function to the v1 stub. Pair with `_setComputeCallCostUsdForTests`
 * in test `afterEach` so suites don't leak state into each other.
 */
export function _resetComputeCallCostUsdForTests(): void {
	computeCallCostUsd = () => 0;
}

function sumTokens(usage: TokenUsage | undefined): number {
	if (!usage) return 0;
	let total = 0;
	if (typeof usage.promptTokens === 'number' && usage.promptTokens > 0) total += usage.promptTokens;
	if (typeof usage.completionTokens === 'number' && usage.completionTokens > 0) total += usage.completionTokens;
	return total;
}

/**
 * `toolArgValidation: 'strict'` rejected a tool call's arguments against its
 * declared `parameters` JSON Schema. Surfaces as a 400 — the model produced output
 * that doesn't satisfy the contract the caller declared. Reserved for the
 * validator wiring (currently the strict mode is itself gated at loop entry).
 */
export class ToolValidationError extends ClientError {
	toolName: string;
	toolCallId: string;
	validationErrors: object[];
	constructor(toolName: string, toolCallId: string, validationErrors: object[], message: string) {
		super(message, 400);
		this.name = 'ToolValidationError';
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.validationErrors = validationErrors;
	}
}
