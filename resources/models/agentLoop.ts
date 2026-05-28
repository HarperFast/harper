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
 * Commit 5 of #612 — streaming auto path + `opts.conversation.append` hook on
 * both sync and streaming. The streaming loop yields each round's deltas to the
 * caller as they arrive, accumulates the round's tool-call assembly internally,
 * suppresses intermediate `finishReason: 'tool_calls'` chunks (per the
 * `GenerateChunk` contract that finishReason marks the FINAL chunk only), runs
 * tools between rounds, and resumes with the next backend stream. Budget /
 * abort / error-mode semantics match the sync path, with one streaming-specific
 * gap: `maxToolTokens` / `maxCostUsd` are not yet enforced for streamed calls
 * because `GenerateChunk` doesn't expose `usage` in v1 (follow-up to extend the
 * chunk shape + backend final-chunk handling).
 *
 * Modes still deferred to follow-ups throw 501 at entry:
 *   - `toolArgValidation: 'strict' | 'lenient'`  → JSON Schema validator (TBD)
 *   - `maxToolTokens` / `maxCostUsd` (streaming) → backend `usage` on chunks (TBD)
 *
 * Registry seam: v1 dispatches via caller-supplied `opts.toolHandlers`. #615
 * replaces that with a `scope.resources` lookup using the same call signature.
 */
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
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
	const trace: ToolTraceEntry[] = [];
	// Cumulative usage tallies across all iterations of this loop invocation. Used to
	// trip `maxToolTokens` / `maxCostUsd` after each backend round.
	let totalTokens = 0;
	let totalCostUsd = 0;

	// Initial conversation turns: append the user-role messages flowing IN before the
	// first backend round. System messages skipped — conventions vary (some hosts treat
	// system as ambient, not turn-scoped). Awaited so caller can observe initial state
	// before any backend round runs.
	if (conversation) {
		for (const m of messages) {
			if (m.role === 'user') {
				await conversation.append({ role: 'user', content: m.content });
			}
		}
	}

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
			if (result.finishReason !== 'tool_calls' || !calls || calls.length === 0) {
				// Terminal: model produced a final answer (stop / length / content_filter), or it
				// signaled tool_calls but emitted none. Append final assistant turn to the
				// conversation hook (if set), then pass the result through; attach the trace
				// when the caller asked for it.
				if (conversation && result.content) {
					await conversation.append({ role: 'assistant', content: result.content });
				}
				return opts.includeToolTrace ? { ...result, trace } : result;
			}

			messages.push({ role: 'assistant', content: result.content, toolCalls: calls });
			if (conversation) {
				await conversation.append({
					role: 'assistant',
					content: result.content,
					toolCalls: calls,
				});
			}

			const ctx: ToolHandlerContext = { signal: composedSignal, accounting };
			const dispatched = await dispatchToolCalls(
				calls,
				handlers,
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

			// Trace + tool messages append in CALL order regardless of completion order under
			// parallel — the trace mirrors what the model emitted, not which handler finished first.
			// Append BEFORE the abort-mode check so the failing entry is included in the
			// partial trace surfaced via `ToolHandlerError.partialTrace`.
			for (const dispatchResult of dispatched) {
				trace.push(dispatchResult.entry);
				messages.push({
					role: 'tool',
					content: dispatchResult.toolMessageContent,
					toolCallId: dispatchResult.entry.toolCallId,
				});
				if (conversation) {
					await conversation.append({
						role: 'tool',
						toolCallId: dispatchResult.entry.toolCallId,
						content: dispatchResult.toolMessageContent,
					});
				}
			}

			// `toolErrorMode: 'abort'`: any handler failure terminates the loop. Trace
			// includes the failing entry (pushed above) so the caller can see what blew
			// up. Surfaces as `ToolHandlerError` carrying the original throw on `.cause`
			// and the trace on `.partialTrace`.
			if (errorMode === 'abort') {
				const failed = dispatched.find((d) => d.originalError !== undefined);
				if (failed) {
					throw new ToolHandlerError(
						failed.entry.toolName,
						failed.entry.toolCallId,
						trace,
						failed.originalError
					);
				}
			}
		}

		// Hit `maxToolIterations` without a terminal finishReason — the model kept calling tools.
		// Always include the trace on the error path (independent of `includeToolTrace`) so
		// callers can debug an exhausted budget without re-running with tracing on.
		throw new BudgetExceededError(
			'iterations',
			`agent loop exceeded maxToolIterations=${maxIterations}`,
			trace
		);
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
			out.push(await runSingleToolCall(call, handlers, ctx, iteration, maxResultBytes));
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
		runSingleToolCall(call, handlers, ctx, iteration, maxResultBytes)
	);
	for (const p of promises) p.catch(() => {});
	return Promise.all(promises);
}

async function runSingleToolCall(
	call: ToolCall,
	handlers: Record<string, ToolHandler>,
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

	const handler = handlers[call.name];
	if (!handler) {
		// No handler registered. Hard fail — there's nothing to call. (#615 swaps this
		// branch for a `scope.resources` lookup; same call signature, same throw if
		// unresolved.) Throw as ClientError(400) since the caller didn't supply a handler
		// for a tool they declared, not a Harper-internal fault.
		throw new ClientError(
			`No handler registered for tool '${call.name}' (call id ${call.id})`,
			400
		);
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
	const trace: ToolTraceEntry[] = [];

	const loopController = new AbortController();
	const composedSignal = composeAbortSignal(callerSignal, loopController.signal);
	const innerOpts: GenerateOpts = { ...opts, toolMode: 'return', signal: composedSignal };

	// Initial conversation turns: append the user-role messages flowing IN before the
	// first backend round. System messages skipped — conventions vary (some hosts treat
	// system as ambient, not turn-scoped).
	if (conversation) {
		for (const m of messages) {
			if (m.role === 'user') {
				await conversation.append({ role: 'user', content: m.content });
			}
		}
	}

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
				// Suppress intermediate `finishReason: 'tool_calls'` from the caller —
				// the contract on `GenerateChunk` is "finishReason set on the FINAL chunk".
				// Intermediate tool-pause states are an internal loop concern; the caller
				// sees a continuous stream punctuated only by the terminal finishReason.
				if (chunk.finishReason === 'tool_calls') {
					if (chunk.deltaContent !== undefined || chunk.deltaToolCalls) {
						// Carry the deltas but drop the finishReason field for the yield.
						const cleaned: GenerateChunk = {};
						if (chunk.deltaContent !== undefined) cleaned.deltaContent = chunk.deltaContent;
						if (chunk.deltaToolCalls) cleaned.deltaToolCalls = chunk.deltaToolCalls;
						yield cleaned;
					}
					// Pure finishReason chunk on tool_calls — drop entirely.
					continue;
				}
				yield chunk;
			}

			const finalToolCalls = completeToolCallAssembly(toolCallAssembly);
			const isTerminal =
				finishReason !== 'tool_calls' || finalToolCalls.length === 0;

			if (isTerminal) {
				// Append the assistant turn (final content) to conversation before bailing.
				if (conversation && accumulatedContent) {
					await conversation.append({ role: 'assistant', content: accumulatedContent });
				}
				// Degenerate-backend guard: if the stream finished with `tool_calls` BUT no
				// assembled calls landed (provider misbehavior or upstream truncation), we
				// already suppressed the 'tool_calls' chunk under the intermediate-finishReason
				// rule above. Without a synthetic terminal chunk the consumer's `for-await`
				// ends without ever seeing a terminal `finishReason`, violating the
				// `GenerateChunk` contract. Reclassify to 'stop' and emit one chunk so the
				// stream closes cleanly.
				if (finishReason === 'tool_calls' && finalToolCalls.length === 0) {
					yield { finishReason: 'stop' };
				}
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
				ctx,
				iteration,
				maxResultBytes,
				parallelism
			);

			composedSignal.throwIfAborted();

			for (const d of dispatched) {
				trace.push(d.entry);
				messages.push({
					role: 'tool',
					content: d.toolMessageContent,
					toolCallId: d.entry.toolCallId,
				});
				if (conversation) {
					await conversation.append({
						role: 'tool',
						toolCallId: d.entry.toolCallId,
						content: d.toolMessageContent,
					});
				}
			}

			if (errorMode === 'abort') {
				const failed = dispatched.find((d) => d.originalError !== undefined);
				if (failed) {
					throw new ToolHandlerError(
						failed.entry.toolName,
						failed.entry.toolCallId,
						trace,
						failed.originalError
					);
				}
			}
		}

		throw new BudgetExceededError(
			'iterations',
			`agent loop exceeded maxToolIterations=${maxIterations}`,
			trace
		);
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
	const json = JSON.stringify(value ?? null);
	const buf = Buffer.from(json, 'utf8');
	const totalBytes = buf.length;
	if (totalBytes <= maxBytes) {
		return { content: json, totalBytes, truncated: false };
	}
	// Truncated form: head of the JSON + a marker that names the original size. The
	// content is no longer valid JSON — that's intentional, the model reads it as text
	// alongside the marker. Single-pass byte-level slice; `Buffer#toString('utf8')`
	// folds a split codepoint at the boundary into a replacement char (U+FFFD).
	// The body slice never exceeds the byte budget — no O(n²) trim loop needed for
	// multi-byte content.
	const marker = `…[truncated; full result is ${totalBytes} bytes]`;
	const markerBytes = Buffer.byteLength(marker, 'utf8');
	const headBudget = Math.max(0, maxBytes - markerBytes);
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
			cause && typeof cause === 'object' && 'statusCode' in cause && typeof (cause as { statusCode: unknown }).statusCode === 'number'
				? ((cause as { statusCode: number }).statusCode)
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
