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
}

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
