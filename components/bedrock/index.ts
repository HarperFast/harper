/**
 * AWS Bedrock backend (#633, Phase 6 of #510).
 *
 * Implements `ModelBackend` against AWS Bedrock via the official AWS SDK.
 * Unlike Ollama / OpenAI / Anthropic, Bedrock requires SigV4-signed
 * requests against region-specific endpoints; rolling that ourselves is
 * not worth it. `@aws-sdk/client-bedrock-runtime` is declared as an
 * **optional `peerDependency`** in Harper's `package.json`. Users who
 * want the bedrock backend add the SDK to their own project's
 * `package.json`; we dynamic-import on first use and throw a pointed
 * error if it's missing.
 *
 * AWS credentials resolve via the SDK's standard chain (env / shared
 * credentials file / EC2 / ECS / IAM roles for service accounts). No
 * `apiKey` field on the Harper config — credential handling is the
 * SDK's job, not ours.
 *
 * Bedrock has multiple model invocation shapes per family (Claude vs
 * Llama vs Titan vs Cohere). The backend dispatches on the `model`
 * field's prefix; per-family request/response translation lives in
 * helpers below.
 */
import { setEmbedding, setGenerative } from '../../resources/models/backendRegistry.ts';
import { assignFiniteTokenCount, composeSignal, requireModel } from '../../resources/models/backendHelpers.ts';
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

// Defaults matching Anthropic's expectation when Claude is invoked via
// Bedrock — Anthropic requires `max_tokens` on every request.
const DEFAULT_MAX_TOKENS = 4096;
// Max accumulated `bytes` from streamed Claude tool-use input_json_delta;
// matches the cap in `components/anthropic/index.ts`.
const MAX_TOOL_CALL_ARGS_CHARS = 1 << 20;

const log = harperLogger.forComponent('bedrock').conditional;

export type BedrockBackendKind = 'embedding' | 'generative';

export interface BedrockBackendConfig {
	/** AWS region (e.g. `us-east-1`). Required — Bedrock is regional. */
	region?: string;
	/**
	 * Model ID per Bedrock conventions, e.g. `anthropic.claude-opus-4-v1:0`
	 * for Claude, `meta.llama3-70b-instruct-v1:0` for Llama,
	 * `amazon.titan-embed-text-v2:0` for Titan embed. The leading vendor
	 * prefix is how the backend dispatches to the right per-family shape.
	 */
	model?: string;
	requestTimeoutMs?: number;
}

/**
 * SDK type-erased shape we use. We don't import `@aws-sdk/client-bedrock-runtime`
 * at module init (it's an optional peerDep); types are kept loose so the
 * compile doesn't depend on the SDK either.
 */
type SdkLike = {
	BedrockRuntimeClient: new (config: { region?: string }) => {
		send: (cmd: object) => Promise<unknown>;
	};
	InvokeModelCommand: new (input: { modelId: string; body: string; contentType?: string; accept?: string }) => object;
	InvokeModelWithResponseStreamCommand: new (input: {
		modelId: string;
		body: string;
		contentType?: string;
		accept?: string;
	}) => object;
};

let sdkPromise: Promise<SdkLike> | undefined;

/**
 * Load the AWS SDK on demand. Memoized — the SDK is module-scope state once
 * loaded. Throws `BedrockBackendError` with a clear "add to your
 * package.json" message if the SDK isn't installed.
 */
async function loadSdk(): Promise<SdkLike> {
	if (!sdkPromise) {
		sdkPromise = (async () => {
			try {
				// `@aws-sdk/client-bedrock-runtime` is declared as an optional
				// peerDependency in Harper's `package.json` — it is not present
				// in Harper's `node_modules` by design, so TypeScript can't
				// resolve it at compile time. The runtime import resolves
				// against the user's project tree.
				// @ts-expect-error optional peerDependency, not resolvable at build time
				const mod = (await import('@aws-sdk/client-bedrock-runtime')) as unknown as SdkLike;
				return mod;
			} catch (err) {
				// Wipe the cached rejection so a follow-up install + retry works
				// without restart. The thrown error is still propagated for this call.
				sdkPromise = undefined;
				throw new BedrockBackendError(
					'@aws-sdk/client-bedrock-runtime is not installed. Add it to your project ' +
						'(`npm install @aws-sdk/client-bedrock-runtime`) — Harper declares it as an optional peerDependency, ' +
						'not a direct dependency, so applications that do not use the bedrock backend never pay the install cost. ' +
						`Underlying error: ${(err as Error)?.message ?? err}`
				);
			}
		})();
	}
	return sdkPromise;
}

/** Test-only hook to reset the memoized SDK promise between cases. */
export function _resetSdkCacheForTests(): void {
	sdkPromise = undefined;
}

/** Test-only hook to inject a fake SDK. */
export function _injectSdkForTests(sdk: SdkLike): void {
	sdkPromise = Promise.resolve(sdk);
}

/**
 * `ModelBackend` for AWS Bedrock.
 *
 * - `embed` → `InvokeModel` against an embedding model (Titan, Cohere, etc.)
 * - `generate` → `InvokeModel` against a generative model, per-family body shape
 * - `generateStream` → `InvokeModelWithResponseStream`, per-family event parsing
 *
 * Tool support varies per model family — `capabilities()` advertises
 * `tools: true` at the capability level; calls against models that don't
 * support tools (or that haven't been wired into the per-family dispatcher
 * yet) raise structured errors.
 */
export class BedrockBackend implements ModelBackend {
	readonly name = 'bedrock';
	readonly #region?: string;
	readonly #defaultModel?: string;
	readonly #requestTimeoutMs?: number;
	#client?: { send: (cmd: object) => Promise<unknown> };

	constructor(config: BedrockBackendConfig = {}) {
		this.#region = config.region;
		this.#defaultModel = config.model;
		this.#requestTimeoutMs = config.requestTimeoutMs;
	}

	capabilities(): ModelCapabilities {
		return { embed: true, generate: true, stream: true, tools: true, adapters: false };
	}

	async embed(input: string | string[], opts: BackendOpts<EmbedOpts>): Promise<ModelCallResult<Float32Array[]>> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'embed', BedrockBackendError);
		const family = familyOf(model);
		const texts = Array.isArray(input) ? input : [input];

		const client = await this.#getClient();
		const sdk = await loadSdk();
		const vectors: Float32Array[] = [];
		let totalPromptTokens = 0;
		let sawAnyTokens = false;

		// Bedrock embedding APIs (Titan, Cohere) accept one text per call.
		// Loop to honor the multi-input contract; concurrent dispatch would
		// trip the SDK's request budget on larger batches without bounded
		// concurrency, which is overkill for v1.
		for (const text of texts) {
			const body = buildEmbedBody(family, text, opts.inputType);
			const command = new sdk.InvokeModelCommand({
				modelId: model,
				body: JSON.stringify(body),
				contentType: 'application/json',
				accept: 'application/json',
			});
			const response = (await this.#sendWithAbort(client, command, opts.signal)) as { body?: Uint8Array | string };
			const parsed = parseInvokeModelResponse(response);
			const { embedding, promptTokens } = extractEmbedResult(family, parsed);
			vectors.push(Float32Array.from(embedding));
			if (typeof promptTokens === 'number') {
				totalPromptTokens += promptTokens;
				sawAnyTokens = true;
			}
		}

		const usage: TokenUsage = {};
		if (sawAnyTokens) assignFiniteTokenCount(usage, 'embeddingTokens', totalPromptTokens);
		return { status: 'completed', output: vectors, usage };
	}

	async generate(input: GenerateInput, opts: BackendOpts<GenerateOpts>): Promise<ModelCallResult<GenerateResult>> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generate', BedrockBackendError);
		const family = familyOf(model);
		const body = buildGenerateBody(family, input, opts);

		const client = await this.#getClient();
		const sdk = await loadSdk();
		const command = new sdk.InvokeModelCommand({
			modelId: model,
			body: JSON.stringify(body),
			contentType: 'application/json',
			accept: 'application/json',
		});
		const response = (await this.#sendWithAbort(client, command, opts.signal)) as { body?: Uint8Array | string };
		const parsed = parseInvokeModelResponse(response);
		const result = extractGenerateResult(family, parsed);
		return { status: 'completed', output: result.output, usage: result.usage };
	}

	async *generateStream(input: GenerateInput, opts: BackendOpts<GenerateOpts>): AsyncIterable<GenerateChunk> {
		const model = opts.model ?? this.#defaultModel;
		requireModel(model, 'generateStream', BedrockBackendError);
		const family = familyOf(model);
		const body = buildGenerateBody(family, input, opts);

		const client = await this.#getClient();
		const sdk = await loadSdk();
		const command = new sdk.InvokeModelWithResponseStreamCommand({
			modelId: model,
			body: JSON.stringify(body),
			contentType: 'application/json',
			accept: 'application/json',
		});
		const response = (await this.#sendWithAbort(client, command, opts.signal)) as {
			body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>;
		};
		if (!response.body) {
			throw new BedrockBackendError(`Bedrock InvokeModelWithResponseStream returned no body for model ${model}`);
		}

		yield* parseStream(family, response.body);
	}

	async #getClient(): Promise<{ send: (cmd: object) => Promise<unknown> }> {
		if (this.#client) return this.#client;
		const sdk = await loadSdk();
		this.#client = new sdk.BedrockRuntimeClient({ region: this.#region });
		return this.#client;
	}

	/**
	 * Send a command with caller-supplied AbortSignal + optional per-call
	 * timeout composed via `AbortSignal.any`. The SDK accepts `abortSignal`
	 * in the request options bag.
	 */
	async #sendWithAbort(
		client: { send: (cmd: object, options?: { abortSignal?: AbortSignal }) => Promise<unknown> },
		command: object,
		callerSignal?: AbortSignal
	): Promise<unknown> {
		const abortSignal = composeSignal(callerSignal, this.#requestTimeoutMs);
		return client.send(command, abortSignal ? { abortSignal } : undefined);
	}
}

/**
 * Boot-bridge helper. Called from `resources/models/bootstrap.ts` for each
 * `models.embedding.<name>` / `models.generative.<name>` entry whose
 * `backend: bedrock`. Construction is cheap (no SDK load) — the SDK loads
 * lazily on first call.
 */
export function registerBedrockBackend(args: {
	logicalName: string;
	kind: BedrockBackendKind;
	config: BedrockBackendConfig;
}): void {
	const backend = new BedrockBackend(args.config);
	if (args.kind === 'embedding') setEmbedding(args.logicalName, backend);
	else setGenerative(args.logicalName, backend);
}

export class BedrockBackendError extends ServerError {
	constructor(message: string) {
		super(message);
		this.name = 'BedrockBackendError';
	}
}

// ---------- per-family dispatch ----------

type Family = 'anthropic' | 'amazon' | 'meta' | 'cohere' | 'mistral' | 'unknown';

function familyOf(modelId: string): Family {
	const prefix = modelId.split('.', 1)[0]?.toLowerCase() ?? '';
	if (prefix === 'anthropic') return 'anthropic';
	if (prefix === 'amazon') return 'amazon';
	if (prefix === 'meta') return 'meta';
	if (prefix === 'cohere') return 'cohere';
	if (prefix === 'mistral') return 'mistral';
	return 'unknown';
}

// ---------- embed body / result extraction ----------

function buildEmbedBody(family: Family, text: string, inputType?: 'document' | 'query'): object {
	if (family === 'amazon') {
		// Titan embed v2: { inputText, dimensions?, normalize? }. Titan does
		// not currently differentiate document vs query at the wire level.
		return { inputText: text };
	}
	if (family === 'cohere') {
		// Cohere embed-v3: `input_type` materially affects the produced vector
		// — `search_document` and `search_query` produce different embeddings
		// for the same text. Honor the caller's `inputType`; default to
		// `search_document` when unset (matches Cohere's recommended default
		// for indexing).
		const cohereInputType = inputType === 'query' ? 'search_query' : 'search_document';
		return { texts: [text], input_type: cohereInputType };
	}
	throw new BedrockBackendError(`Bedrock embed not supported for model family '${family}'`);
}

function extractEmbedResult(
	family: Family,
	parsed: Record<string, unknown>
): { embedding: number[]; promptTokens?: number } {
	if (family === 'amazon') {
		const embedding = parsed.embedding;
		if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
			throw new BedrockBackendError("Bedrock Titan response missing 'embedding' as a finite-number array");
		}
		const inputTextTokenCount = parsed.inputTextTokenCount;
		return {
			embedding: embedding as number[],
			promptTokens: typeof inputTextTokenCount === 'number' ? inputTextTokenCount : undefined,
		};
	}
	if (family === 'cohere') {
		const embeddings = parsed.embeddings;
		if (!Array.isArray(embeddings) || embeddings.length === 0) {
			throw new BedrockBackendError("Bedrock Cohere response missing 'embeddings' array");
		}
		const first = embeddings[0];
		if (!Array.isArray(first) || !first.every((n) => typeof n === 'number' && Number.isFinite(n))) {
			throw new BedrockBackendError('Bedrock Cohere embedding vector is not an array of finite numbers');
		}
		return { embedding: first as number[] };
	}
	throw new BedrockBackendError(`Bedrock embed result extraction not implemented for family '${family}'`);
}

// ---------- generate body / result extraction ----------

function buildGenerateBody(family: Family, input: GenerateInput, opts: BackendOpts<GenerateOpts>): object {
	if (family === 'anthropic') return buildAnthropicBody(input, opts);
	if (family === 'meta') return buildLlamaBody(input, opts);
	if (family === 'amazon') return buildTitanGenerateBody(input, opts);
	if (family === 'mistral') return buildMistralBody(input, opts);
	if (family === 'cohere') return buildCohereGenerateBody(input, opts);
	throw new BedrockBackendError(`Bedrock generate not supported for model family '${family}'`);
}

function extractGenerateResult(
	family: Family,
	parsed: Record<string, unknown>
): { output: GenerateResult; usage: TokenUsage } {
	if (family === 'anthropic') return extractAnthropicResult(parsed);
	if (family === 'meta') return extractLlamaResult(parsed);
	if (family === 'amazon') return extractTitanResult(parsed);
	if (family === 'mistral') return extractMistralResult(parsed);
	if (family === 'cohere') return extractCohereResult(parsed);
	throw new BedrockBackendError(`Bedrock generate result extraction not implemented for family '${family}'`);
}

// Claude via Bedrock uses Anthropic's Messages API shape verbatim. Reuse the
// translation patterns from `components/anthropic/index.ts` but keep the
// code self-contained here — duplicated shape, different transport.
function buildAnthropicBody(input: GenerateInput, opts: BackendOpts<GenerateOpts>): object {
	const { messages, system } = normalizeMessages(input);
	const tools = extractTools(input);
	const body: Record<string, unknown> = {
		anthropic_version: 'bedrock-2023-05-31',
		messages: messages.map(toAnthropicMessage),
		max_tokens: typeof opts.maxTokens === 'number' && opts.maxTokens > 0 ? opts.maxTokens : DEFAULT_MAX_TOKENS,
	};
	if (system) body.system = system;
	if (tools && tools.length > 0) {
		body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
	}
	if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
	return body;
}

function extractAnthropicResult(parsed: Record<string, unknown>): { output: GenerateResult; usage: TokenUsage } {
	const content = Array.isArray(parsed.content) ? (parsed.content as AnthropicContentBlock[]) : [];
	const text: string[] = [];
	const toolCalls: ToolCall[] = [];
	for (const block of content) {
		if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
		else if (block.type === 'tool_use' && block.id && block.name) {
			const input = block.input && typeof block.input === 'object' ? block.input : {};
			toolCalls.push({ id: block.id, name: block.name, arguments: input });
		}
	}
	const usage: TokenUsage = {};
	const usageObj = parsed.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
	assignFiniteTokenCount(usage, 'promptTokens', usageObj?.input_tokens);
	assignFiniteTokenCount(usage, 'completionTokens', usageObj?.output_tokens);
	const output: GenerateResult = {
		content: text.join(''),
		finishReason: mapAnthropicStopReason(parsed.stop_reason as string | undefined),
	};
	if (toolCalls.length > 0) output.toolCalls = toolCalls;
	return { output, usage };
}

function buildLlamaBody(input: GenerateInput, opts: BackendOpts<GenerateOpts>): object {
	// Llama on Bedrock uses a flat `prompt` string. Caller's structured
	// messages are flattened with role tags; not as expressive as native chat,
	// but matches what AWS documents.
	rejectToolsForFamily(input, 'meta');
	const prompt = flattenToLlamaPrompt(input);
	const body: Record<string, unknown> = { prompt };
	if (typeof opts.maxTokens === 'number') body.max_gen_len = opts.maxTokens;
	if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
	return body;
}

function extractLlamaResult(parsed: Record<string, unknown>): { output: GenerateResult; usage: TokenUsage } {
	const generation = typeof parsed.generation === 'string' ? parsed.generation : '';
	const usage: TokenUsage = {};
	assignFiniteTokenCount(usage, 'promptTokens', parsed.prompt_token_count);
	assignFiniteTokenCount(usage, 'completionTokens', parsed.generation_token_count);
	const output: GenerateResult = {
		content: generation,
		finishReason: mapGenericStopReason(parsed.stop_reason as string | undefined),
	};
	return { output, usage };
}

function buildTitanGenerateBody(input: GenerateInput, opts: BackendOpts<GenerateOpts>): object {
	rejectToolsForFamily(input, 'amazon');
	const inputText = flattenToFlatPrompt(input);
	const body: Record<string, unknown> = { inputText };
	const textGenerationConfig: Record<string, unknown> = {};
	if (typeof opts.maxTokens === 'number') textGenerationConfig.maxTokenCount = opts.maxTokens;
	if (typeof opts.temperature === 'number') textGenerationConfig.temperature = opts.temperature;
	if (Object.keys(textGenerationConfig).length > 0) body.textGenerationConfig = textGenerationConfig;
	return body;
}

function extractTitanResult(parsed: Record<string, unknown>): { output: GenerateResult; usage: TokenUsage } {
	const results = Array.isArray(parsed.results) ? parsed.results : [];
	const first = (results[0] as Record<string, unknown>) ?? {};
	const outputText = typeof first.outputText === 'string' ? first.outputText : '';
	const usage: TokenUsage = {};
	assignFiniteTokenCount(usage, 'promptTokens', parsed.inputTextTokenCount);
	assignFiniteTokenCount(usage, 'completionTokens', first.tokenCount);
	const output: GenerateResult = {
		content: outputText,
		finishReason: mapGenericStopReason(first.completionReason as string | undefined),
	};
	return { output, usage };
}

function buildMistralBody(input: GenerateInput, opts: BackendOpts<GenerateOpts>): object {
	rejectToolsForFamily(input, 'mistral');
	const prompt = flattenToFlatPrompt(input);
	const body: Record<string, unknown> = { prompt };
	if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
	if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
	return body;
}

function extractMistralResult(parsed: Record<string, unknown>): { output: GenerateResult; usage: TokenUsage } {
	const outputs = Array.isArray(parsed.outputs) ? parsed.outputs : [];
	const first = (outputs[0] as Record<string, unknown>) ?? {};
	const text = typeof first.text === 'string' ? first.text : '';
	const output: GenerateResult = {
		content: text,
		finishReason: mapGenericStopReason(first.stop_reason as string | undefined),
	};
	// Mistral via Bedrock doesn't currently return per-call token counts in a
	// stable shape — leave usage empty.
	return { output, usage: {} };
}

function buildCohereGenerateBody(input: GenerateInput, opts: BackendOpts<GenerateOpts>): object {
	rejectToolsForFamily(input, 'cohere');
	const prompt = flattenToFlatPrompt(input);
	const body: Record<string, unknown> = { prompt };
	if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
	if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
	return body;
}

function extractCohereResult(parsed: Record<string, unknown>): { output: GenerateResult; usage: TokenUsage } {
	const generations = Array.isArray(parsed.generations) ? parsed.generations : [];
	const first = (generations[0] as Record<string, unknown>) ?? {};
	const text = typeof first.text === 'string' ? first.text : '';
	const output: GenerateResult = {
		content: text,
		finishReason: mapGenericStopReason(first.finish_reason as string | undefined),
	};
	return { output, usage: {} };
}

// ---------- streaming dispatch ----------

async function* parseStream(
	family: Family,
	body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>
): AsyncGenerator<GenerateChunk> {
	if (family === 'anthropic') {
		yield* parseAnthropicStream(body);
		return;
	}
	if (family === 'meta' || family === 'amazon' || family === 'mistral' || family === 'cohere') {
		yield* parseFlatStream(family, body);
		return;
	}
	throw new BedrockBackendError(`Bedrock streaming not supported for model family '${family}'`);
}

async function* parseAnthropicStream(
	body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>
): AsyncGenerator<GenerateChunk> {
	const decoder = new TextDecoder('utf-8');
	const toolBuf = new Map<number, { id: string; name: string; argumentsBuf: string }>();
	let finalFinishReason: GenerateResult['finishReason'] | undefined;

	for await (const event of body) {
		if (!event.chunk?.bytes) continue;
		const text = decoder.decode(event.chunk.bytes);
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new BedrockBackendError('Invalid JSON in Bedrock Anthropic stream chunk');
		}
		const chunk: GenerateChunk = {};
		const type = parsed.type as string | undefined;
		const index = parsed.index as number | undefined;
		const contentBlock = parsed.content_block as AnthropicContentBlock | undefined;
		const delta = parsed.delta as
			| {
					type?: string;
					text?: string;
					partial_json?: string;
					stop_reason?: string | null;
			  }
			| undefined;

		// Mid-stream upstream errors from Anthropic-via-Bedrock arrive as a
		// `type: 'error'` chunk; without explicit handling the stream ends
		// silently and the caller can't distinguish a clean end from an
		// aborted one. Same posture as the direct Anthropic backend.
		if (type === 'error') {
			const upstream = (parsed as { error?: { message?: unknown } }).error?.message;
			if (typeof upstream === 'string' && upstream.length > 0) {
				const truncated = upstream.length > 500 ? upstream.slice(0, 500) + '…' : upstream;
				throw new BedrockBackendError(`Bedrock Anthropic stream aborted by upstream error: ${truncated}`);
			}
			throw new BedrockBackendError('Bedrock Anthropic stream aborted by upstream error');
		}

		if (type === 'content_block_start' && index !== undefined && contentBlock?.type === 'tool_use') {
			toolBuf.set(index, { id: contentBlock.id ?? '', name: contentBlock.name ?? '', argumentsBuf: '' });
		}
		if (type === 'content_block_delta' && index !== undefined && delta) {
			if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
				chunk.deltaContent = delta.text;
			} else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
				const acc = toolBuf.get(index);
				if (acc) {
					if (acc.argumentsBuf.length + delta.partial_json.length > MAX_TOOL_CALL_ARGS_CHARS) {
						throw new BedrockBackendError(
							`Bedrock tool-call arguments exceed ${MAX_TOOL_CALL_ARGS_CHARS} chars (index ${index})`
						);
					}
					acc.argumentsBuf += delta.partial_json;
				}
			}
		}
		if (type === 'content_block_stop' && index !== undefined) {
			const acc = toolBuf.get(index);
			if (acc?.id && acc.name) {
				try {
					const args = acc.argumentsBuf.length > 0 ? JSON.parse(acc.argumentsBuf) : {};
					chunk.deltaToolCalls = [{ id: acc.id, name: acc.name, arguments: args }];
				} catch {
					log.warn?.(`Bedrock tool call dropped: malformed arguments (id=${acc.id}, name=${acc.name})`);
				}
				toolBuf.delete(index);
			}
		}
		if (type === 'message_delta' && delta?.stop_reason) {
			finalFinishReason = mapAnthropicStopReason(delta.stop_reason);
			chunk.finishReason = finalFinishReason;
		}
		if (chunk.deltaContent || chunk.deltaToolCalls || chunk.finishReason) yield chunk;
	}

	if (!finalFinishReason && toolBuf.size > 0) {
		const tail: Partial<ToolCall>[] = [];
		for (const acc of toolBuf.values()) {
			if (!acc.id || !acc.name) continue;
			try {
				const args = acc.argumentsBuf.length > 0 ? JSON.parse(acc.argumentsBuf) : {};
				tail.push({ id: acc.id, name: acc.name, arguments: args });
			} catch {
				log.warn?.(`Bedrock tool call dropped on flush (id=${acc.id}, name=${acc.name})`);
			}
		}
		toolBuf.clear();
		if (tail.length > 0) yield { deltaToolCalls: tail };
	}
}

async function* parseFlatStream(
	family: Family,
	body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>
): AsyncGenerator<GenerateChunk> {
	// Llama / Titan / Mistral / Cohere via Bedrock all emit one JSON object
	// per stream chunk with a family-specific "delta-content" field. We yield
	// each as a GenerateChunk and rely on the final chunk's stop_reason
	// (or family equivalent) to terminate.
	const decoder = new TextDecoder('utf-8');
	for await (const event of body) {
		if (!event.chunk?.bytes) continue;
		const text = decoder.decode(event.chunk.bytes);
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new BedrockBackendError('Invalid JSON in Bedrock stream chunk');
		}
		const chunk: GenerateChunk = {};
		const deltaContent = extractFlatDeltaContent(family, parsed);
		if (deltaContent && deltaContent.length > 0) chunk.deltaContent = deltaContent;
		const stopReason = extractFlatStopReason(family, parsed);
		if (stopReason) chunk.finishReason = mapGenericStopReason(stopReason);
		if (chunk.deltaContent || chunk.finishReason) yield chunk;
	}
}

function extractFlatDeltaContent(family: Family, parsed: Record<string, unknown>): string | undefined {
	if (family === 'meta') return typeof parsed.generation === 'string' ? parsed.generation : undefined;
	if (family === 'amazon') return typeof parsed.outputText === 'string' ? parsed.outputText : undefined;
	if (family === 'mistral') {
		const outputs = Array.isArray(parsed.outputs) ? parsed.outputs : [];
		const first = (outputs[0] as Record<string, unknown>) ?? {};
		return typeof first.text === 'string' ? first.text : undefined;
	}
	if (family === 'cohere') {
		const generations = Array.isArray(parsed.generations) ? parsed.generations : [];
		const first = (generations[0] as Record<string, unknown>) ?? {};
		return typeof first.text === 'string' ? first.text : undefined;
	}
	return undefined;
}

function extractFlatStopReason(family: Family, parsed: Record<string, unknown>): string | undefined {
	if (family === 'meta') return parsed.stop_reason as string | undefined;
	if (family === 'amazon') return parsed.completionReason as string | undefined;
	if (family === 'mistral') {
		const outputs = Array.isArray(parsed.outputs) ? parsed.outputs : [];
		const first = (outputs[0] as Record<string, unknown>) ?? {};
		return first.stop_reason as string | undefined;
	}
	if (family === 'cohere') {
		const generations = Array.isArray(parsed.generations) ? parsed.generations : [];
		const first = (generations[0] as Record<string, unknown>) ?? {};
		return first.finish_reason as string | undefined;
	}
	return undefined;
}

// ---------- message translation (shared by Claude-on-Bedrock body) ----------

interface AnthropicContentBlock {
	type: 'text' | 'tool_use' | 'tool_result';
	text?: string;
	id?: string;
	name?: string;
	input?: object;
	tool_use_id?: string;
	content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
	role: 'user' | 'assistant';
	content: string | AnthropicContentBlock[];
}

function normalizeMessages(input: GenerateInput): { messages: Message[]; system?: string } {
	if (typeof input === 'string') return { messages: [{ role: 'user', content: input }] };
	if (Array.isArray(input)) {
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

/**
 * Throw if the caller supplied `tools` on a Bedrock model family that this
 * backend doesn't route them to. `capabilities()` advertises `tools: true`
 * at the backend level, but only Anthropic-via-Bedrock actually consumes
 * them in this PR — other families' body builders would silently drop
 * the tools, leaving the caller unable to distinguish "model chose not to
 * call" from "model never saw the tool". Loud error makes the
 * unsupported-family case unambiguous; capability negotiation should
 * eventually become model-aware (follow-up).
 */
function rejectToolsForFamily(input: GenerateInput, family: Family): void {
	const tools = extractTools(input);
	if (tools && tools.length > 0) {
		throw new BedrockBackendError(
			`Bedrock tool calls are not supported for model family '${family}' (only 'anthropic' models route tools in this version)`
		);
	}
}

function toAnthropicMessage(m: Message): AnthropicMessage {
	if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') {
		return { role: 'user', content: m.content };
	}
	if (m.role === 'tool') {
		return {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
		};
	}
	if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
		const blocks: AnthropicContentBlock[] = [];
		if (m.content) blocks.push({ type: 'text', text: m.content });
		for (const tc of m.toolCalls) {
			blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
		}
		return { role: 'assistant', content: blocks };
	}
	return { role: m.role, content: m.content };
}

function flattenToLlamaPrompt(input: GenerateInput): string {
	if (typeof input === 'string') return input;
	const messages = Array.isArray(input) ? input : input.messages;
	const system = !Array.isArray(input) && typeof input.system === 'string' ? input.system : undefined;
	const parts: string[] = [];
	if (system) parts.push(`<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${system}<|eot_id|>`);
	for (const m of messages) {
		parts.push(`<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`);
	}
	parts.push('<|start_header_id|>assistant<|end_header_id|>\n\n');
	return parts.join('');
}

function flattenToFlatPrompt(input: GenerateInput): string {
	if (typeof input === 'string') return input;
	const messages = Array.isArray(input) ? input : input.messages;
	const system = !Array.isArray(input) && typeof input.system === 'string' ? input.system : undefined;
	const parts: string[] = [];
	if (system) parts.push(`System: ${system}`);
	for (const m of messages) parts.push(`${m.role[0].toUpperCase()}${m.role.slice(1)}: ${m.content}`);
	parts.push('Assistant:');
	return parts.join('\n\n');
}

// ---------- finish-reason mapping ----------

function mapAnthropicStopReason(reason: string | null | undefined): GenerateResult['finishReason'] {
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

function mapGenericStopReason(reason: string | null | undefined): GenerateResult['finishReason'] {
	const r = (reason ?? '').toLowerCase();
	if (r === 'length' || r === 'max_tokens' || r === 'max_token' || r === 'truncated') return 'length';
	if (r === 'tool_calls' || r === 'tool_use' || r === 'function_call') return 'tool_calls';
	if (r === 'content_filter' || r === 'content_filtered') return 'content_filter';
	return 'stop';
}

// ---------- response parsing ----------

function parseInvokeModelResponse(response: { body?: Uint8Array | string }): Record<string, unknown> {
	if (!response.body) {
		throw new BedrockBackendError('Bedrock InvokeModel response missing body');
	}
	const text =
		typeof response.body === 'string' ? response.body : new TextDecoder('utf-8').decode(response.body as Uint8Array);
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new BedrockBackendError('Bedrock InvokeModel response body is not valid JSON');
	}
}
