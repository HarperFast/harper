/**
 * Integration test for the OpenAI-compatible `/v1/*` REST gateway (#631).
 *
 * Starts a real Harper instance with `modelsGateway: { enabled: true }` and a
 * deterministic echo backend registered via the `registerFromModule` path.
 * Exercises all three endpoints:
 *   GET  /v1/models               — list registered backends
 *   POST /v1/embeddings           — embed a string
 *   POST /v1/chat/completions     — non-streaming and streaming chat
 *
 * The streaming test uses the real OpenAI Node.js SDK to confirm that the
 * SSE framing (openaiStream → serializeStream → HTTP) is parseable by an
 * unmodified OpenAI client. See the SSE serving-path note in chatCompletions.ts
 * for why `stream: true` routes through `post()` rather than `connect()`.
 *
 * The LangChain.js tests do the same with an unmodified `@langchain/openai`
 * client (chat, streaming chat, embeddings), closing out the #631 acceptance
 * criterion "unmodified LangChain.js / OpenAI SDK client completes a chat".
 *
 * NOTE: `modelsGateway: { enabled: true }` is passed explicitly because the
 * gateway is off by default (`enabled: false` in defaultConfig.yaml). The test
 * harness plumbs this via HARPER_SET_CONFIG. This suite runs against a bare
 * instance (no deployed apps), so no component config contains a `rest` key —
 * the gateway itself must activate REST serving (REST.ensureStarted) for these
 * endpoints to be reachable. That activation is part of what this suite covers.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ECHO_BACKEND_PATH = resolvePath(__dirname, 'fixtures/v1-gateway-test-backend.cjs');

function restUrl(ctx: ContextWithHarper, path: string): string {
	return `${ctx.harper.httpURL}${path}`;
}

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

/** Fetch helper that always injects Basic auth. */
async function harperFetch(ctx: ContextWithHarper, url: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', authHeader(ctx));
	return fetch(url, { ...init, headers });
}

/**
 * Mint a real operation token to use as the OpenAI-client api key.
 *
 * SDK clients send their apiKey as `Authorization: Bearer <key>`. A present-but-
 * invalid credential is rejected by Harper's auth (401 "invalid token") even
 * under AUTHENTICATION_AUTHORIZELOCAL (which only covers requests with no
 * credentials at all). This is also the documented production flow: a Harper
 * JWT is the OpenAI api key.
 */
async function mintOperationToken(ctx: ContextWithHarper): Promise<string> {
	const tokenRes = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body: JSON.stringify({
			operation: 'create_authentication_tokens',
			username: ctx.harper.admin.username,
			password: ctx.harper.admin.password,
		}),
	});
	const { operation_token } = (await tokenRes.json()) as { operation_token: string };
	assert.ok(operation_token, 'expected create_authentication_tokens to return an operation_token');
	return operation_token;
}

suite('OpenAI /v1/* gateway (modelsGateway)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			config: {
				// Gateway is off by default (enabled: false in defaultConfig.yaml). Pass
				// enabled: true explicitly to activate it for these tests. A plain empty
				// object would be silently dropped by flattenObject() in harperConfigEnvVars.ts
				// because it has no leaf paths to flatten.
				modelsGateway: { enabled: true },
				models: {
					generative: {
						default: { backend: ECHO_BACKEND_PATH },
					},
					embedding: {
						default: { backend: ECHO_BACKEND_PATH },
					},
				},
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// -----------------------------------------------------------------------
	// GET /v1/models
	// -----------------------------------------------------------------------

	test('GET /v1/models returns the registered backends in OpenAI model list shape', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/models'));
		assert.equal(res.status, 200, `expected 200, got ${res.status}`);
		const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string }> };
		assert.equal(body.object, 'list');
		assert.ok(Array.isArray(body.data), 'expected data array');
		const ids = body.data.map((m) => m.id);
		assert.ok(ids.includes('default'), `expected 'default' backend in model ids, got: ${ids.join(', ')}`);
		for (const entry of body.data) {
			assert.equal(entry.object, 'model');
		}
	});

	// -----------------------------------------------------------------------
	// POST /v1/embeddings
	// -----------------------------------------------------------------------

	test('POST /v1/embeddings returns embedding vectors in OpenAI list shape', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/embeddings'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ model: 'default', input: 'hello world' }),
		});
		const text = await res.text();
		assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
		const body = JSON.parse(text) as {
			object: string;
			data: Array<{ embedding: number[]; index: number; object: string }>;
		};
		assert.equal(body.object, 'list');
		assert.equal(body.data.length, 1);
		assert.equal(body.data[0].object, 'embedding');
		assert.equal(body.data[0].index, 0);
		assert.ok(Array.isArray(body.data[0].embedding));
		assert.ok(body.data[0].embedding.length > 0);
	});

	test('POST /v1/embeddings supports batched input', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/embeddings'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ model: 'default', input: ['foo', 'bar', 'baz'] }),
		});
		assert.equal(res.status, 200);
		const body = (await res.json()) as { data: Array<{ index: number }> };
		assert.equal(body.data.length, 3);
		// Indices must be in order
		assert.equal(body.data[0].index, 0);
		assert.equal(body.data[1].index, 1);
		assert.equal(body.data[2].index, 2);
	});

	test('POST /v1/embeddings honors encoding_format: base64', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/embeddings'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ model: 'default', input: 'hello world', encoding_format: 'base64' }),
		});
		const text = await res.text();
		assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
		const body = JSON.parse(text) as { data: Array<{ embedding: string }> };
		assert.equal(typeof body.data[0].embedding, 'string', 'expected base64 string embedding');
		const buf = Buffer.from(body.data[0].embedding, 'base64');
		assert.equal(buf.byteLength % 4, 0, 'expected float32-aligned byte length');
		const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
		assert.ok(floats.length > 0);
		assert.ok(Math.abs(floats[0] - 0.1) < 1e-6, `expected first float ~0.1, got ${floats[0]}`);
	});

	test('POST /v1/embeddings rejects an unknown encoding_format', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/embeddings'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ model: 'default', input: 'hello', encoding_format: 'int8' }),
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: { type: string } };
		assert.equal(body.error.type, 'invalid_request_error');
	});

	test('POST /v1/embeddings returns 400 with OpenAI error shape when input is missing', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/embeddings'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ model: 'default' }),
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: { type: string; message: string } };
		assert.equal(body.error.type, 'invalid_request_error');
		assert.ok(body.error.message.length > 0);
	});

	// -----------------------------------------------------------------------
	// POST /v1/chat/completions — non-streaming
	// -----------------------------------------------------------------------

	test('POST /v1/chat/completions returns a chat.completion object (non-streaming)', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/chat/completions'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({
				model: 'default',
				messages: [{ role: 'user', content: 'hello' }],
			}),
		});
		const text = await res.text();
		assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
		const body = JSON.parse(text) as {
			id: string;
			object: string;
			choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
			usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
		};
		assert.equal(body.object, 'chat.completion');
		assert.ok(typeof body.id === 'string' && body.id.startsWith('chatcmpl-'));
		assert.equal(body.choices.length, 1);
		assert.equal(body.choices[0].message.role, 'assistant');
		assert.ok(typeof body.choices[0].message.content === 'string');
		assert.ok(body.choices[0].message.content.includes('[echo]'), `unexpected: ${body.choices[0].message.content}`);
		assert.equal(body.choices[0].finish_reason, 'stop');
		assert.ok(typeof body.usage.prompt_tokens === 'number');
		assert.ok(typeof body.usage.completion_tokens === 'number');
	});

	test('POST /v1/chat/completions returns 400 with OpenAI error shape when messages missing', async () => {
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/chat/completions'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
			body: JSON.stringify({ model: 'default' }),
		});
		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: { type: string } };
		assert.equal(body.error.type, 'invalid_request_error');
	});

	// -----------------------------------------------------------------------
	// POST /v1/chat/completions — streaming via real OpenAI SDK
	// -----------------------------------------------------------------------

	test('streaming chat completions are parseable by the real OpenAI SDK (stream: true)', async () => {
		// The OpenAI SDK sends Accept: application/json even for streaming requests,
		// so the stream: true request lands in post() via Harper's REST layer.
		// This test validates the full SSE framing path end-to-end.
		const { OpenAI } = (await import('openai')) as { OpenAI: new (opts: object) => any };
		const client = new OpenAI({
			apiKey: await mintOperationToken(ctx),
			baseURL: `${ctx.harper.httpURL}/v1`,
		});

		const chunks: string[] = [];
		const stream = client.chat.completions.stream({
			model: 'default',
			messages: [{ role: 'user', content: 'tell me something' }],
		});

		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta?.content;
			if (delta) chunks.push(delta);
		}

		const content = chunks.join('');
		assert.ok(content.length > 0, 'expected non-empty streamed content');
		assert.ok(content.includes('[echo stream]'), `unexpected content: ${content}`);

		const completion = await stream.finalChatCompletion();
		assert.equal(completion.object, 'chat.completion');
		assert.equal(completion.choices[0].finish_reason, 'stop');
	});

	// -----------------------------------------------------------------------
	// LangChain.js e2e — unmodified @langchain/openai client (#631 acceptance)
	// -----------------------------------------------------------------------

	test('LangChain.js ChatOpenAI completes a chat against Harper (non-streaming)', async () => {
		const { ChatOpenAI } = await import('@langchain/openai');
		const chat = new ChatOpenAI({
			model: 'default',
			apiKey: await mintOperationToken(ctx),
			configuration: { baseURL: `${ctx.harper.httpURL}/v1` },
		});

		const res = await chat.invoke([{ role: 'user' as const, content: 'hello from langchain' }]);
		assert.ok(typeof res.content === 'string', `expected string content, got ${typeof res.content}`);
		assert.ok(res.content.includes('[echo]'), `unexpected content: ${res.content}`);
		// Usage flows through: gateway usage → OpenAI shape → LangChain usage_metadata
		assert.ok(res.usage_metadata, 'expected usage_metadata on the AIMessage');
		assert.ok(res.usage_metadata.total_tokens > 0, 'expected non-zero total_tokens');
	});

	test('LangChain.js ChatOpenAI streams a chat against Harper', async () => {
		// LangChain sends stream_options: { include_usage: true } by default; the
		// gateway ignores unknown request fields, and LangChain tolerates the
		// absence of a trailing usage chunk.
		const { ChatOpenAI } = await import('@langchain/openai');
		const chat = new ChatOpenAI({
			model: 'default',
			apiKey: await mintOperationToken(ctx),
			configuration: { baseURL: `${ctx.harper.httpURL}/v1` },
		});

		const chunks: string[] = [];
		const stream = await chat.stream('tell me something');
		for await (const chunk of stream) {
			if (typeof chunk.content === 'string' && chunk.content) chunks.push(chunk.content);
		}

		const content = chunks.join('');
		assert.ok(chunks.length > 1, `expected multiple streamed chunks, got ${chunks.length}`);
		assert.ok(content.includes('[echo stream]'), `unexpected content: ${content}`);
	});

	test('LangChain.js OpenAIEmbeddings embeds a query against Harper', async () => {
		// The underlying OpenAI SDK defaults to encoding_format: 'base64' when the
		// caller does not specify one and unconditionally base64-decodes the
		// response, so this exercises the gateway's base64 encoding path — a
		// float-array response here would come back silently corrupted.
		const { OpenAIEmbeddings } = await import('@langchain/openai');
		const embeddings = new OpenAIEmbeddings({
			model: 'default',
			apiKey: await mintOperationToken(ctx),
			configuration: { baseURL: `${ctx.harper.httpURL}/v1` },
		});

		const vector = await embeddings.embedQuery('hello world');
		assert.ok(Array.isArray(vector), 'expected an array embedding');
		assert.ok(vector.length > 0, 'expected non-empty embedding');
		assert.ok(
			vector.every((n) => typeof n === 'number' && Number.isFinite(n)),
			'expected finite numeric embedding values'
		);

		const batch = await embeddings.embedDocuments(['foo', 'bar', 'baz']);
		assert.equal(batch.length, 3);
		for (const v of batch) {
			assert.ok(Array.isArray(v) && v.length > 0);
		}
	});
});
