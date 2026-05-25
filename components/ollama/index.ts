/**
 * Ollama backend (#629, Phase 2 of #510).
 *
 * Implements `ModelBackend` against a local or remote Ollama HTTP API.
 * Exports `OllamaBackend` directly for tests and `registerOllamaBackend(...)`
 * for the YAML→registry boot bridge in `resources/models/bootstrap.ts`.
 *
 * Component shape matches the pattern in `components/mcp/index.ts` (PR #649):
 * core imports a register helper and calls it during boot; not a
 * `handleApplication(scope)` self-loader.
 */
import { setEmbedding, setGenerative } from '../../resources/models/backendRegistry.ts';
import {
	assignFiniteTokenCount,
	composeSignal,
	normalizeOrigin,
	parseJsonResponse,
	requireModel,
} from '../../resources/models/backendHelpers.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
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
	TokenUsage,
} from '../../resources/models/types.ts';

const DEFAULT_HOST = 'localhost:11434';
const MAX_NDJSON_LINE_BYTES = 1 << 20; // 1 MiB — Ollama chunks are normally sub-KiB; anything larger is pathological.

export type OllamaBackendKind = 'embedding' | 'generative';

export interface OllamaBackendConfig {
	/** Host:port (default `localhost:11434`) or full origin (`https://ollama.example.com`). */
	host?: string;
	/** Default model when the caller doesn't pass `opts.model`. */
	model?: string;
	/** Per-request timeout. When set, combined with `opts.signal` via `AbortSignal.any`. */
	requestTimeoutMs?: number;
}

/**
 * `ModelBackend` implementation talking to Ollama's HTTP API.
 *
 * - `embed` → `POST /api/embed` (the legacy `/api/embeddings` is deprecated upstream).
 * - `generate` → `POST /api/generate` for string prompts, `POST /api/chat` for
 *   messages-array input.
 * - `generateStream` → same routing as `generate` with `stream: true`; consumes
 *   Ollama's NDJSON wire format and yields `GenerateChunk` per JSON line.
 *
 * Capabilities advertise `tools: false` and `adapters: false`. Ollama tool-call
 * support exists on some models but is uneven across the model catalog; we keep
 * the v1 portability guarantee honest and skip them here.
 */
export class OllamaBackend implements ModelBackend {
	readonly name = 'ollama';
	readonly #origin: string;
	readonly #defaultModel?: string;
	readonly #requestTimeoutMs?: number;
	readonly #fetch: typeof fetch;

	constructor(config: OllamaBackendConfig = {}, fetchImpl: typeof fetch = fetch) {
		this.#origin = normalizeOrigin(config.host, { host: DEFAULT_HOST, secure: false });
		this.#defaultModel = config.model;
		this.#requestTimeoutMs = config.requestTimeoutMs;
		this.#fetch = fetchImpl;
	}

	capabilities(): ModelCapabilities {
		return { embed: true, generate: true, stream: true, tools: false, adapters: false };
	}

	async embed(input: string | string[], opts: BackendOpts<EmbedOpts>): Promise<ModelCallResult<Float32Array[]>> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'embed', OllamaBackendError);
		const texts = Array.isArray(input) ? input : [input];
		const prepared = texts.map((t) => applyEmbedPrefix(model, t, opts.inputType));
		const res = await this.#post('/api/embed', { model, input: prepared }, opts.signal);
		const data = await parseJsonResponse<OllamaEmbedResponse>(res, 'Ollama /api/embed', OllamaBackendError);
		if (!Array.isArray(data.embeddings)) {
			throw new OllamaBackendError("Ollama /api/embed response missing 'embeddings' array");
		}
		if (data.embeddings.length !== prepared.length) {
			throw new OllamaBackendError(
				`Ollama /api/embed returned ${data.embeddings.length} vectors for ${prepared.length} inputs`
			);
		}
		const output = data.embeddings.map((v, i) => {
			if (!Array.isArray(v) || !v.every(Number.isFinite)) {
				throw new OllamaBackendError(`Ollama /api/embed vector at index ${i} is not an array of finite numbers`);
			}
			return Float32Array.from(v);
		});
		const usage: TokenUsage = {};
		assignFiniteTokenCount(usage, 'embeddingTokens', data.prompt_eval_count);
		return { status: 'completed', output, usage };
	}

	async generate(input: GenerateInput, opts: BackendOpts<GenerateOpts>): Promise<ModelCallResult<GenerateResult>> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generate', OllamaBackendError);
		const { endpoint, body } = buildGenerateRequest(model, input, opts, false);
		const res = await this.#post(endpoint, body, opts.signal);
		const data = await parseJsonResponse<OllamaGenerateResponse & OllamaChatResponse>(
			res,
			`Ollama ${endpoint}`,
			OllamaBackendError
		);
		const rawContent = endpoint === '/api/chat' ? data.message?.content : data.response;
		if (rawContent !== undefined && typeof rawContent !== 'string') {
			throw new OllamaBackendError(`Ollama ${endpoint} response content is not a string`);
		}
		const usage: TokenUsage = {};
		assignFiniteTokenCount(usage, 'promptTokens', data.prompt_eval_count);
		assignFiniteTokenCount(usage, 'completionTokens', data.eval_count);
		return {
			status: 'completed',
			output: { content: rawContent ?? '', finishReason: mapFinishReason(data.done_reason) },
			usage,
		};
	}

	async *generateStream(input: GenerateInput, opts: BackendOpts<GenerateOpts>): AsyncIterable<GenerateChunk> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generateStream', OllamaBackendError);
		const { endpoint, body } = buildGenerateRequest(model, input, opts, true);
		const res = await this.#post(endpoint, body, opts.signal);
		if (!res.body) throw new OllamaBackendError(`Ollama ${endpoint} returned no body for streaming`);
		for await (const obj of readNdjson(res.body)) {
			yield toGenerateChunk(obj, endpoint);
		}
	}

	async #post(path: string, body: object, callerSignal?: AbortSignal): Promise<Response> {
		const signal = composeSignal(callerSignal, this.#requestTimeoutMs);
		const res = await this.#fetch(`${this.#origin}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			throw new OllamaBackendError(`Ollama ${path} returned HTTP ${res.status}`);
		}
		return res;
	}
}

/**
 * Boot-bridge helper. Called from `resources/models/bootstrap.ts` for each
 * `models.embedding.<name>` / `models.generative.<name>` entry whose
 * `backend: ollama`.
 */
export function registerOllamaBackend(args: {
	logicalName: string;
	kind: OllamaBackendKind;
	config: OllamaBackendConfig;
}): void {
	const backend = new OllamaBackend(args.config);
	if (args.kind === 'embedding') setEmbedding(args.logicalName, backend);
	else setGenerative(args.logicalName, backend);
}

export class OllamaBackendError extends ServerError {
	constructor(message: string) {
		super(message);
		this.name = 'OllamaBackendError';
	}
}

// ---------- internals ----------

function applyEmbedPrefix(model: string, text: string, inputType?: 'document' | 'query'): string {
	if (!inputType) return text;
	// nomic-embed-text v1.5+ uses these application-layer prefixes to distinguish
	// document-corpus encodings from query encodings. Models that don't recognize
	// them silently return slightly different (still usable) vectors. Other model
	// families (BGE, e5, etc.) use their own conventions; add cases as we validate.
	if (/nomic-embed-text/i.test(model)) {
		return (inputType === 'document' ? 'search_document: ' : 'search_query: ') + text;
	}
	return text;
}

interface BuiltRequest {
	endpoint: '/api/generate' | '/api/chat';
	body: Record<string, unknown>;
}

function buildGenerateRequest(
	model: string,
	input: GenerateInput,
	opts: BackendOpts<GenerateOpts>,
	stream: boolean
): BuiltRequest {
	const optionsBag = buildOptionsBag(opts);
	if (typeof input === 'string') {
		return { endpoint: '/api/generate', body: { model, prompt: input, stream, ...optionsBag } };
	}
	const { messages, system } = normalizeMessages(input);
	// Ollama chat has no top-level system field; prepend it as the first message
	// when the caller supplied one separately.
	const chatMessages = system
		? [{ role: 'system' as const, content: system }, ...messages.map(toOllamaMessage)]
		: messages.map(toOllamaMessage);
	return { endpoint: '/api/chat', body: { model, messages: chatMessages, stream, ...optionsBag } };
}

function buildOptionsBag(opts: BackendOpts<GenerateOpts>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const options: Record<string, unknown> = {};
	if (typeof opts.temperature === 'number') options.temperature = opts.temperature;
	if (typeof opts.maxTokens === 'number') options.num_predict = opts.maxTokens;
	if (Object.keys(options).length > 0) out.options = options;
	if (opts.responseFormat === 'json') {
		out.format = 'json';
	} else if (opts.responseFormat && typeof opts.responseFormat === 'object' && 'schema' in opts.responseFormat) {
		out.format = opts.responseFormat.schema;
	}
	return out;
}

function normalizeMessages(input: Exclude<GenerateInput, string>): { messages: Message[]; system?: string } {
	if (Array.isArray(input)) return { messages: input };
	return { messages: input.messages, system: input.system };
}

function toOllamaMessage(m: Message): { role: string; content: string } {
	// Tools intentionally not forwarded — see capabilities().tools = false.
	return { role: m.role, content: m.content };
}

function mapFinishReason(reason?: string): GenerateResult['finishReason'] {
	switch (reason) {
		case 'length':
			return 'length';
		case 'stop':
		default:
			return 'stop';
	}
}

function toGenerateChunk(data: OllamaStreamChunk, endpoint: '/api/generate' | '/api/chat'): GenerateChunk {
	const chunk: GenerateChunk = {};
	const deltaContent = endpoint === '/api/chat' ? data.message?.content : data.response;
	if (typeof deltaContent === 'string' && deltaContent.length > 0) chunk.deltaContent = deltaContent;
	if (data.done === true) chunk.finishReason = mapFinishReason(data.done_reason);
	return chunk;
}

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<OllamaStreamChunk> {
	const decoder = new TextDecoder('utf-8');
	let buf = '';
	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
		buf += decoder.decode(chunk, { stream: true });
		if (buf.length > MAX_NDJSON_LINE_BYTES) {
			throw new OllamaBackendError(`Ollama NDJSON line exceeds ${MAX_NDJSON_LINE_BYTES} bytes without a newline`);
		}
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			yield parseJsonLine(line);
		}
	}
	buf += decoder.decode();
	const tail = buf.trim();
	if (tail) yield parseJsonLine(tail);
}

function parseJsonLine(line: string): OllamaStreamChunk {
	try {
		return JSON.parse(line) as OllamaStreamChunk;
	} catch {
		// Deliberately static — the JSON parser's message echoes the offending bytes,
		// which can include upstream-derived content. Matches the sanitization posture
		// of `hdb_model_calls.error_code` (analyticsTable.ts:35).
		throw new OllamaBackendError('Invalid NDJSON line from Ollama');
	}
}

interface OllamaEmbedResponse {
	embeddings: number[][];
	prompt_eval_count?: number;
}

interface OllamaGenerateResponse {
	response?: string;
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
}

interface OllamaChatResponse {
	message?: { role: string; content: string };
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
}

interface OllamaStreamChunk {
	response?: string;
	message?: { role: string; content: string };
	done?: boolean;
	done_reason?: string;
}
