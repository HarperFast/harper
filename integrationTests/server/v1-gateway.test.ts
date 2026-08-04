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
 * NOTE: `modelsGateway: { enabled: true }` is passed explicitly because
 * defaultConfig.yaml ships no `modelsGateway` block at all — an absent key is
 * what keeps the loader from importing this module graph on instances that do
 * not use the gateway. The test harness plumbs this via HARPER_SET_CONFIG,
 * which is also what makes the block exist for this run. This suite runs against a bare
 * instance (no deployed apps), so it also declares an explicit `rest` section
 * below: the gateway deliberately does NOT force REST to start (see
 * resources/models/v1/index.ts), so a real deployment must configure `rest`
 * itself, and this suite mirrors that requirement.
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

suite('OpenAI /v1/* gateway (modelsGateway)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			config: {
				// The gateway's resources are served by REST's middleware chain, and the
				// gateway does not force REST to start (see resources/models/v1/index.ts).
				// defaultConfig.yaml ships no `rest` section, so a bare instance needs one
				// declared here — exactly as a real deployment would. `webSocket` is a leaf
				// value because a plain empty object is dropped by flattenObject().
				rest: { webSocket: true },
				// Gateway is off by default — defaultConfig.yaml ships no modelsGateway
				// block. Pass enabled: true explicitly to activate it. A plain empty
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

	test('POST /v1/chat/completions returns 400 (not 500) for malformed nested wire shapes', async () => {
		// Each of these used to throw a TypeError inside the mappers, surfacing as an
		// RFC 9457 500 rather than an OpenAI 400.
		const malformed: Array<[string, unknown]> = [
			['null message element', { model: 'default', messages: [null] }],
			[
				'tool_calls entry with no function',
				{ model: 'default', messages: [{ role: 'assistant', content: null, tool_calls: [{}] }] },
			],
			['tools entry with no function', { model: 'default', messages: [{ role: 'user', content: 'hi' }], tools: [{}] }],
		];
		for (const [label, payload] of malformed) {
			const res = await harperFetch(ctx, restUrl(ctx, '/v1/chat/completions'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify(payload),
			});
			assert.equal(res.status, 400, `${label}: expected 400, got ${res.status}`);
			const body = (await res.json()) as { error: { type: string } };
			assert.equal(body.error.type, 'invalid_request_error', `${label}: wrong error type`);
		}
	});

	// -----------------------------------------------------------------------
	// Explicit SSE Accept header — dispatched as CONNECT by REST, not POST
	// -----------------------------------------------------------------------

	test('an SSE client sending exact Accept: text/event-stream is served, not method-not-allowed', async () => {
		// REST rewrites POST + `Accept: text/event-stream` to CONNECT. The OpenAI SDK dodges
		// this by always sending application/json, but other valid SSE clients do not — this
		// exercises the connect() delegation.
		const res = await harperFetch(ctx, restUrl(ctx, '/v1/chat/completions'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
			body: JSON.stringify({
				model: 'default',
				messages: [{ role: 'user', content: 'tell me something' }],
				stream: true,
			}),
		});
		assert.notEqual(res.status, 405, 'explicit SSE Accept must not be method-not-allowed');
		assert.equal(res.status, 200, `expected 200, got ${res.status}`);
		assert.equal(res.headers.get('content-type'), 'text/event-stream');
		const text = await res.text();
		assert.ok(text.includes('data:'), `expected SSE data frames, got: ${text.slice(0, 200)}`);

		// Reassemble the deltas the way a client does: the fixture streams word by word, so
		// the content is split ACROSS frames and never appears contiguously in the raw text.
		const content = text
			.split('\n')
			.filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
			.map((line) => {
				try {
					return JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content ?? '';
				} catch {
					return '';
				}
			})
			.join('');
		assert.ok(content.includes('[echo stream]'), `unexpected reassembled content: ${content}`);
	});

	// -----------------------------------------------------------------------
	// POST /v1/chat/completions — streaming via real OpenAI SDK
	// -----------------------------------------------------------------------

	test('streaming chat completions are parseable by the real OpenAI SDK (stream: true)', async () => {
		// The OpenAI SDK sends Accept: application/json even for streaming requests,
		// so the stream: true request lands in post() via Harper's REST layer.
		// This test validates the full SSE framing path end-to-end.
		//
		// The SDK sends its apiKey as `Authorization: Bearer <key>`. A present-but-
		// invalid credential is rejected by Harper's auth (401 "invalid token") even
		// under AUTHENTICATION_AUTHORIZELOCAL (which only covers requests with no
		// credentials at all). Mint a real operation token — this is also the
		// documented production flow: a Harper JWT is the OpenAI api key.
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

		const { OpenAI } = (await import('openai')) as { OpenAI: new (opts: object) => any };
		const client = new OpenAI({
			apiKey: operation_token,
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
});
