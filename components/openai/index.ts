/**
 * OpenAI backend (#630, Phase 3 of #510).
 *
 * Implements `ModelBackend` against the OpenAI HTTP API (or any
 * OpenAI-compatible endpoint via `baseUrl` override — Azure OpenAI,
 * Together AI, OpenRouter, vLLM's OpenAI shim, etc.). Exports `OpenAIBackend`
 * directly for tests and `registerOpenAIBackend(...)` for the YAML→registry
 * boot bridge in `resources/models/bootstrap.ts`.
 *
 * Component shape matches the pattern in `components/mcp/index.ts` (PR #649)
 * and `components/ollama/index.ts` (PR #651): core imports a register helper
 * and calls it during boot; not a `handleApplication(scope)` self-loader.
 *
 * Native fetch is used directly — no SDK dependency. The OpenAI wire format
 * we touch (`POST /embeddings`, `POST /chat/completions` with SSE streaming
 * + tool calls) has been stable for 2+ years on the fields we read; the
 * mapping is mechanical.
 */
import { setEmbedding, setGenerative } from '../../resources/models/backendRegistry.ts';
import {
	assignFiniteTokenCount,
	composeSignal,
	MAX_ERROR_BODY_BYTES,
	normalizeOrigin,
	parseJsonResponse,
	readBoundedJson,
	requireCredential,
	requireModel,
} from '../../resources/models/backendHelpers.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import type {
	BackendOpts,
	EmbedOpts,
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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
// SSE accumulator buffer cap. Measured in JS string length (UTF-16 code units),
// not bytes — for ASCII content the two are equal; for non-ASCII the check is
// conservative (trips sooner than a true byte cap would). OpenAI chunks are
// sub-KiB; anything larger is pathological.
const MAX_SSE_BUFFER_CHARS = 1 << 20;
// Per-tool-call argument-buffer cap during streaming. OpenAI's largest real
// tool-call argument payloads are a few KiB; capping at 1 MiB defends against
// a malicious or buggy OpenAI-compatible upstream emitting unbounded argument
// deltas (which the per-event SSE cap doesn't catch on its own — each event
// can be sub-MiB while the cumulative accumulator grows).
const MAX_TOOL_CALL_ARGS_CHARS = 1 << 20;
// Cap on the upstream `error.message` we pull into our thrown error for
// operator debugging. OpenAI's real error messages are well under this; the
// cap defends against a misbehaving compat shim that returns megabytes of
// "error" prose.
const MAX_UPSTREAM_ERROR_MESSAGE_CHARS = 500;
// Maximum number of distinct tool-call accumulator entries. OpenAI keys by
// upstream-controlled `delta.index`; without a cardinality cap a hostile
// upstream can allocate unbounded map entries (one per index value). Real
// responses use single-digit counts.
const MAX_TOOL_CALL_ACCUMULATOR_ENTRIES = 128;
// Total tool-call argument chars across all entries in one stream. The per-entry
// cap (1 MiB) plus the 128-entry cap still allows ~128 MiB accumulated; this cap
// keeps any single stream well-bounded. Real responses use tens of KB.
const MAX_TOTAL_TOOL_CALL_ARGS_CHARS = 8 * 1024 * 1024; // 8 MiB

const log = harperLogger.forComponent('openai').conditional;

export type OpenAIBackendKind = 'embedding' | 'generative';

export interface OpenAIBackendConfig {
	/** Bearer token for the upstream API. Required. */
	apiKey?: string;
	/** Default model when the caller doesn't pass `opts.model`. */
	model?: string;
	/** Base URL of the OpenAI-compatible endpoint (default `https://api.openai.com/v1`). */
	baseUrl?: string;
	/** Per-request timeout. When set, combined with `opts.signal` via `AbortSignal.any`. */
	requestTimeoutMs?: number;
	/** Forwarded as `OpenAI-Organization` header when set. */
	organization?: string;
}

/**
 * `ModelBackend` implementation talking to OpenAI's HTTP API (or any
 * OpenAI-compatible endpoint).
 *
 * - `embed` → `POST {baseUrl}/embeddings`
 * - `generate` → `POST {baseUrl}/chat/completions` (always chat shape)
 * - `generateStream` → same with `stream: true`; consumes SSE wire format and
 *   yields `GenerateChunk` per delta.
 *
 * Capabilities advertise `tools: true` — first backend with native tool-call
 * support. `adapters: false` — OpenAI doesn't expose LoRA adapter selection
 * externally. `toolMode: 'return'` (Phase 1 default) is supported end-to-end;
 * `toolMode: 'auto'` is reserved for #612.
 */
export class OpenAIBackend implements ModelBackend {
	readonly name = 'openai';
	readonly #baseUrl: string;
	readonly #defaultModel?: string;
	readonly #apiKey: string;
	readonly #organization?: string;
	readonly #requestTimeoutMs?: number;
	readonly #fetch: typeof fetch;
	// True only when talking to api.openai.com itself. OpenAI's reasoning models
	// (o-series, gpt-5 family) reject `max_tokens` in favour of `max_completion_tokens`;
	// OpenAI-compatible shims (vLLM, Ollama-compat, older gateways) only know `max_tokens`.
	readonly #isNativeOpenAI: boolean;

	constructor(config: OpenAIBackendConfig = {}, fetchImpl: typeof fetch = fetch) {
		this.#apiKey = requireCredential(config.apiKey, 'OpenAI', 'apiKey', OpenAIBackendError);
		this.#baseUrl = normalizeOrigin(config.baseUrl, { host: DEFAULT_BASE_URL, secure: true });
		try {
			this.#isNativeOpenAI = new URL(this.#baseUrl).hostname === 'api.openai.com';
		} catch {
			this.#isNativeOpenAI = false;
		}
		this.#defaultModel = config.model;
		this.#organization = config.organization;
		this.#requestTimeoutMs = config.requestTimeoutMs;
		this.#fetch = fetchImpl;
	}

	capabilities(): ModelCapabilities {
		return { embed: true, generate: true, stream: true, tools: true, adapters: false };
	}

	async embed(input: string | string[], opts: BackendOpts<EmbedOpts>): Promise<ModelCallResult<Float32Array[]>> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'embed', OpenAIBackendError);
		// inputType is honored as a hint but OpenAI's embedding models don't
		// currently differentiate by it on the wire — pass through unchanged.
		const texts = Array.isArray(input) ? input : [input];
		const body: Record<string, unknown> = { model, input: texts };
		const res = await this.#post('/embeddings', body, opts.signal);
		const data = await parseJsonResponse<OpenAIEmbedResponse>(res, 'OpenAI /embeddings', OpenAIBackendError);
		if (!Array.isArray(data.data)) {
			throw new OpenAIBackendError("OpenAI /embeddings response missing 'data' array");
		}
		if (data.data.length !== texts.length) {
			throw new OpenAIBackendError(
				`OpenAI /embeddings returned ${data.data.length} vectors for ${texts.length} inputs`
			);
		}
		// OpenAI sorts data by `index` in practice, but defend explicitly.
		const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		const output = sorted.map((entry, i) => {
			if (!Array.isArray(entry.embedding) || !entry.embedding.every(Number.isFinite)) {
				throw new OpenAIBackendError(`OpenAI /embeddings vector at index ${i} is not an array of finite numbers`);
			}
			return Float32Array.from(entry.embedding);
		});
		const usage: TokenUsage = {};
		assignFiniteTokenCount(usage, 'embeddingTokens', data.usage?.prompt_tokens);
		return { status: 'completed', output, usage };
	}

	async generate(input: GenerateInput, opts: BackendOpts<GenerateOpts>): Promise<ModelCallResult<GenerateResult>> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generate', OpenAIBackendError);
		const body = buildChatRequest(model, input, opts, false, this.#isNativeOpenAI);
		const res = await this.#post('/chat/completions', body, opts.signal);
		const data = await parseJsonResponse<OpenAIChatResponse>(res, 'OpenAI /chat/completions', OpenAIBackendError);
		const choice = data.choices?.[0];
		if (!choice) {
			throw new OpenAIBackendError('OpenAI /chat/completions response missing choices[0]');
		}
		const rawContent = choice.message?.content;
		if (rawContent != null && typeof rawContent !== 'string') {
			throw new OpenAIBackendError('OpenAI /chat/completions content is not a string');
		}
		const toolCalls = parseToolCalls(choice.message?.tool_calls);
		const usage: TokenUsage = {};
		assignFiniteTokenCount(usage, 'promptTokens', data.usage?.prompt_tokens);
		assignFiniteTokenCount(usage, 'completionTokens', data.usage?.completion_tokens);
		const result: GenerateResult = {
			content: rawContent ?? '',
			finishReason: mapFinishReason(choice.finish_reason),
		};
		if (toolCalls && toolCalls.length > 0) result.toolCalls = toolCalls;
		return { status: 'completed', output: result, usage };
	}

	async *generateStream(input: GenerateInput, opts: BackendOpts<GenerateOpts>): AsyncIterable<GenerateChunk> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generateStream', OpenAIBackendError);
		const body = buildChatRequest(model, input, opts, true, this.#isNativeOpenAI);
		const res = await this.#post('/chat/completions', body, opts.signal);
		if (!res.body) throw new OpenAIBackendError('OpenAI /chat/completions returned no body for streaming');

		// Tool calls arrive as `index`-keyed deltas across many SSE events; we
		// accumulate internally and yield each call exactly once when its
		// `arguments` field parses cleanly (or on stream termination). This
		// preserves Phase 1's contract that `ToolCall.arguments` is `object`,
		// never a partial string.
		const toolBuf = new Map<number, ToolCallAccumulator>();
		let finalFinishReason: GenerateResult['finishReason'] | undefined;
		let totalArgChars = 0;

		for await (const event of readSse(res.body)) {
			const choice = event.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta;
			const chunk: GenerateChunk = {};
			if (typeof delta?.content === 'string' && delta.content.length > 0) {
				chunk.deltaContent = delta.content;
			}
			if (Array.isArray(delta?.tool_calls)) {
				for (const tcDelta of delta.tool_calls) {
					totalArgChars = accumulateToolCallDelta(toolBuf, tcDelta, totalArgChars);
				}
			}
			if (choice.finish_reason) {
				finalFinishReason = mapFinishReason(choice.finish_reason);
				// On stream termination, surface any accumulated tool calls in a
				// single yield. Skipping malformed entries (arguments that fail
				// JSON.parse) — they get dropped with a sanitized error.
				const finalCalls = flushToolCallBuffer(toolBuf);
				if (finalCalls.length > 0) chunk.deltaToolCalls = finalCalls;
				chunk.finishReason = finalFinishReason;
			}
			if (chunk.deltaContent || chunk.deltaToolCalls || chunk.finishReason) {
				yield chunk;
			}
		}

		// If the stream ended without an explicit finish_reason (rare; some
		// proxies cut the connection), flush any buffered tool calls so the
		// caller doesn't lose them silently.
		if (!finalFinishReason && toolBuf.size > 0) {
			const tail = flushToolCallBuffer(toolBuf);
			if (tail.length > 0) yield { deltaToolCalls: tail };
		}
	}

	async #post(path: string, body: object, callerSignal?: AbortSignal): Promise<Response> {
		const signal = composeSignal(callerSignal, this.#requestTimeoutMs);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${this.#apiKey}`,
		};
		if (this.#organization) headers['OpenAI-Organization'] = this.#organization;
		const res = await this.#fetch(`${this.#baseUrl}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			// Read OpenAI's well-defined error envelope (`{ error: { message,
			// type, code, param } }`) for operator-facing detail. `error.message`
			// is model/service-side text, not user-input echo, so including it
			// doesn't leak request content. Cap length defensively against a
			// misbehaving compat shim. Falls back to status-only if the body
			// isn't JSON or doesn't have the envelope.
			throw new OpenAIBackendError(`OpenAI ${path} returned HTTP ${res.status}${await readErrorSuffix(res)}`);
		}
		return res;
	}
}

async function readErrorSuffix(res: Response): Promise<string> {
	try {
		const body = await readBoundedJson<{ error?: { message?: unknown; type?: unknown } }>(
			res,
			'OpenAI error response',
			OpenAIBackendError,
			MAX_ERROR_BODY_BYTES
		);
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

/**
 * Boot-bridge helper. Called from `resources/models/bootstrap.ts` for each
 * `models.embedding.<name>` / `models.generative.<name>` entry whose
 * `backend: openai`.
 */
export function registerOpenAIBackend(args: {
	logicalName: string;
	kind: OpenAIBackendKind;
	config: OpenAIBackendConfig;
}): void {
	const backend = new OpenAIBackend(args.config);
	if (args.kind === 'embedding') setEmbedding(args.logicalName, backend);
	else setGenerative(args.logicalName, backend);
}

export class OpenAIBackendError extends ServerError {
	constructor(message: string) {
		super(message);
		this.name = 'OpenAIBackendError';
	}
}

// ---------- internals ----------

function buildChatRequest(
	model: string,
	input: GenerateInput,
	opts: BackendOpts<GenerateOpts>,
	stream: boolean,
	isNativeOpenAI: boolean
): Record<string, unknown> {
	const messages = normalizeMessages(input);
	const tools = extractTools(input);
	const body: Record<string, unknown> = {
		model,
		messages,
		stream,
	};
	if (tools && tools.length > 0) {
		body.tools = tools.map(toOpenAITool);
		// tool_choice defaults to 'auto' on OpenAI when `tools` is set, which is
		// the right behavior for `toolMode: 'return'` — the model decides whether
		// to call; the caller decides what to do with the call.
	}
	if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
	if (typeof opts.maxTokens === 'number') {
		// api.openai.com's reasoning/gpt-5 models reject `max_tokens` (400); use
		// `max_completion_tokens` there. OpenAI-compatible shims (vLLM, Ollama-compat,
		// older gateways) only understand `max_tokens`, so keep the legacy field for
		// any custom baseUrl.
		if (isNativeOpenAI) {
			body.max_completion_tokens = opts.maxTokens;
		} else {
			body.max_tokens = opts.maxTokens;
		}
	}
	const responseFormat = mapResponseFormat(opts.responseFormat);
	if (responseFormat) body.response_format = responseFormat;
	return body;
}

function normalizeMessages(
	input: GenerateInput
): Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: object[] }> {
	if (typeof input === 'string') {
		return [{ role: 'user', content: input }];
	}
	if (Array.isArray(input)) {
		return input.map(toOpenAIMessage);
	}
	const messages = input.messages.map(toOpenAIMessage);
	if (input.system) {
		return [{ role: 'system', content: input.system }, ...messages];
	}
	return messages;
}

function extractTools(input: GenerateInput): ToolDef[] | undefined {
	if (typeof input === 'string' || Array.isArray(input)) return undefined;
	return input.tools;
}

function toOpenAIMessage(m: Message): { role: string; content: string; tool_call_id?: string; tool_calls?: object[] } {
	const out: { role: string; content: string; tool_call_id?: string; tool_calls?: object[] } = {
		role: m.role,
		content: m.content,
	};
	if (m.toolCallId) out.tool_call_id = m.toolCallId;
	if (m.toolCalls && m.toolCalls.length > 0) {
		out.tool_calls = m.toolCalls.map((tc) => ({
			id: tc.id,
			type: 'function',
			function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
		}));
	}
	return out;
}

function toOpenAITool(t: ToolDef): {
	type: 'function';
	function: { name: string; description: string; parameters: object };
} {
	return {
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	};
}

function mapResponseFormat(responseFormat: GenerateOpts['responseFormat']): object | undefined {
	if (!responseFormat) return undefined;
	if (responseFormat === 'text') return { type: 'text' };
	if (responseFormat === 'json') return { type: 'json_object' };
	if (typeof responseFormat === 'object' && 'schema' in responseFormat) {
		return {
			type: 'json_schema',
			json_schema: { name: 'output', schema: responseFormat.schema, strict: true },
		};
	}
	return undefined;
}

function mapFinishReason(reason?: string | null): GenerateResult['finishReason'] {
	switch (reason) {
		case 'length':
			return 'length';
		case 'tool_calls':
		case 'function_call':
			return 'tool_calls';
		case 'content_filter':
			return 'content_filter';
		case 'stop':
		default:
			return 'stop';
	}
}

function parseToolCalls(raw: OpenAIToolCall[] | undefined): ToolCall[] | undefined {
	if (!raw || raw.length === 0) return undefined;
	const out: ToolCall[] = [];
	for (const tc of raw) {
		if (!tc.id || !tc.function?.name) continue;
		try {
			const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
			out.push({ id: tc.id, name: tc.function.name, arguments: args });
		} catch {
			// Drop tool calls whose arguments aren't valid JSON. OpenAI almost
			// always returns valid JSON; a malformed argument is a real model
			// failure the caller should treat as "no tool call" rather than
			// crash the whole response. Log at warn so the silent drop is
			// auditable — name + id only, never the malformed argument bytes.
			log.warn?.(`OpenAI tool call dropped: malformed arguments (id=${tc.id}, name=${tc.function.name})`);
			continue;
		}
	}
	return out.length > 0 ? out : undefined;
}

interface ToolCallAccumulator {
	id?: string;
	name?: string;
	argumentsBuf: string;
}

function accumulateToolCallDelta(
	buf: Map<number, ToolCallAccumulator>,
	delta: OpenAIToolCallDelta,
	totalArgChars: number
): number {
	const index = typeof delta.index === 'number' ? delta.index : 0;
	let acc = buf.get(index);
	if (!acc) {
		// Cap total accumulator entries: `index` is upstream-controlled and an
		// adversarial stream can allocate unbounded map entries without this guard.
		if (buf.size >= MAX_TOOL_CALL_ACCUMULATOR_ENTRIES) {
			throw new OpenAIBackendError(
				`OpenAI tool-call accumulator exceeded ${MAX_TOOL_CALL_ACCUMULATOR_ENTRIES} distinct tool-call entries`
			);
		}
		acc = { argumentsBuf: '' };
		buf.set(index, acc);
	}
	if (delta.id) acc.id = delta.id;
	if (delta.function?.name) acc.name = delta.function.name;
	if (typeof delta.function?.arguments === 'string') {
		// Per-entry cap: the per-event SSE buffer cap stops a single oversize event,
		// but tool-call arguments are *built up* across many sub-cap events.
		if (acc.argumentsBuf.length + delta.function.arguments.length > MAX_TOOL_CALL_ARGS_CHARS) {
			throw new OpenAIBackendError(
				`OpenAI tool-call arguments exceed ${MAX_TOOL_CALL_ARGS_CHARS} chars (index ${index})`
			);
		}
		// Total-stream cap: 128 entries each at 1 MiB still allows ~128 MiB accumulated.
		totalArgChars += delta.function.arguments.length;
		if (totalArgChars > MAX_TOTAL_TOOL_CALL_ARGS_CHARS) {
			throw new OpenAIBackendError(
				`OpenAI tool-call arguments exceed total stream cap of ${MAX_TOTAL_TOOL_CALL_ARGS_CHARS} chars`
			);
		}
		acc.argumentsBuf += delta.function.arguments;
	}
	return totalArgChars;
}

function flushToolCallBuffer(buf: Map<number, ToolCallAccumulator>): Partial<ToolCall>[] {
	const out: Partial<ToolCall>[] = [];
	// Stable order by index for deterministic output.
	const indices = [...buf.keys()].sort((a, b) => a - b);
	for (const idx of indices) {
		const acc = buf.get(idx)!;
		if (!acc.id || !acc.name) continue;
		try {
			const args = acc.argumentsBuf.length > 0 ? JSON.parse(acc.argumentsBuf) : {};
			out.push({ id: acc.id, name: acc.name, arguments: args });
		} catch {
			// Same posture as non-streaming: malformed arguments → drop the
			// call but log so the silent drop is auditable. Name + id only.
			log.warn?.(`OpenAI tool call dropped: malformed arguments (id=${acc.id}, name=${acc.name})`);
			continue;
		}
	}
	buf.clear();
	return out;
}

/**
 * Read OpenAI's SSE wire format. Each event is `data: <json>\n\n`; the stream
 * terminates on `data: [DONE]\n\n`. Comment lines (`:`) and any non-`data:`
 * field are ignored.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAIStreamEvent> {
	const decoder = new TextDecoder('utf-8');
	let buf = '';
	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
		buf += decoder.decode(chunk, { stream: true });
		if (buf.length > MAX_SSE_BUFFER_CHARS) {
			throw new OpenAIBackendError(`OpenAI SSE buffer exceeds ${MAX_SSE_BUFFER_CHARS} chars without a complete event`);
		}
		let boundary: number;
		while ((boundary = buf.indexOf('\n\n')) >= 0) {
			const eventBlock = buf.slice(0, boundary);
			buf = buf.slice(boundary + 2);
			const parsed = parseSseEvent(eventBlock);
			if (parsed === 'done') return;
			if (parsed) yield parsed;
		}
	}
	buf += decoder.decode();
	const tail = buf.trim();
	if (tail) {
		const parsed = parseSseEvent(tail);
		if (parsed && parsed !== 'done') yield parsed;
	}
}

function parseSseEvent(block: string): OpenAIStreamEvent | 'done' | null {
	// Each block is one or more lines. Concatenate `data:` line payloads per
	// SSE rules (multi-line data fields are joined with `\n`).
	let data = '';
	for (const rawLine of block.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (!line || line.startsWith(':')) continue;
		if (!line.startsWith('data:')) continue;
		const payload = line.slice(5).replace(/^ /, ''); // strip "data:" + optional leading space
		data = data ? data + '\n' + payload : payload;
	}
	if (!data) return null;
	if (data === '[DONE]') return 'done';
	try {
		return JSON.parse(data) as OpenAIStreamEvent;
	} catch {
		// Static message — JSON parser echoes the offending bytes which can be
		// upstream-derived content.
		throw new OpenAIBackendError('Invalid SSE data line from OpenAI');
	}
}

// ---------- OpenAI wire types (subset we actually read) ----------

interface OpenAIEmbedResponse {
	data: Array<{ embedding: number[]; index?: number; object?: string }>;
	usage?: { prompt_tokens?: number; total_tokens?: number };
}

interface OpenAIChatResponse {
	choices?: Array<{
		message?: { role: string; content?: string | null; tool_calls?: OpenAIToolCall[] };
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAIToolCall {
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
}

interface OpenAIStreamEvent {
	choices?: Array<{
		delta?: {
			role?: string;
			content?: string | null;
			tool_calls?: OpenAIToolCallDelta[];
		};
		finish_reason?: string | null;
	}>;
}

interface OpenAIToolCallDelta {
	index?: number;
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
}
