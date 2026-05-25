'use strict';

const assert = require('node:assert/strict');
const {
	AnthropicBackend,
	AnthropicBackendError,
	registerAnthropicBackend,
} = require('#src/components/anthropic/index');
const { clearRegistry, resolveGenerative } = require('#src/resources/models/backendRegistry');

const ACCOUNTING = { tenantId: 'tid', app: '/test' };
const API_KEY = 'sk-ant-test';

function mockFetch(responder) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, init });
		const res = await responder({ url, init, callIndex: calls.length - 1 });
		return res;
	};
	fn.calls = calls;
	return fn;
}

function jsonResponse(body, { status = 200 } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function sseResponse(events) {
	const body = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			for (const event of events) {
				const payload = typeof event === 'string' ? event : JSON.stringify(event);
				const line = `event: ${typeof event === 'object' && event.type ? event.type : 'message'}\ndata: ${payload}\n\n`;
				controller.enqueue(enc.encode(line));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('AnthropicBackend', () => {
	describe('construction + shape', () => {
		it('reports name = "anthropic"', () => {
			const b = new AnthropicBackend({ apiKey: API_KEY });
			assert.strictEqual(b.name, 'anthropic');
		});

		it('advertises capabilities: embed=false, tools=true (per issue body)', () => {
			const b = new AnthropicBackend({ apiKey: API_KEY });
			assert.deepStrictEqual(b.capabilities(), {
				embed: false,
				generate: true,
				stream: true,
				tools: true,
				adapters: false,
			});
		});

		it('throws when apiKey is missing', () => {
			assert.throws(() => new AnthropicBackend({}), AnthropicBackendError);
		});

		it('throws when apiKey is the literal ${VAR} placeholder (env var unset)', () => {
			assert.throws(() => new AnthropicBackend({ apiKey: '${ANTHROPIC_API_KEY_NOT_SET}' }), /literal placeholder/);
		});

		it('defaults baseUrl to https://api.anthropic.com', async () => {
			const fetch = mockFetch(() => jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }));
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude-opus-4-7' }, fetch);
			await b.generate('hi', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'https://api.anthropic.com/v1/messages');
		});

		it('respects baseUrl override', async () => {
			const fetch = mockFetch(() => jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }));
			const b = new AnthropicBackend(
				{ apiKey: API_KEY, model: 'claude-opus-4-7', baseUrl: 'https://my-proxy.example.com' },
				fetch
			);
			await b.generate('hi', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'https://my-proxy.example.com/v1/messages');
		});

		it('sends x-api-key and anthropic-version headers', async () => {
			const fetch = mockFetch(() => jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }));
			const b = new AnthropicBackend({ apiKey: 'sk-ant-secret', model: 'claude' }, fetch);
			await b.generate('hi', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].init.headers['x-api-key'], 'sk-ant-secret');
			assert.strictEqual(fetch.calls[0].init.headers['anthropic-version'], '2023-06-01');
			// Specifically NOT the OpenAI Bearer pattern.
			assert.strictEqual(fetch.calls[0].init.headers.Authorization, undefined);
		});
	});

	describe('generate (non-streaming)', () => {
		function messagesResponse({
			contentBlocks = [{ type: 'text', text: 'hi there' }],
			stopReason = 'end_turn',
			usage,
		} = {}) {
			return jsonResponse({
				id: 'msg_x',
				type: 'message',
				role: 'assistant',
				content: contentBlocks,
				stop_reason: stopReason,
				usage: usage ?? { input_tokens: 5, output_tokens: 2 },
			});
		}

		it('POSTs /v1/messages with a string input wrapped as a single user message', async () => {
			const fetch = mockFetch(() => messagesResponse());
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			const result = await b.generate('hello', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.content, 'hi there');
			assert.strictEqual(result.output.finishReason, 'stop');
			assert.strictEqual(result.usage.promptTokens, 5);
			assert.strictEqual(result.usage.completionTokens, 2);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.messages, [{ role: 'user', content: 'hello' }]);
			assert.strictEqual(sent.stream, false);
			// max_tokens is required by Anthropic; we default it.
			assert.strictEqual(typeof sent.max_tokens, 'number');
			assert.ok(sent.max_tokens > 0);
		});

		it('extracts system messages to the top-level system field', async () => {
			const fetch = mockFetch(() => messagesResponse());
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await b.generate(
				[
					{ role: 'system', content: 'be brief' },
					{ role: 'user', content: 'q' },
				],
				{ accounting: ACCOUNTING }
			);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.system, 'be brief');
			assert.deepStrictEqual(sent.messages, [{ role: 'user', content: 'q' }]);
		});

		it('combines explicit system field with inline system messages', async () => {
			const fetch = mockFetch(() => messagesResponse());
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await b.generate(
				{
					messages: [
						{ role: 'system', content: 'B' },
						{ role: 'user', content: 'q' },
					],
					system: 'A',
				},
				{ accounting: ACCOUNTING }
			);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.system, 'A\n\nB');
		});

		it("translates tool definitions to Anthropic's input_schema shape", async () => {
			const fetch = mockFetch(() => messagesResponse());
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			const tools = [
				{ name: 'get_weather', description: 'weather lookup', parameters: { type: 'object', properties: {} } },
			];
			await b.generate({ messages: [{ role: 'user', content: 'q' }], tools }, { accounting: ACCOUNTING });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.tools, [
				{ name: 'get_weather', description: 'weather lookup', input_schema: { type: 'object', properties: {} } },
			]);
		});

		it('parses tool_use content blocks into GenerateResult.toolCalls', async () => {
			const fetch = mockFetch(() =>
				messagesResponse({
					contentBlocks: [
						{ type: 'text', text: '' },
						{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'SF' } },
					],
					stopReason: 'tool_use',
				})
			);
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.finishReason, 'tool_calls');
			assert.deepStrictEqual(result.output.toolCalls, [
				{ id: 'tu_1', name: 'get_weather', arguments: { location: 'SF' } },
			]);
		});

		it("maps stop_reason='max_tokens' to finishReason='length'", async () => {
			const fetch = mockFetch(() => messagesResponse({ stopReason: 'max_tokens' }));
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.finishReason, 'length');
		});

		it('honors opts.maxTokens', async () => {
			const fetch = mockFetch(() => messagesResponse());
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await b.generate('q', { accounting: ACCOUNTING, maxTokens: 256 });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.max_tokens, 256);
		});

		it('includes upstream error.message in HTTP-error', async () => {
			const fetch = mockFetch(
				() =>
					new Response(JSON.stringify({ error: { message: 'Invalid model: foo', type: 'invalid_request' } }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					})
			);
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await assert.rejects(() => b.generate('q', { accounting: ACCOUNTING }), /returned HTTP 400: Invalid model: foo/);
		});
	});

	describe('generateStream', () => {
		it('yields content deltas and a terminating finishReason', async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{ type: 'message_start', message: { id: 'x' } },
					{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
					{ type: 'content_block_stop', index: 0 },
					{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
					{ type: 'message_stop' },
				])
			);
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.strictEqual(chunks[0].deltaContent, 'hi');
			assert.strictEqual(chunks[1].deltaContent, ' there');
			assert.strictEqual(chunks[chunks.length - 1].finishReason, 'stop');
		});

		it('assembles streaming tool calls from content_block_delta input_json_delta events', async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{ type: 'message_start', message: { id: 'x' } },
					{
						type: 'content_block_start',
						index: 0,
						content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' },
					},
					{
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'input_json_delta', partial_json: '{"loc' },
					},
					{
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'input_json_delta', partial_json: 'ation":"SF"}' },
					},
					{ type: 'content_block_stop', index: 0 },
					{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
				])
			);
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream(
				{ messages: [{ role: 'user', content: 'q' }] },
				{ accounting: ACCOUNTING }
			)) {
				chunks.push(c);
			}
			const withToolCall = chunks.find((c) => c.deltaToolCalls);
			assert.ok(withToolCall);
			assert.deepStrictEqual(withToolCall.deltaToolCalls, [
				{ id: 'tu_1', name: 'get_weather', arguments: { location: 'SF' } },
			]);
			const terminal = chunks[chunks.length - 1];
			assert.strictEqual(terminal.finishReason, 'tool_calls');
		});

		it('caps tool-call arguments accumulator at 1 MiB', async () => {
			const half = 'x'.repeat(1 << 19);
			const fetch = mockFetch(() =>
				sseResponse([
					{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'fn' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: half } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: half } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: half } },
				])
			);
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await assert.rejects(async () => {
				for await (const _c of b.generateStream(
					{ messages: [{ role: 'user', content: 'q' }] },
					{ accounting: ACCOUNTING }
				)) {
					/* drain */
				}
			}, /tool-call arguments exceed/);
		});

		it('drops streamed tool calls with malformed JSON arguments', async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'bad', name: 'fn' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'not-json' } },
					{ type: 'content_block_stop', index: 0 },
					{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
				])
			);
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream(
				{ messages: [{ role: 'user', content: 'q' }] },
				{ accounting: ACCOUNTING }
			)) {
				chunks.push(c);
			}
			// Only the finishReason chunk should survive.
			const withToolCall = chunks.find((c) => c.deltaToolCalls);
			assert.strictEqual(withToolCall, undefined);
		});

		it('throws AnthropicBackendError on mid-stream upstream error events', async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{ type: 'message_start', message: { id: 'x' } },
					{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
					{ type: 'error', error: { type: 'overloaded_error', message: 'Anthropic is overloaded' } },
				])
			);
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await assert.rejects(async () => {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* drain */
				}
			}, /stream aborted by upstream error: Anthropic is overloaded/);
		});

		it('caps SSE buffer at 1 MiB without an event boundary', async () => {
			const huge = 'x'.repeat((1 << 20) + 1);
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(huge));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await assert.rejects(async () => {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* no-op */
				}
			}, /SSE buffer exceeds/);
		});
	});

	describe('AbortSignal', () => {
		it('passes caller signal through when no timeout configured', async () => {
			const ctrl = new AbortController();
			let seen;
			const fetch = mockFetch(({ init }) => {
				seen = init.signal;
				return jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} });
			});
			const b = new AnthropicBackend({ apiKey: API_KEY, model: 'claude' }, fetch);
			await b.generate('q', { accounting: ACCOUNTING, signal: ctrl.signal });
			assert.strictEqual(seen, ctrl.signal);
		});
	});
});

describe('registerAnthropicBackend', () => {
	beforeEach(() => clearRegistry());

	it('registers as a generative backend', () => {
		registerAnthropicBackend({
			logicalName: 'claude',
			kind: 'generative',
			config: { apiKey: API_KEY, model: 'claude-opus-4-7' },
		});
		const b = resolveGenerative('claude');
		assert.strictEqual(b.name, 'anthropic');
	});

	it('throws on embedding kind (Anthropic has no embedding API)', () => {
		assert.throws(
			() =>
				registerAnthropicBackend({
					logicalName: 'whatever',
					kind: 'embedding',
					config: { apiKey: API_KEY, model: 'foo' },
				}),
			AnthropicBackendError
		);
	});
});
