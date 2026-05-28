/**
 * Public type surface for the model-access API (`scope.models`).
 *
 * Phase 1 foundation of #510. Other phases (ollama, openai, gateway, @embed,
 * anthropic, bedrock) consume these types; changes here cascade.
 *
 * Reference: planning artifact `tmp/harper-510-phase-1-detail.md` (canonical shapes).
 */

export interface Models {
	embed(input: string | string[], opts?: EmbedOpts): Promise<Float32Array[]>;
	generate(input: GenerateInput, opts?: GenerateOpts): Promise<GenerateResult>;
	generateStream(input: GenerateInput, opts?: GenerateOpts): AsyncIterable<GenerateChunk>;
}

export interface ModelBackend {
	readonly name: string;
	capabilities(): ModelCapabilities;
	embed?(input: string | string[], opts: BackendOpts<EmbedOpts>): Promise<ModelCallResult<Float32Array[]>>;
	generate?(input: GenerateInput, opts: BackendOpts<GenerateOpts>): Promise<ModelCallResult<GenerateResult>>;
	generateStream?(input: GenerateInput, opts: BackendOpts<GenerateOpts>): AsyncIterable<GenerateChunk>;
}

export interface ModelCapabilities {
	embed: boolean;
	generate: boolean;
	stream: boolean;
	tools: boolean;
	adapters: boolean;
}

export type EmbedOpts = {
	model?: string;
	/** For models that distinguish document-vs-query embeddings (e.g. nomic-embed-text); ignored otherwise. */
	inputType?: 'document' | 'query';
	signal?: AbortSignal;
};

export type GenerateOpts = {
	model?: string;
	adapter?: string;
	temperature?: number;
	maxTokens?: number;
	responseFormat?: 'text' | 'json' | { schema: object };
	/**
	 * How to handle tool calls the model emits. `'return'` (default) hands tool-call
	 * requests back to the caller; `'auto'` resolves them in-process to completion.
	 * The tool definitions themselves live on `GenerateInput`'s object variant
	 * (alongside `messages` and `system`) — they're content, not strategy.
	 */
	toolMode?: 'return' | 'auto';
	/**
	 * `toolMode: 'auto'` only. Hard cap on backend → tool → backend iterations
	 * before the loop emits `BudgetExceededError({kind: 'iterations'})`. Default 10.
	 */
	maxToolIterations?: number;
	/**
	 * `toolMode: 'auto'` only. Cumulative prompt+completion token cap across all
	 * iterations. Trips `BudgetExceededError({kind: 'tokens'})` when exceeded.
	 */
	maxToolTokens?: number;
	/**
	 * `toolMode: 'auto'` only. Cumulative cost cap across all iterations. The v1
	 * cost-per-call function returns 0 (no rate card yet) so this trips only when
	 * a test or follow-up wires a non-zero function — the seam is in place.
	 */
	maxCostUsd?: number;
	/**
	 * `toolMode: 'auto'` only. When a single backend round emits multiple tool calls,
	 * `'parallel'` (default) runs handlers concurrently via `Promise.all`; `'serial'`
	 * runs them in order. Each handler is its own dispatch — no shared transaction.
	 */
	toolParallelism?: 'parallel' | 'serial';
	/**
	 * `toolMode: 'auto'` only. Per-tool-result byte cap (JSON-stringified) before
	 * truncation. The model sees only the truncated form; the trace records the
	 * original size. Default 65_536.
	 */
	toolResultMaxBytes?: number;
	/**
	 * `toolMode: 'auto'` only. How to validate tool-call arguments against the
	 * tool's `parameters` JSON Schema. `'strict'` (default) throws on failure;
	 * `'lenient'` coerces / drops bad fields; `'none'` passes through unchecked.
	 */
	toolArgValidation?: 'strict' | 'lenient' | 'none';
	/**
	 * `toolMode: 'auto'` only. When a tool handler throws, `'recover'` (default)
	 * appends the error as a tool result so the model can react; `'abort'` returns
	 * the error to the caller with the full trace attached.
	 */
	toolErrorMode?: 'recover' | 'abort';
	/**
	 * `toolMode: 'auto'` only. When true, the resolved `GenerateResult.trace` is
	 * populated with per-iteration entries. On error paths the trace is always
	 * returned (via `BudgetExceededError.partialTrace`) regardless of this flag.
	 */
	includeToolTrace?: boolean;
	/**
	 * `toolMode: 'auto'` only. Caller-supplied dispatch table keyed by tool name.
	 * The model emits a tool call → loop looks up the handler here. v1 contract;
	 * the registry seam (#615) replaces this with a `scope.resources` lookup.
	 */
	toolHandlers?: Record<string, ToolHandler>;
	/**
	 * `toolMode: 'auto'` only. Optional hook called as turns flow through the loop
	 * (user → assistant → tool → assistant → ...). Structural shape — not coupled
	 * to #511's `ConversationResource` so callers can plug in their own store.
	 */
	conversation?: ConversationAppender;
	/** Accepted in Phase 1; activates with #511 (ConversationResource). */
	conversationId?: string;
	signal?: AbortSignal;
};

/**
 * Generation input. Tools and system prompt live here (with `messages`) because
 * they are model-facing content. Caller must use the object form to supply tools:
 * `{ messages, tools, system }`.
 */
export type GenerateInput = string | Message[] | { messages: Message[]; tools?: ToolDef[]; system?: string };

/** Options handed to a backend: caller-supplied opts plus runtime accounting context. */
export type BackendOpts<TOpts> = TOpts & { accounting: AccountingContext };

export interface AccountingContext {
	/** Free-form tenant identifier (v1). Pending canonical model from #510 comment thread. */
	tenantId?: string;
	/** Resource path (e.g. matched route) of the calling Resource, if any. */
	app?: string;
}

/**
 * Backend call result.
 *
 * `pending` is reserved for future long-running operations (Bedrock batch, fabric LROs);
 * no Phase 1 backend emits it. The public `Models` facade unwraps `completed` and
 * matches #510's `Promise<Float32Array[]>` / `Promise<GenerateResult>` signatures,
 * throwing if a backend returns `pending` until the LRO surface is added.
 */
export type ModelCallResult<T> =
	| { status: 'completed'; output: T; usage?: TokenUsage }
	| { status: 'pending'; operationId: string; resumeAfter?: number };

export interface TokenUsage {
	promptTokens?: number;
	completionTokens?: number;
	embeddingTokens?: number;
	gpuMs?: number;
	latencyMs?: number;
}

export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** When `role === 'assistant'`: tool calls the model requested. */
	toolCalls?: ToolCall[];
	/** When `role === 'tool'`: id of the tool call this message responds to. */
	toolCallId?: string;
}

export interface ToolDef {
	name: string;
	description: string;
	/** JSON Schema for the tool's input. */
	parameters: object;
}

export interface ToolCall {
	id: string;
	name: string;
	/** Parsed tool input. Backends that deliver stringified JSON (OpenAI) normalize before yielding. */
	arguments: object;
}

export interface GenerateResult {
	content: string;
	toolCalls?: ToolCall[];
	/** Why generation stopped. Backend-agnostic; backends map their native reasons. */
	finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
	/**
	 * `toolMode: 'auto'` only, and only when `includeToolTrace: true` (or when an
	 * error path attaches `partialTrace` via `BudgetExceededError`). One entry per
	 * tool invocation, in the order it ran.
	 */
	trace?: ToolTraceEntry[];
}

/**
 * Per-tool-invocation record emitted by the `toolMode: 'auto'` loop. Entries land
 * on `GenerateResult.trace` (success path, when `includeToolTrace`) or on
 * `BudgetExceededError.partialTrace` (any error path). Always in invocation order.
 */
export interface ToolTraceEntry {
	/** 1-based iteration index — which backend round this tool call belongs to. */
	iteration: number;
	toolCallId: string;
	toolName: string;
	arguments: object;
	/** JSON-stringified result, possibly truncated. Absent on handler error. */
	result?: string;
	/** True when `result` was clipped to `toolResultMaxBytes`. */
	truncated?: boolean;
	/** Pre-truncation byte length of the JSON-stringified result. */
	totalBytes?: number;
	/** Wall-clock duration of the handler call. */
	durationMs: number;
	/** Set when the handler threw. The loop's `toolErrorMode` decides recovery. */
	error?: { name: string; message: string };
}

/**
 * Context handed to a `ToolHandler`. v1: caller-supplied dispatch table. The
 * `signal` is the composed iteration-level signal (caller signal ∪ budget-trip
 * cancellation), so a long-running handler stops promptly when the loop trips a cap.
 */
export interface ToolHandlerContext {
	signal?: AbortSignal;
	accounting: AccountingContext;
}

/**
 * Caller-supplied tool implementation. Return value is JSON-serialized into a
 * `tool`-role message and fed back to the model on the next iteration. Throws are
 * caught by the loop and routed by `toolErrorMode` (`'recover'` | `'abort'`).
 */
export type ToolHandler = (args: object, ctx: ToolHandlerContext) => unknown | Promise<unknown>;

/**
 * Optional hook the loop calls as conversation turns flow. Structural so the
 * built-in `ConversationResource` (#511) AND ad-hoc stores can satisfy it.
 */
export interface ConversationAppender {
	append(turn: ConversationTurn): Promise<void>;
}

export type ConversationTurn =
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
	| { role: 'tool'; toolCallId: string; content: string };

export interface GenerateChunk {
	/** Incremental text appended since the previous chunk. */
	deltaContent?: string;
	/**
	 * Tool-call deltas accumulating across chunks. A streaming backend may deliver
	 * the same tool-call id multiple times with partial fields as it builds up.
	 */
	deltaToolCalls?: Partial<ToolCall>[];
	/** Set on the final chunk. */
	finishReason?: GenerateResult['finishReason'];
}
