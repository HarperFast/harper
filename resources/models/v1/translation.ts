/**
 * OpenAI ↔ Harper internal shape mappers for the `/v1/*` gateway (#631).
 *
 * All functions are pure (no I/O, no side-effects) so they can be unit-tested
 * in isolation without a running Harper instance.
 */

import { randomUUID } from 'node:crypto';
import type {
	EmbedOpts,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	Message,
	ToolCall,
	ToolDef,
	TokenUsage,
} from '../types.ts';

// ---------------------------------------------------------------------------
// OpenAI wire shapes — inlined to avoid a runtime dependency on the SDK
// ---------------------------------------------------------------------------

export interface OAIMessageIn {
	role: string;
	/** May be null for assistant messages that only contain tool_calls. */
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: string;
		function: { name: string; arguments: string };
	}>;
	/** Present on role === 'tool' messages. */
	tool_call_id?: string;
}

export interface OAIToolIn {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: object;
	};
}

export interface OAIChatRequest {
	model?: string;
	messages: OAIMessageIn[];
	tools?: OAIToolIn[];
	/** Subset recognised: 'none' | 'auto' | 'required' | {type:'function', function:{name}}. */
	tool_choice?: unknown;
	temperature?: number;
	/** OpenAI v1 field; superseded by max_completion_tokens in v1+. */
	max_tokens?: number;
	/** Preferred alias; takes precedence over max_tokens when both present. */
	max_completion_tokens?: number;
	response_format?: { type: string; json_schema?: unknown };
	stream?: boolean;
}

// ---------------------------------------------------------------------------
// OpenAI request → Harper internal
// ---------------------------------------------------------------------------

/**
 * Map an OpenAI `messages` array to Harper `Message[]`.
 * Normalises `tool_calls[].function.arguments` from JSON strings to parsed
 * objects (Harper's internal contract); maps `tool_call_id` to `toolCallId`.
 */
export function translateMessages(oaiMessages: OAIMessageIn[]): Message[] {
	return oaiMessages.map((m): Message => {
		const base: Message = {
			role: m.role as Message['role'],
			content: m.content ?? '',
		};
		if (m.tool_calls?.length) {
			base.toolCalls = m.tool_calls.map((tc): ToolCall => {
				let args: object;
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					// Preserve unparseable argument strings under a sentinel key rather
					// than dropping them — backend can decide what to do.
					args = { _raw: tc.function.arguments };
				}
				return { id: tc.id, name: tc.function.name, arguments: args };
			});
		}
		if (m.tool_call_id) base.toolCallId = m.tool_call_id;
		return base;
	});
}

/** Map OpenAI `tools[]` to Harper `ToolDef[]`. */
export function translateTools(oaiTools: OAIToolIn[]): ToolDef[] {
	return oaiTools.map((t): ToolDef => ({
		name: t.function.name,
		description: t.function.description ?? '',
		parameters: t.function.parameters ?? {},
	}));
}

/**
 * Build Harper `GenerateInput` from translated messages and tool definitions.
 * Uses the object form `{ messages, tools }` when tools are present, so that
 * tool definitions travel alongside messages per Harper's type contract.
 */
export function toGenerateInput(messages: Message[], tools: ToolDef[] | undefined): GenerateInput {
	if (tools?.length) return { messages, tools };
	return messages;
}

/** `tool_choice` values the internal contract can faithfully represent. */
function isRepresentableToolChoice(choice: unknown): boolean {
	return choice === undefined || choice === null || choice === 'auto' || choice === 'none';
}

/**
 * Validate the OpenAI wire shapes this gateway maps, returning a client-facing
 * message for a 400 or `null` when the request is well-formed.
 *
 * Kept separate from the mappers so malformed nested input (`messages: [null]`,
 * `tool_calls: [{}]`, `tools: [{}]`) becomes an OpenAI-shaped 400 instead of a
 * TypeError escaping the handler as an RFC 9457 500.
 */
export function validateChatRequest(body: OAIChatRequest): string | null {
	const req = body as any;
	if (!Array.isArray(req.messages) || req.messages.length === 0) return "'messages' must be a non-empty array";
	for (let i = 0; i < req.messages.length; i++) {
		const m = req.messages[i];
		if (!m || typeof m !== 'object' || Array.isArray(m)) return `'messages[${i}]' must be an object`;
		if (typeof m.role !== 'string') return `'messages[${i}].role' must be a string`;
		if (m.tool_calls !== undefined) {
			if (!Array.isArray(m.tool_calls)) return `'messages[${i}].tool_calls' must be an array`;
			for (let j = 0; j < m.tool_calls.length; j++) {
				const tc = m.tool_calls[j];
				const at = `'messages[${i}].tool_calls[${j}]`;
				if (!tc || typeof tc !== 'object') return `${at}' must be an object`;
				if (!tc.function || typeof tc.function !== 'object') return `${at}.function' is required`;
				if (typeof tc.function.name !== 'string') return `${at}.function.name' must be a string`;
				if (typeof tc.function.arguments !== 'string') return `${at}.function.arguments' must be a JSON string`;
			}
		}
	}
	if (req.tools !== undefined) {
		if (!Array.isArray(req.tools)) return "'tools' must be an array";
		for (let i = 0; i < req.tools.length; i++) {
			const t = req.tools[i];
			if (!t || typeof t !== 'object') return `'tools[${i}]' must be an object`;
			if (!t.function || typeof t.function !== 'object') return `'tools[${i}].function' is required`;
			if (typeof t.function.name !== 'string') return `'tools[${i}].function.name' must be a string`;
		}
	}
	if (!isRepresentableToolChoice(req.tool_choice)) {
		// Better a clear 400 than silently downgrading 'required'/named selection to 'auto'.
		return "'tool_choice' supports 'auto' and 'none'; 'required' and named function selection are not supported yet";
	}
	if (req.response_format !== undefined) {
		const rf = req.response_format;
		if (!rf || typeof rf !== 'object' || Array.isArray(rf)) return "'response_format' must be an object";
		if (rf.type === 'json_schema') {
			const wrapper = rf.json_schema;
			if (!wrapper || typeof wrapper !== 'object') {
				return "'response_format.json_schema' is required when type is 'json_schema'";
			}
			if (!wrapper.schema || typeof wrapper.schema !== 'object') {
				return "'response_format.json_schema.schema' must be a JSON Schema object";
			}
		}
	}
	return null;
}

/**
 * Map an OpenAI chat-completion request body to `GenerateOpts`.
 *
 * `tool_choice` is honored by the caller, not here: `'none'` omits tools from the
 * generate input entirely, and unrepresentable choices are rejected up front by
 * `validateChatRequest`. Full in-process tool-call orchestration is #612 (out of
 * scope for #631), so tool calls are always returned to the caller to invoke.
 *
 * Assumes `validateChatRequest` has already passed.
 */
export function toGenerateOpts(body: OAIChatRequest): GenerateOpts {
	const opts: GenerateOpts = { toolMode: 'return' };
	if (typeof body.model === 'string') opts.model = body.model;
	if (typeof body.temperature === 'number') opts.temperature = body.temperature;
	const maxTokens = body.max_completion_tokens ?? body.max_tokens;
	if (typeof maxTokens === 'number') opts.maxTokens = maxTokens;
	if (body.response_format) {
		const rf = body.response_format;
		if (rf.type === 'json_object') {
			opts.responseFormat = 'json';
		} else if (rf.type === 'json_schema') {
			// The wire value is a wrapper ({ name, strict, schema }); Harper's contract wants
			// the JSON Schema itself. Passing the wrapper makes the backend wrap it again and
			// send metadata where the provider expects the schema.
			opts.responseFormat = { schema: (rf.json_schema as { schema: object }).schema };
		} else {
			opts.responseFormat = 'text';
		}
	}
	return opts;
}

/** Map an OpenAI embeddings request body to `EmbedOpts`. */
export function toEmbedOpts(body: { model?: string }): EmbedOpts {
	const opts: EmbedOpts = {};
	if (typeof body.model === 'string') opts.model = body.model;
	return opts;
}

// ---------------------------------------------------------------------------
// Harper internal → OpenAI response shapes
// ---------------------------------------------------------------------------

interface OAIToolCallOut {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

interface OAIAssistantMessage {
	role: 'assistant';
	/** null when the message contains only tool_calls. */
	content: string | null;
	tool_calls?: OAIToolCallOut[];
}

export interface OAIChatCompletion {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: OAIAssistantMessage;
		finish_reason: string;
	}>;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

function toOAIToolCalls(toolCalls: ToolCall[]): OAIToolCallOut[] {
	return toolCalls.map((tc) => ({
		id: tc.id,
		type: 'function',
		// Guard against backends that return arguments as a pre-serialised JSON string;
		// passing a string through JSON.stringify would double-encode it.
		function: {
			name: tc.name,
			arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
		},
	}));
}

/** Map a Harper `GenerateResult` to an OpenAI `chat.completion` response object. */
export function toChatCompletion(result: GenerateResult, model: string, id?: string): OAIChatCompletion {
	const completionId = id ?? `chatcmpl-${randomUUID().replaceAll('-', '')}`;
	const hasTools = !!result.toolCalls?.length;
	const message: OAIAssistantMessage = {
		role: 'assistant',
		// OpenAI sets content to null when there are tool calls and no text content.
		content: result.content || (hasTools ? null : ''),
	};
	if (hasTools) message.tool_calls = toOAIToolCalls(result.toolCalls!);
	const usage = result.usage ?? {};
	return {
		id: completionId,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: result.finishReason }],
		usage: {
			prompt_tokens: usage.promptTokens ?? 0,
			completion_tokens: usage.completionTokens ?? 0,
			total_tokens: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
		},
	};
}

export interface OAIEmbedResponse {
	object: 'list';
	data: Array<{ embedding: number[]; index: number; object: 'embedding' }>;
	model: string;
	usage: { prompt_tokens: number; total_tokens: number };
}

/** Map `Float32Array[]` from `models.embed()` to an OpenAI embeddings response. */
export function toEmbedResponse(vecs: Float32Array[], model: string, usage?: TokenUsage): OAIEmbedResponse {
	return {
		object: 'list',
		data: vecs.map((vec, index) => ({
			embedding: Array.from(vec),
			index,
			object: 'embedding',
		})),
		model,
		usage: {
			prompt_tokens: usage?.promptTokens ?? 0,
			// OpenAI uses `embeddingTokens` aliased here; fall back to promptTokens.
			total_tokens: usage?.embeddingTokens ?? usage?.promptTokens ?? 0,
		},
	};
}
