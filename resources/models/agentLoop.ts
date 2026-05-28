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
 * Commit 3 of #612 — parallel batch dispatch (Promise.all, default) + caller-signal
 * propagation + iteration-boundary `throwIfAborted`. Modes deferred to later
 * commits throw 501 at entry:
 *   - `toolArgValidation: 'strict' | 'lenient'`  → JSON Schema validator (TBD)
 *   - `toolErrorMode: 'abort'`                   → commit 4
 *   - `maxToolTokens`, `maxCostUsd`              → commit 4
 *   - `opts.conversation.append`                 → commit 5
 *   - `runAgentLoopStream`                       → commit 5
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

	const { messages, tools, system } = normalizeInput(args.input);
	const trace: ToolTraceEntry[] = [];

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

			const calls = result.toolCalls;
			if (result.finishReason !== 'tool_calls' || !calls || calls.length === 0) {
				// Terminal: model produced a final answer (stop / length / content_filter), or it
				// signaled tool_calls but emitted none. Pass the result through; attach the trace
				// when the caller asked for it.
				return opts.includeToolTrace ? { ...result, trace } : result;
			}

			messages.push({ role: 'assistant', content: result.content, toolCalls: calls });

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
			for (const dispatchResult of dispatched) {
				trace.push(dispatchResult.entry);
				messages.push({
					role: 'tool',
					content: dispatchResult.toolMessageContent,
					toolCallId: dispatchResult.entry.toolCallId,
				});
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
	// Promise.all path adds nothing on one element and the serial path's stack trace
	// is more readable in errors.
	if (parallelism === 'serial' || calls.length <= 1) {
		const out: DispatchedToolCall[] = [];
		for (const call of calls) {
			out.push(await runSingleToolCall(call, handlers, ctx, iteration, maxResultBytes));
		}
		return out;
	}
	// Parallel: handlers race concurrently. If any throws (missing handler is the only
	// path that throws out of `runSingleToolCall` — handler errors are caught and
	// recovered), Promise.all rejects with the first error. Siblings still running keep
	// going in the background; their results are discarded. That's acceptable because
	// (a) handler errors are recovered inline, so siblings rarely throw, and (b) the
	// alternative (active cancellation via loopController) would also race in the same
	// window. The composed signal still propagates external aborts to the siblings.
	return Promise.all(
		calls.map((call) => runSingleToolCall(call, handlers, ctx, iteration, maxResultBytes))
	);
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
		// `toolErrorMode: 'recover'` (v1 only path): append the error message as the
		// tool result so the model can react. Commit 4 wires 'abort' to throw early.
		entry.error = errorInfo(err);
		toolMessageContent = JSON.stringify({ error: entry.error.message });
	}
	entry.durationMs = performance.now() - handlerStart;

	return { entry, toolMessageContent };
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

export async function* runAgentLoopStream(_args: RunAgentLoopArgs): AsyncIterable<GenerateChunk> {
	throw new ServerError("`toolMode: 'auto'` is not yet implemented for streaming", 501);
}

function guardUnsupportedModes(opts: GenerateOpts): void {
	const validationMode = opts.toolArgValidation ?? 'none';
	if (validationMode !== 'none') {
		throw new ServerError(
			`toolArgValidation: '${validationMode}' is not yet implemented; v1 supports 'none' only`,
			501
		);
	}
	const errorMode = opts.toolErrorMode ?? 'recover';
	if (errorMode !== 'recover') {
		throw new ServerError(
			`toolErrorMode: '${errorMode}' is not yet implemented; v1 supports 'recover' only`,
			501
		);
	}
	// `toolParallelism` accepts 'serial' OR 'parallel' here; commit 3 wires the parallel
	// branch. v1 runs serial regardless of caller setting — the field is forward-looking.
	if (opts.maxToolTokens !== undefined || opts.maxCostUsd !== undefined) {
		throw new ServerError(
			`maxToolTokens / maxCostUsd budgets are not yet implemented (commit 4 of #612)`,
			501
		);
	}
	if (opts.conversation !== undefined) {
		throw new ServerError(
			`opts.conversation is not yet implemented (commit 5 of #612)`,
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
