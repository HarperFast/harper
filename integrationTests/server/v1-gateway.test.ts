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
 * NOTE: `modelsGateway: { enabled: true }` is passed explicitly because the
 * gateway is off by default (`enabled: false` in defaultConfig.yaml). The test
 * harness plumbs this via HARPER_SET_CONFIG. On CI (Linux, fast startup), the
 * env-var config can race component loading; that race is tracked in #1618 and
 * the fix there will make this test reliable without needing further changes here.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve as resolvePath, join } from 'node:path';
import { readFile } from 'node:fs/promises';
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

		// TEMP #1616-debug (revert before merge): dump what the child actually resolved.
		try {
			const cfgPath = join(ctx.harper.dataRootDir, 'harper-config.yaml');
			const cfgText = await readFile(cfgPath, 'utf8');
			const mgLines = cfgText
				.split('\n')
				.filter((l, i, a) => /modelsGateway/.test(l) || (i > 0 && /modelsGateway/.test(a[i - 1])));
			console.error(`[1616-debug] harper-config.yaml modelsGateway block: ${JSON.stringify(mgLines)}`);
		} catch (err) {
			console.error(`[1616-debug] failed reading child config file: ${(err as Error).message}`);
		}
		try {
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
				body: JSON.stringify({ operation: 'get_configuration' }),
			});
			const cfg = (await res.json()) as Record<string, unknown>;
			console.error(`[1616-debug] get_configuration.modelsGateway=${JSON.stringify(cfg.modelsGateway)}`);
		} catch (err) {
			console.error(`[1616-debug] get_configuration failed: ${(err as Error).message}`);
		}
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
		assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as {
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
		assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as {
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
		//
		// AUTHENTICATION_AUTHORIZELOCAL=true (set by the test harness) means all
		// requests from loopback addresses bypass auth, so the SDK's `apiKey` is
		// not validated — any non-empty string works.
		const { OpenAI } = (await import('openai')) as { OpenAI: new (opts: object) => any };
		const client = new OpenAI({
			apiKey: 'test-key',
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
