/**
 * Anthropic backend (#633, Phase 6 of #510).
 *
 * Implements `ModelBackend` against the Anthropic HTTP API. Native `fetch` —
 * no SDK dependency, consistent with `components/openai/`. Exports
 * `AnthropicBackend` directly for tests and `registerAnthropicBackend(...)`
 * for the YAML→registry boot bridge.
 *
 * `embed` is not implemented (Anthropic doesn't ship an embedding API);
 * `capabilities()` advertises `embed: false` and Phase 1's `Models.embed`
 * throws `ModelCapabilityError` before reaching this backend.
 *
 * Key differences from OpenAI:
 * - Auth header is `x-api-key`, not `Authorization: Bearer`.
 * - `system` is a top-level request field, not a message role.
 * - `max_tokens` is required (not optional); defaults to 4096 when caller
 *   doesn't supply `opts.maxTokens`.
 * - Tool calls arrive as content blocks (`type: 'tool_use'`) inline with
 *   text blocks, not in a separate `tool_calls` field.
 * - Streaming uses named SSE events (`message_start`, `content_block_delta`,
 *   `message_delta`, etc.); we dispatch on `data.type` rather than the
 *   `event:` line header.
 */
import { setGenerative } from '../../resources/models/backendRegistry.ts';
import {
	assignFiniteTokenCount,
	composeSignal,
	normalizeOrigin,
	parseJsonResponse,
	requireCredential,
	requireModel,
} from '../../resources/models/backendHelpers.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import type {
	BackendOpts,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	Message,
	ModelBackend,
	ModelCallResult,
	ModelCapabilities,
	ToolCall,
	ToolDef,
	TokenUsage,
} from '../../resources/models/types.ts';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
// Default `max_tokens` when caller doesn't supply one. Anthropic requires this
// field on every request; 4096 is a reasonable upper bound for typical chat
// responses (well under Claude 3.x's per-model limit of 8192–32768).
const DEFAULT_MAX_TOKENS = 4096;
// Per-event SSE buffer cap. Same shape as `components/openai/index.ts`.
const MAX_SSE_BUFFER_CHARS = 1 << 20;
// Per-tool-call accumulator cap during streaming.
const MAX_TOOL_CALL_ARGS_CHARS = 1 << 20;
// Cap for upstream `error.message` we surface to operators.
const MAX_UPSTREAM_ERROR_MESSAGE_CHARS = 500;

const log = harperLogger.forComponent('anthropic').conditional;

export type AnthropicBackendKind = 'generative';

export interface AnthropicBackendConfig {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	requestTimeoutMs?: number;
}

/**
 * `ModelBackend` for Anthropic's Messages API.
 *
 * - `generate` → `POST {baseUrl}/v1/messages` (non-streaming)
 * - `generateStream` → same with `stream: true`; SSE wire format
 * - `embed` → not implemented; capability negotiation rejects the call
 *
 * `tools: true` — Anthropic has first-class tool-use support via
 * `tool_use` / `tool_result` content blocks.
 */
export class AnthropicBackend implements ModelBackend {
	readonly name = 'anthropic';
	readonly #baseUrl: string;
	readonly #defaultModel?: string;
	readonly #apiKey: string;
	readonly #requestTimeoutMs?: number;
	readonly #fetch: typeof fetch;

	constructor(config: AnthropicBackendConfig = {}, fetchImpl: typeof fetch = fetch) {
		this.#apiKey = requireCredential(config.apiKey, 'Anthropic', 'apiKey', AnthropicBackendError);
		this.#baseUrl = normalizeOrigin(config.baseUrl, { host: DEFAULT_BASE_URL, secure: true });
		this.#defaultModel = config.model;
		this.#requestTimeoutMs = config.requestTimeoutMs;
		this.#fetch = fetchImpl;
	}

	capabilities(): ModelCapabilities {
		return { embed: false, generate: true, stream: true, tools: true, adapters: false };
	}

	async generate(input: GenerateInput, opts: BackendOpts<GenerateOpts>): Promise<ModelCallResult<GenerateResult>> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generate', AnthropicBackendError);
		const body = buildMessagesRequest(model, input, opts, false);
		const res = await this.#post('/v1/messages', body, opts.signal);
		const data = await parseJsonResponse<AnthropicMessagesResponse>(
			res,
			'Anthropic /v1/messages',
			AnthropicBackendError
		);
		const { content, toolCalls } = extractContent(data.content);
		const usage: TokenUsage = {};
		assignFiniteTokenCount(usage, 'promptTokens', data.usage?.input_tokens);
		assignFiniteTokenCount(usage, 'completionTokens', data.usage?.output_tokens);
		const result: GenerateResult = {
			content,
			finishReason: mapStopReason(data.stop_reason),
		};
		if (toolCalls && toolCalls.length > 0) result.toolCalls = toolCalls;
		return { status: 'completed', output: result, usage };
	}

	async *generateStream(input: GenerateInput, opts: BackendOpts<GenerateOpts>): AsyncIterable<GenerateChunk> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generateStream', AnthropicBackendError);
		const body = buildMessagesRequest(model, input, opts, true);
		const res = await this.#post('/v1/messages', body, opts.signal);
		if (!res.body) throw new AnthropicBackendError('Anthropic /v1/messages returned no body for streaming');

		// Tool-call deltas arrive as `input_json_delta` strings inside
		// `content_block_delta` events, keyed by `index`. We accumulate per
		// content-block index and yield each tool call once at its
		// `content_block_stop`, when the full JSON is available. Phase 1's
		// contract requires `ToolCall.arguments: object`, so we never expose
		// partial strings.
		const toolBuf = new Map<number, AnthropicToolCallAccumulator>();
		let finalFinishReason: GenerateResult['finishReason'] | undefined;

		for await (const event of readSse(res.body)) {
			const chunk: GenerateChunk = {};

			// Mid-stream upstream errors (`overloaded_error`, `rate_limit_error`,
			// etc.) arrive as `event: error` / `data.type === 'error'`. Anthropic
			// closes the stream after these — silently swallowing them would
			// leave callers unable to distinguish a clean end from an aborted
			// one. Throw the backend's error, bounding any included upstream
			// message through the same cap used by `readErrorSuffix`.
			if (event.type === 'error') {
				const upstream = (event as { error?: { message?: unknown } }).error?.message;
				if (typeof upstream === 'string' && upstream.length > 0) {
					const truncated =
						upstream.length > MAX_UPSTREAM_ERROR_MESSAGE_CHARS
							? upstream.slice(0, MAX_UPSTREAM_ERROR_MESSAGE_CHARS) + '…'
							: upstream;
					throw new AnthropicBackendError(`Anthropic stream aborted by upstream error: ${truncated}`);
				}
				throw new AnthropicBackendError('Anthropic stream aborted by upstream error');
			}

			if (
				event.type === 'content_block_start' &&
				event.index !== undefined &&
				event.content_block?.type === 'tool_use'
			) {
				toolBuf.set(event.index, {
					id: event.content_block.id,
					name: event.content_block.name,
					argumentsBuf: '',
				});
			}

			if (event.type === 'content_block_delta' && event.index !== undefined && event.delta) {
				if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text.length > 0) {
					chunk.deltaContent = event.delta.text;
				} else if (event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
					const acc = toolBuf.get(event.index);
					if (acc) {
						if (acc.argumentsBuf.length + event.delta.partial_json.length > MAX_TOOL_CALL_ARGS_CHARS) {
							throw new AnthropicBackendError(
								`Anthropic tool-call arguments exceed ${MAX_TOOL_CALL_ARGS_CHARS} chars (index ${event.index})`
							);
						}
						acc.argumentsBuf += event.delta.partial_json;
					}
				}
			}

			if (event.type === 'content_block_stop' && event.index !== undefined) {
				const acc = toolBuf.get(event.index);
				if (acc && acc.id && acc.name) {
					const finalized = finalizeToolCall(acc);
					toolBuf.delete(event.index);
					if (finalized) chunk.deltaToolCalls = [finalized];
				}
			}

			if (event.type === 'message_delta' && event.delta?.stop_reason) {
				finalFinishReason = mapStopReason(event.delta.stop_reason);
				chunk.finishReason = finalFinishReason;
			}

			if (chunk.deltaContent || chunk.deltaToolCalls || chunk.finishReason) {
				yield chunk;
			}
		}

		// If the stream closed without a `message_delta` (rare; proxy hiccup),
		// flush any orphan tool calls so the caller doesn't lose them.
		if (!finalFinishReason && toolBuf.size > 0) {
			const tail: Partial<ToolCall>[] = [];
			for (const acc of toolBuf.values()) {
				if (!acc.id || !acc.name) continue;
				const finalized = finalizeToolCall(acc);
				if (finalized) tail.push(finalized);
			}
			toolBuf.clear();
			if (tail.length > 0) yield { deltaToolCalls: tail };
		}
	}

	async #post(path: string, body: object, callerSignal?: AbortSignal): Promise<Response> {
		const signal = composeSignal(callerSignal, this.#requestTimeoutMs);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'x-api-key': this.#apiKey,
			'anthropic-version': ANTHROPIC_API_VERSION,
		};
		const res = await this.#fetch(`${this.#baseUrl}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			throw new AnthropicBackendError(`Anthropic ${path} returned HTTP ${res.status}${await readErrorSuffix(res)}`);
		}
		return res;
	}
}

/**
 * Boot-bridge helper. Anthropic only registers as a generative backend
 * (`embed: false`); the `kind` field would only ever be `'generative'` —
 * surface a clear error if a config block ever tries `embedding`.
 */
export function registerAnthropicBackend(args: {
	logicalName: string;
	kind: 'embedding' | 'generative';
	config: AnthropicBackendConfig;
}): void {
	if (args.kind === 'embedding') {
		throw new AnthropicBackendError(
			'Anthropic does not provide an embedding API; remove the embedding entry or use a different backend'
		);
	}
	const backend = new AnthropicBackend(args.config);
	setGenerative(args.logicalName, backend);
}

export class AnthropicBackendError extends ServerError {
	constructor(message: string) {
		super(message);
		this.name = 'AnthropicBackendError';
	}
}

// ---------- internals ----------

async function readErrorSuffix(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { message?: unknown; type?: unknown } };
		const message = body?.error?.message;
		if (typeof message === 'string' && message.length > 0) {
			const truncated =
				message.length > MAX_UPSTREAM_ERROR_MESSAGE_CHARS
					? message.slice(0, MAX_UPSTREAM_ERROR_MESSAGE_CHARS) + '…'
					: message;
			return `: ${truncated}`;
		}
		return '';
	} catch {
		return '';
	}
}

interface BuiltMessagesRequest extends Record<string, unknown> {
	model: string;
	messages: AnthropicMessage[];
	max_tokens: number;
	stream: boolean;
	system?: string;
	tools?: AnthropicTool[];
	temperature?: number;
}

function buildMessagesRequest(
	model: string,
	input: GenerateInput,
	opts: BackendOpts<GenerateOpts>,
	stream: boolean
): BuiltMessagesRequest {
	const { messages, system } = normalizeMessages(input);
	const tools = extractTools(input);
	const body: BuiltMessagesRequest = {
		model,
		messages: messages.map(toAnthropicMessage),
		max_tokens: typeof opts.maxTokens === 'number' && opts.maxTokens > 0 ? opts.maxTokens : DEFAULT_MAX_TOKENS,
		stream,
	};
	if (system) body.system = system;
	if (tools && tools.length > 0) body.tools = tools.map(toAnthropicTool);
	if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
	// `responseFormat` is not directly supported by Anthropic's Messages API
	// (no equivalent of OpenAI's `response_format`); callers wanting JSON
	// must instruct the model via the prompt. Document and ignore.
	return body;
}

function normalizeMessages(input: GenerateInput): { messages: Message[]; system?: string } {
	if (typeof input === 'string') {
		return { messages: [{ role: 'user', content: input }] };
	}
	if (Array.isArray(input)) {
		// Extract any 'system' role messages and consolidate into top-level
		// `system` field; Anthropic forbids a 'system' role in `messages[]`.
		const system: string[] = [];
		const rest: Message[] = [];
		for (const m of input) {
			if (m.role === 'system') system.push(m.content);
			else rest.push(m);
		}
		return system.length > 0 ? { messages: rest, system: system.join('\n\n') } : { messages: rest };
	}
	const explicit = input.system;
	const inlineSystems: string[] = [];
	const rest: Message[] = [];
	for (const m of input.messages) {
		if (m.role === 'system') inlineSystems.push(m.content);
		else rest.push(m);
	}
	const combined = [explicit, ...inlineSystems]
		.filter((s): s is string => typeof s === 'string' && s.length > 0)
		.join('\n\n');
	return combined.length > 0 ? { messages: rest, system: combined } : { messages: rest };
}

function extractTools(input: GenerateInput): ToolDef[] | undefined {
	if (typeof input === 'string' || Array.isArray(input)) return undefined;
	return input.tools;
}

interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
	type: 'text' | 'tool_use' | 'tool_result';
	text?: string;
	id?: string;
	name?: string;
	input?: object;
	tool_use_id?: string;
	content?: string | AnthropicContentBlock[];
}

function toAnthropicMessage(m: Message): AnthropicMessage {
	if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') {
		// 'system' is normalized out above; anything unexpected goes through
		// as 'user' for safety. Anthropic will reject invalid roles.
		return { role: 'user', content: m.content };
	}
	if (m.role === 'tool') {
		// Tool result message: Anthropic represents these as `tool_result`
		// content blocks inside a `user` role message, referenced by
		// `tool_use_id` (matches Phase 1's `Message.toolCallId`).
		return {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: m.toolCallId ?? '',
					content: m.content,
				},
			],
		};
	}
	if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
		// Mixed assistant message: text + tool_use blocks. Phase 1 keeps
		// `Message.content` separate from `Message.toolCalls`; Anthropic
		// represents both as a content blocks array.
		const blocks: AnthropicContentBlock[] = [];
		if (m.content) blocks.push({ type: 'text', text: m.content });
		for (const tc of m.toolCalls) {
			blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
		}
		return { role: 'assistant', content: blocks };
	}
	return { role: m.role, content: m.content };
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: object;
}

function toAnthropicTool(t: ToolDef): AnthropicTool {
	return { name: t.name, description: t.description, input_schema: t.parameters };
}

function mapStopReason(reason?: string | null): GenerateResult['finishReason'] {
	switch (reason) {
		case 'max_tokens':
			return 'length';
		case 'tool_use':
			return 'tool_calls';
		case 'end_turn':
		case 'stop_sequence':
		default:
			return 'stop';
	}
}

function extractContent(blocks: AnthropicContentBlock[] | undefined): { content: string; toolCalls?: ToolCall[] } {
	if (!blocks || blocks.length === 0) return { content: '' };
	const text: string[] = [];
	const toolCalls: ToolCall[] = [];
	for (const block of blocks) {
		if (block.type === 'text' && typeof block.text === 'string') {
			text.push(block.text);
		} else if (block.type === 'tool_use' && block.id && block.name) {
			// Anthropic returns `input` as a parsed object — no JSON.parse needed.
			const input = block.input && typeof block.input === 'object' ? block.input : {};
			toolCalls.push({ id: block.id, name: block.name, arguments: input });
		}
	}
	const result: { content: string; toolCalls?: ToolCall[] } = { content: text.join('') };
	if (toolCalls.length > 0) result.toolCalls = toolCalls;
	return result;
}

interface AnthropicToolCallAccumulator {
	id: string;
	name: string;
	argumentsBuf: string;
}

function finalizeToolCall(acc: AnthropicToolCallAccumulator): Partial<ToolCall> | undefined {
	try {
		const args = acc.argumentsBuf.length > 0 ? JSON.parse(acc.argumentsBuf) : {};
		return { id: acc.id, name: acc.name, arguments: args };
	} catch {
		// Static-message log on malformed JSON; matches the openai backend's
		// posture. Drop the call rather than crash the stream.
		log.warn?.(`Anthropic tool call dropped: malformed arguments (id=${acc.id}, name=${acc.name})`);
		return undefined;
	}
}

/**
 * Read Anthropic's SSE wire format. Same framing as OpenAI's (events
 * separated by `\n\n`, `data:` lines carry JSON). Anthropic adds named
 * `event:` lines but we dispatch off `data.type` which is more reliable.
 * `event: ping` and any non-`data:` line are skipped naturally.
 *
 * No explicit `[DONE]` terminator — the stream ends when the server closes
 * the connection after `message_stop`.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AnthropicStreamEvent> {
	const decoder = new TextDecoder('utf-8');
	let buf = '';
	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
		buf += decoder.decode(chunk, { stream: true });
		if (buf.length > MAX_SSE_BUFFER_CHARS) {
			throw new AnthropicBackendError(
				`Anthropic SSE buffer exceeds ${MAX_SSE_BUFFER_CHARS} chars without a complete event`
			);
		}
		let boundary: number;
		while ((boundary = buf.indexOf('\n\n')) >= 0) {
			const eventBlock = buf.slice(0, boundary);
			buf = buf.slice(boundary + 2);
			const parsed = parseSseEvent(eventBlock);
			if (parsed) yield parsed;
		}
	}
	buf += decoder.decode();
	const tail = buf.trim();
	if (tail) {
		const parsed = parseSseEvent(tail);
		if (parsed) yield parsed;
	}
}

function parseSseEvent(block: string): AnthropicStreamEvent | null {
	let data = '';
	for (const rawLine of block.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
		const payload = line.slice(5).replace(/^ /, '');
		data = data ? data + '\n' + payload : payload;
	}
	if (!data) return null;
	try {
		return JSON.parse(data) as AnthropicStreamEvent;
	} catch {
		throw new AnthropicBackendError('Invalid SSE data line from Anthropic');
	}
}

// ---------- Anthropic wire types (subset we actually read) ----------

interface AnthropicMessagesResponse {
	id?: string;
	type?: string;
	role?: string;
	content?: AnthropicContentBlock[];
	model?: string;
	stop_reason?: string | null;
	usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicStreamEvent {
	type:
		| 'message_start'
		| 'content_block_start'
		| 'content_block_delta'
		| 'content_block_stop'
		| 'message_delta'
		| 'message_stop'
		| 'ping'
		| 'error';
	index?: number;
	content_block?: AnthropicContentBlock;
	delta?: {
		type?: 'text_delta' | 'input_json_delta';
		text?: string;
		partial_json?: string;
		stop_reason?: string | null;
		stop_sequence?: string | null;
	};
	usage?: { output_tokens?: number };
}
