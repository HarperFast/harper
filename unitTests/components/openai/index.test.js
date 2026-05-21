'use strict';

const assert = require('node:assert/strict');
const { OpenAIBackend, OpenAIBackendError, registerOpenAIBackend } = require('#src/components/openai/index');
const { clearRegistry, resolveEmbedding, resolveGenerative } = require('#src/resources/models/backendRegistry');

const ACCOUNTING = { tenantId: 'tid', app: '/test' };
const API_KEY = 'sk-test';

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

function sseResponse(events, { includeDone = true } = {}) {
	const encoder = new TextEncoder();
	const body = new ReadableStream({
		start(controller) {
			for (const event of events) {
				const payload = typeof event === 'string' ? event : JSON.stringify(event);
				controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
			}
			if (includeDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('OpenAIBackend', () => {
	describe('construction + shape', () => {
		it('reports name = "openai"', () => {
			const b = new OpenAIBackend({ apiKey: API_KEY });
			assert.strictEqual(b.name, 'openai');
		});

		it('advertises capabilities matching the issue body (tools: true)', () => {
			const b = new OpenAIBackend({ apiKey: API_KEY });
			assert.deepStrictEqual(b.capabilities(), {
				embed: true,
				generate: true,
				stream: true,
				tools: true,
				adapters: false,
			});
		});

		it('throws OpenAIBackendError when apiKey is missing', () => {
			assert.throws(() => new OpenAIBackend({}), OpenAIBackendError);
		});

		it('throws OpenAIBackendError when apiKey is the literal ${VAR} placeholder (env var unset)', () => {
			assert.throws(() => new OpenAIBackend({ apiKey: '${OPENAI_API_KEY_NOT_SET}' }), /literal placeholder/);
		});

		it("defaults baseUrl to 'https://api.openai.com/v1'", async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'https://api.openai.com/v1/embeddings');
		});

		it('respects a baseUrl override (Azure / Together / OpenRouter / vLLM)', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }] }));
			const b = new OpenAIBackend(
				{ apiKey: API_KEY, model: 'm', baseUrl: 'https://my-azure.openai.azure.com/openai/v1' },
				fetch
			);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'https://my-azure.openai.azure.com/openai/v1/embeddings');
		});

		it('strips trailing slash on baseUrl', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm', baseUrl: 'https://api.openai.com/v1/' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'https://api.openai.com/v1/embeddings');
		});

		it('sends Authorization: Bearer <apiKey> header', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }] }));
			const b = new OpenAIBackend({ apiKey: 'sk-secret', model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].init.headers.Authorization, 'Bearer sk-secret');
		});

		it('sends OpenAI-Organization header when configured', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm', organization: 'org-abc' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].init.headers['OpenAI-Organization'], 'org-abc');
		});

		it('omits OpenAI-Organization when not configured', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].init.headers['OpenAI-Organization'], undefined);
		});
	});

	describe('embed', () => {
		it('POSTs /embeddings and returns Float32Array vectors', async () => {
			const fetch = mockFetch(() =>
				jsonResponse({
					data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
					usage: { prompt_tokens: 7, total_tokens: 7 },
				})
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'text-embedding-3-small' }, fetch);
			const result = await b.embed('hello', { accounting: ACCOUNTING });
			assert.strictEqual(result.status, 'completed');
			assert.strictEqual(result.output.length, 1);
			assert.ok(result.output[0] instanceof Float32Array);
			assert.strictEqual(result.usage.embeddingTokens, 7);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.model, 'text-embedding-3-small');
			assert.deepStrictEqual(sent.input, ['hello']);
		});

		it('handles batch input with multiple vectors', async () => {
			const fetch = mockFetch(() =>
				jsonResponse({
					data: [
						{ embedding: [0.1], index: 0 },
						{ embedding: [0.2], index: 1 },
					],
				})
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const result = await b.embed(['a', 'b'], { accounting: ACCOUNTING });
			assert.strictEqual(result.output.length, 2);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.input, ['a', 'b']);
		});

		it('sorts vectors by index even when OpenAI returns them out of order', async () => {
			const fetch = mockFetch(() =>
				jsonResponse({
					data: [
						{ embedding: [0.2], index: 1 },
						{ embedding: [0.1], index: 0 },
					],
				})
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const result = await b.embed(['a', 'b'], { accounting: ACCOUNTING });
			assert.strictEqual(result.output[0][0], new Float32Array([0.1])[0]);
			assert.strictEqual(result.output[1][0], new Float32Array([0.2])[0]);
		});

		it('overrides the configured model with opts.model', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'configured' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING, model: 'override' });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.model, 'override');
		});

		it('throws when no model is configured or passed', async () => {
			const fetch = mockFetch(() => jsonResponse({}));
			const b = new OpenAIBackend({ apiKey: API_KEY }, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), OpenAIBackendError);
		});

		it('throws on vector-count mismatch', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1], index: 0 }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(() => b.embed(['a', 'b'], { accounting: ACCOUNTING }), /returned 1 vectors for 2 inputs/);
		});

		it('throws when a vector contains non-finite values', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1, null, 0.3], index: 0 }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), /not an array of finite numbers/);
		});

		it('drops non-finite prompt_tokens from usage', async () => {
			const fetch = mockFetch(() => jsonResponse({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: NaN } }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const result = await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(result.usage.embeddingTokens, undefined);
		});

		it('wraps non-JSON response bodies in OpenAIBackendError', async () => {
			const fetch = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), /returned a non-JSON response body/);
		});

		it('throws OpenAIBackendError on non-2xx HTTP', async () => {
			const fetch = mockFetch(() => new Response('rate-limit info', { status: 429 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), /returned HTTP 429/);
		});

		it('includes upstream OpenAI error.message in the thrown error when available', async () => {
			const fetch = mockFetch(
				() =>
					new Response(JSON.stringify({ error: { message: 'Invalid model: gpt-9000', type: 'invalid_request' } }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					})
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(
				() => b.embed('x', { accounting: ACCOUNTING }),
				/returned HTTP 400: Invalid model: gpt-9000/
			);
		});

		it('falls back to status-only when the error body is not the OpenAI envelope', async () => {
			const fetch = mockFetch(() => new Response('not-json', { status: 500 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), /returned HTTP 500$/);
		});

		it('truncates pathologically long upstream error messages', async () => {
			const longMessage = 'x'.repeat(2000);
			const fetch = mockFetch(
				() =>
					new Response(JSON.stringify({ error: { message: longMessage } }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					})
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			try {
				await b.embed('x', { accounting: ACCOUNTING });
				assert.fail('expected OpenAIBackendError');
			} catch (err) {
				// 500-char cap + truncation marker + status prefix + small fixed
				// text; total message length should be well under the raw 2000.
				assert.ok(err.message.length < 2000);
				assert.ok(err.message.includes('…'));
			}
		});
	});

	describe('generate (non-streaming)', () => {
		function chatResponse({ content = 'hi', toolCalls, finishReason = 'stop', usage } = {}) {
			const message = { role: 'assistant', content };
			if (toolCalls) message.tool_calls = toolCalls;
			return jsonResponse({
				choices: [{ message, finish_reason: finishReason }],
				usage: usage ?? { prompt_tokens: 5, completion_tokens: 2 },
			});
		}

		it('POSTs /chat/completions with a string input as one user message', async () => {
			const fetch = mockFetch(() => chatResponse({ content: 'reply' }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'gpt-4o-mini' }, fetch);
			const result = await b.generate('hello', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.content, 'reply');
			assert.strictEqual(result.output.finishReason, 'stop');
			assert.strictEqual(result.usage.promptTokens, 5);
			assert.strictEqual(result.usage.completionTokens, 2);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.stream, false);
			assert.deepStrictEqual(sent.messages, [{ role: 'user', content: 'hello' }]);
		});

		it('uses a messages array directly', async () => {
			const fetch = mockFetch(() => chatResponse());
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'gpt-4o-mini' }, fetch);
			await b.generate(
				[
					{ role: 'system', content: 'be brief' },
					{ role: 'user', content: 'q' },
				],
				{ accounting: ACCOUNTING }
			);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.messages, [
				{ role: 'system', content: 'be brief' },
				{ role: 'user', content: 'q' },
			]);
		});

		it("prepends 'system' string into messages on the object input variant", async () => {
			const fetch = mockFetch(() => chatResponse());
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'gpt-4o-mini' }, fetch);
			await b.generate(
				{ messages: [{ role: 'user', content: 'q' }], system: 'be helpful' },
				{ accounting: ACCOUNTING }
			);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.messages[0], { role: 'system', content: 'be helpful' });
			assert.deepStrictEqual(sent.messages[1], { role: 'user', content: 'q' });
		});

		it('forwards tools to OpenAI in the correct shape', async () => {
			const fetch = mockFetch(() => chatResponse());
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'gpt-4o-mini' }, fetch);
			const tools = [
				{ name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: {} } },
			];
			await b.generate({ messages: [{ role: 'user', content: 'q' }], tools }, { accounting: ACCOUNTING });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.tools, [
				{
					type: 'function',
					function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: {} } },
				},
			]);
		});

		it('parses tool_calls from the response and exposes them on GenerateResult.toolCalls', async () => {
			const fetch = mockFetch(() =>
				chatResponse({
					content: null,
					toolCalls: [
						{
							id: 'call_abc',
							type: 'function',
							function: { name: 'get_weather', arguments: '{"location":"SF"}' },
						},
					],
					finishReason: 'tool_calls',
				})
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'gpt-4o-mini' }, fetch);
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.finishReason, 'tool_calls');
			assert.deepStrictEqual(result.output.toolCalls, [
				{ id: 'call_abc', name: 'get_weather', arguments: { location: 'SF' } },
			]);
		});

		it('drops tool calls with malformed JSON arguments', async () => {
			const fetch = mockFetch(() =>
				chatResponse({
					toolCalls: [
						{ id: 'call_ok', type: 'function', function: { name: 'ok', arguments: '{"a":1}' } },
						{ id: 'call_bad', type: 'function', function: { name: 'bad', arguments: 'not-json' } },
					],
					finishReason: 'tool_calls',
				})
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.toolCalls.length, 1);
			assert.strictEqual(result.output.toolCalls[0].id, 'call_ok');
		});

		it("maps responseFormat='json' to OpenAI's response_format json_object", async () => {
			const fetch = mockFetch(() => chatResponse());
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await b.generate('q', { accounting: ACCOUNTING, responseFormat: 'json' });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.response_format, { type: 'json_object' });
		});

		it("maps responseFormat={ schema } to OpenAI's json_schema form", async () => {
			const fetch = mockFetch(() => chatResponse());
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const schema = { type: 'object', properties: { a: { type: 'string' } } };
			await b.generate('q', { accounting: ACCOUNTING, responseFormat: { schema } });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.response_format, {
				type: 'json_schema',
				json_schema: { name: 'output', schema, strict: true },
			});
		});

		it('maps temperature and maxTokens to OpenAI fields', async () => {
			const fetch = mockFetch(() => chatResponse());
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await b.generate('q', { accounting: ACCOUNTING, temperature: 0.5, maxTokens: 100 });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.temperature, 0.5);
			assert.strictEqual(sent.max_tokens, 100);
		});

		it("maps finish_reason='length' to finishReason='length'", async () => {
			const fetch = mockFetch(() => chatResponse({ finishReason: 'length' }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.finishReason, 'length');
		});

		it("maps finish_reason='content_filter' to finishReason='content_filter'", async () => {
			const fetch = mockFetch(() => chatResponse({ finishReason: 'content_filter' }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.finishReason, 'content_filter');
		});

		it('drops non-integer / non-finite token counts from usage', async () => {
			const fetch = mockFetch(() => chatResponse({ usage: { prompt_tokens: NaN, completion_tokens: -3 } }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const result = await b.generate('q', { accounting: ACCOUNTING });
			assert.strictEqual(result.usage.promptTokens, undefined);
			assert.strictEqual(result.usage.completionTokens, undefined);
		});

		it('throws when choices[0] is missing', async () => {
			const fetch = mockFetch(() => jsonResponse({}));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(() => b.generate('q', { accounting: ACCOUNTING }), /missing choices\[0\]/);
		});

		it('throws when content is non-string', async () => {
			const fetch = mockFetch(() => jsonResponse({ choices: [{ message: { role: 'assistant', content: 42 } }] }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(() => b.generate('q', { accounting: ACCOUNTING }), /content is not a string/);
		});
	});

	describe('generateStream', () => {
		it('yields a chunk per SSE event with deltaContent', async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{ choices: [{ delta: { role: 'assistant' } }] },
					{ choices: [{ delta: { content: 'hello ' } }] },
					{ choices: [{ delta: { content: 'world' } }] },
					{ choices: [{ delta: {}, finish_reason: 'stop' }] },
				])
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'gpt-4o-mini' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.deepStrictEqual(chunks[0], { deltaContent: 'hello ' });
			assert.deepStrictEqual(chunks[1], { deltaContent: 'world' });
			assert.deepStrictEqual(chunks[2], { finishReason: 'stop' });
		});

		it('sets stream:true on the request body', async () => {
			const fetch = mockFetch(() => sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
				/* drain */
			}
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.stream, true);
		});

		it('handles SSE events split across HTTP chunk boundaries', async () => {
			const body = new ReadableStream({
				start(controller) {
					const enc = new TextEncoder();
					controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hel'));
					controller.enqueue(
						enc.encode('lo"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
					);
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.strictEqual(chunks[0].deltaContent, 'hello');
			assert.strictEqual(chunks[1].finishReason, 'stop');
		});

		it('terminates cleanly on [DONE] (any events after are ignored)', async () => {
			const body = new ReadableStream({
				start(controller) {
					const enc = new TextEncoder();
					controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
					controller.enqueue(enc.encode('data: [DONE]\n\n'));
					// content after [DONE] should not be yielded
					controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ghost"}}]}\n\n'));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.strictEqual(chunks.length, 1);
			assert.strictEqual(chunks[0].deltaContent, 'a');
		});

		it('ignores SSE comment lines (lines starting with :)', async () => {
			const body = new ReadableStream({
				start(controller) {
					const enc = new TextEncoder();
					controller.enqueue(enc.encode(': openai-keep-alive\n\n'));
					controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
					controller.enqueue(enc.encode('data: [DONE]\n\n'));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.strictEqual(chunks.length, 1);
			assert.strictEqual(chunks[0].deltaContent, 'a');
		});

		it('throws OpenAIBackendError when an event payload is invalid JSON (static message; no upstream content leak)', async () => {
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: <html>oops</html>\n\n'));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			try {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* no-op */
				}
				assert.fail('expected OpenAIBackendError');
			} catch (err) {
				assert.ok(err instanceof OpenAIBackendError);
				assert.ok(!err.message.includes('<html>'));
			}
		});

		it('caps the SSE buffer at 1 MiB without a complete event boundary', async () => {
			const huge = 'x'.repeat((1 << 20) + 1);
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(huge));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await assert.rejects(async () => {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* no-op */
				}
			}, /SSE buffer exceeds/);
		});
	});

	describe('generateStream — tool-call delta accumulation', () => {
		it('assembles index-keyed deltas into a single finalized tool call', async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{
						choices: [
							{
								delta: {
									role: 'assistant',
									tool_calls: [
										{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":' } }] } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] } }] },
					{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
				])
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'gpt-4o-mini' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream(
				{ messages: [{ role: 'user', content: 'q' }] },
				{ accounting: ACCOUNTING }
			)) {
				chunks.push(c);
			}
			const final = chunks[chunks.length - 1];
			assert.strictEqual(final.finishReason, 'tool_calls');
			assert.deepStrictEqual(final.deltaToolCalls, [
				{ id: 'call_abc', name: 'get_weather', arguments: { location: 'SF' } },
			]);
		});

		it('handles multiple tool calls in parallel via distinct indices', async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{
						choices: [
							{
								delta: {
									role: 'assistant',
									tool_calls: [
										{ index: 0, id: 'a', type: 'function', function: { name: 'fn_a', arguments: '' } },
										{ index: 1, id: 'b', type: 'function', function: { name: 'fn_b', arguments: '' } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"x":1}' } }] } }] },
					{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
				])
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream(
				{ messages: [{ role: 'user', content: 'q' }] },
				{ accounting: ACCOUNTING }
			)) {
				chunks.push(c);
			}
			const final = chunks[chunks.length - 1];
			assert.strictEqual(final.deltaToolCalls.length, 2);
			assert.deepStrictEqual(final.deltaToolCalls[0], { id: 'a', name: 'fn_a', arguments: {} });
			assert.deepStrictEqual(final.deltaToolCalls[1], { id: 'b', name: 'fn_b', arguments: { x: 1 } });
		});

		it('caps accumulated tool-call arguments at 1 MiB across events', async () => {
			// One delta is < 1 MiB (so per-event SSE cap doesn't trip) but
			// many of them push the cumulative argumentsBuf past the cap.
			const half = 'x'.repeat(1 << 19); // 512 KiB
			const fetch = mockFetch(() =>
				sseResponse([
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, id: 'big', type: 'function', function: { name: 'fn', arguments: half } }],
								},
							},
						],
					},
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: half } }] } }] },
					{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: half } }] } }] },
				])
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
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
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: 'a', type: 'function', function: { name: 'ok', arguments: '{"x":1}' } },
										{ index: 1, id: 'b', type: 'function', function: { name: 'bad', arguments: 'not-json' } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
				])
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream(
				{ messages: [{ role: 'user', content: 'q' }] },
				{ accounting: ACCOUNTING }
			)) {
				chunks.push(c);
			}
			const final = chunks[chunks.length - 1];
			assert.strictEqual(final.deltaToolCalls.length, 1);
			assert.strictEqual(final.deltaToolCalls[0].id, 'a');
		});

		it("maps streaming finish_reason='tool_calls' to finishReason='tool_calls'", async () => {
			const fetch = mockFetch(() =>
				sseResponse([
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'fn', arguments: '{}' } }],
								},
							},
						],
					},
					{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
				])
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream(
				{ messages: [{ role: 'user', content: 'q' }] },
				{ accounting: ACCOUNTING }
			)) {
				chunks.push(c);
			}
			assert.strictEqual(chunks[chunks.length - 1].finishReason, 'tool_calls');
		});

		it('flushes buffered tool calls even when the stream ends without a finish_reason', async () => {
			// Some proxies / intermediaries drop the final event. Buffered tool
			// calls should still surface so the caller doesn't lose them.
			const fetch = mockFetch(() =>
				sseResponse(
					[
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: 'late',
												type: 'function',
												function: { name: 'fn', arguments: '{"x":2}' },
											},
										],
									},
								},
							],
						},
					],
					{ includeDone: false }
				)
			);
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream(
				{ messages: [{ role: 'user', content: 'q' }] },
				{ accounting: ACCOUNTING }
			)) {
				chunks.push(c);
			}
			const final = chunks[chunks.length - 1];
			assert.ok(final.deltaToolCalls);
			assert.strictEqual(final.deltaToolCalls[0].id, 'late');
		});
	});

	describe('AbortSignal propagation', () => {
		it('passes caller signal straight through when no timeout configured', async () => {
			const ctrl = new AbortController();
			let seenSignal;
			const fetch = mockFetch(({ init }) => {
				seenSignal = init.signal;
				return jsonResponse({ data: [{ embedding: [0.1] }] });
			});
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING, signal: ctrl.signal });
			assert.strictEqual(seenSignal, ctrl.signal);
		});

		it('composes caller signal with per-call timeout via AbortSignal.any', async () => {
			const ctrl = new AbortController();
			let seenSignal;
			const fetch = mockFetch(({ init }) => {
				seenSignal = init.signal;
				return jsonResponse({ data: [{ embedding: [0.1] }] });
			});
			const b = new OpenAIBackend({ apiKey: API_KEY, model: 'm', requestTimeoutMs: 10000 }, fetch);
			await b.embed('x', { accounting: ACCOUNTING, signal: ctrl.signal });
			assert.ok(seenSignal instanceof AbortSignal);
			assert.notStrictEqual(seenSignal, ctrl.signal);
		});
	});
});

describe('registerOpenAIBackend', () => {
	beforeEach(() => clearRegistry());

	it('registers as an embedding backend under the logical name', () => {
		registerOpenAIBackend({
			logicalName: 'high-quality',
			kind: 'embedding',
			config: { apiKey: API_KEY, model: 'text-embedding-3-large' },
		});
		const b = resolveEmbedding('high-quality');
		assert.strictEqual(b.name, 'openai');
	});

	it('registers as a generative backend under the logical name', () => {
		registerOpenAIBackend({
			logicalName: 'default',
			kind: 'generative',
			config: { apiKey: API_KEY, model: 'gpt-4o-mini' },
		});
		const b = resolveGenerative('default');
		assert.strictEqual(b.name, 'openai');
	});
});
