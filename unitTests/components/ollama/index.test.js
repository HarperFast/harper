'use strict';

const assert = require('node:assert/strict');
const { OllamaBackend, OllamaBackendError, registerOllamaBackend } = require('#src/components/ollama/index');
const { clearRegistry, resolveEmbedding, resolveGenerative } = require('#src/resources/models/backendRegistry');

const ACCOUNTING = { tenantId: 'tid', app: '/test' };

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

function ndjsonResponse(objects) {
	const body = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			for (const obj of objects) {
				controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('OllamaBackend', () => {
	describe('shape', () => {
		it('reports name = "ollama"', () => {
			const b = new OllamaBackend({ model: 'x' });
			assert.strictEqual(b.name, 'ollama');
		});

		it('advertises capabilities matching the issue body', () => {
			const b = new OllamaBackend({ model: 'x' });
			assert.deepStrictEqual(b.capabilities(), {
				embed: true,
				generate: true,
				stream: true,
				tools: false,
				adapters: false,
			});
		});
	});

	describe('host normalization', () => {
		it("defaults to http://localhost:11434 when 'host' is omitted", async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1]] }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'http://localhost:11434/api/embed');
		});

		it('respects an explicit scheme on host', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1]] }));
			const b = new OllamaBackend({ host: 'https://ollama.example.com', model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'https://ollama.example.com/api/embed');
		});

		it('strips trailing slash on host', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1]] }));
			const b = new OllamaBackend({ host: 'ollama:11434/', model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url, 'http://ollama:11434/api/embed');
		});
	});

	describe('embed', () => {
		it('POSTs to /api/embed with the configured model and Float32Array output', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1, 0.2, 0.3]], prompt_eval_count: 3 }));
			const b = new OllamaBackend({ model: 'nomic-embed-text' }, fetch);
			const result = await b.embed('hello', { accounting: ACCOUNTING });
			assert.strictEqual(result.status, 'completed');
			assert.strictEqual(result.output.length, 1);
			assert.ok(result.output[0] instanceof Float32Array);
			assert.deepStrictEqual(Array.from(result.output[0]), [
				new Float32Array([0.1])[0],
				new Float32Array([0.2])[0],
				new Float32Array([0.3])[0],
			]);
			assert.strictEqual(result.usage.embeddingTokens, 3);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.model, 'nomic-embed-text');
		});

		it('overrides the configured model with opts.model when supplied', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.5]] }));
			const b = new OllamaBackend({ model: 'configured' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING, model: 'override' });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.model, 'override');
		});

		it('throws OllamaBackendError when no model is configured or passed', async () => {
			const fetch = mockFetch(() => jsonResponse({}));
			const b = new OllamaBackend({}, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), OllamaBackendError);
		});

		it('sends an array input for batch embedding', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1], [0.2]] }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await b.embed(['a', 'b'], { accounting: ACCOUNTING });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.input, ['a', 'b']);
		});

		it("injects 'search_document: ' prefix for inputType=document on nomic models", async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0]] }));
			const b = new OllamaBackend({ model: 'nomic-embed-text:v1.5' }, fetch);
			await b.embed('a doc', { accounting: ACCOUNTING, inputType: 'document' });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.input, ['search_document: a doc']);
		});

		it("injects 'search_query: ' prefix for inputType=query on nomic models", async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0]] }));
			const b = new OllamaBackend({ model: 'nomic-embed-text' }, fetch);
			await b.embed('q', { accounting: ACCOUNTING, inputType: 'query' });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.input, ['search_query: q']);
		});

		it('does not inject a prefix on non-nomic models', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0]] }));
			const b = new OllamaBackend({ model: 'all-MiniLM-L6-v2' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING, inputType: 'document' });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.input, ['x']);
		});

		it('raises OllamaBackendError when the response lacks an embeddings array', async () => {
			const fetch = mockFetch(() => jsonResponse({ no: 'embeddings' }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), OllamaBackendError);
		});

		it('raises OllamaBackendError on non-2xx HTTP', async () => {
			const fetch = mockFetch(() => new Response('boom', { status: 500 }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(() => b.embed('x', { accounting: ACCOUNTING }), OllamaBackendError);
		});

		it('raises OllamaBackendError when response vector count differs from input count', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1]] }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(() => b.embed(['a', 'b'], { accounting: ACCOUNTING }), /returned 1 vectors for 2 inputs/);
		});

		it('raises OllamaBackendError when a vector contains non-finite values', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1, null, 0.3]] }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(
				() => b.embed('x', { accounting: ACCOUNTING }),
				/vector at index 0 is not an array of finite numbers/
			);
		});

		it('drops non-finite / non-integer prompt_eval_count from usage', async () => {
			const fetch = mockFetch(() => jsonResponse({ embeddings: [[0.1]], prompt_eval_count: NaN }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			const result = await b.embed('x', { accounting: ACCOUNTING });
			assert.strictEqual(result.usage.embeddingTokens, undefined);
		});

		it('wraps non-JSON response bodies in OllamaBackendError', async () => {
			const fetch = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(
				() => b.embed('x', { accounting: ACCOUNTING }),
				/Ollama \/api\/embed returned a non-JSON response body/
			);
		});
	});

	describe('generate', () => {
		it('uses /api/generate with a string prompt and maps token usage', async () => {
			const fetch = mockFetch(() =>
				jsonResponse({
					response: 'hi there',
					done: true,
					done_reason: 'stop',
					prompt_eval_count: 5,
					eval_count: 2,
				})
			);
			const b = new OllamaBackend({ model: 'llama3.2' }, fetch);
			const result = await b.generate('say hi', { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url.endsWith('/api/generate'), true);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.prompt, 'say hi');
			assert.strictEqual(sent.stream, false);
			assert.strictEqual(result.output.content, 'hi there');
			assert.strictEqual(result.output.finishReason, 'stop');
			assert.strictEqual(result.usage.promptTokens, 5);
			assert.strictEqual(result.usage.completionTokens, 2);
		});

		it('uses /api/chat with a messages-array input', async () => {
			const fetch = mockFetch(() =>
				jsonResponse({
					message: { role: 'assistant', content: 'reply' },
					done: true,
					done_reason: 'stop',
				})
			);
			const b = new OllamaBackend({ model: 'llama3.2' }, fetch);
			const result = await b.generate([{ role: 'user', content: 'hi' }], { accounting: ACCOUNTING });
			assert.strictEqual(fetch.calls[0].url.endsWith('/api/chat'), true);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.messages, [{ role: 'user', content: 'hi' }]);
			assert.strictEqual(result.output.content, 'reply');
		});

		it('prepends system as the first message when supplied via { messages, system }', async () => {
			const fetch = mockFetch(() => jsonResponse({ message: { role: 'assistant', content: '' }, done: true }));
			const b = new OllamaBackend({ model: 'llama3.2' }, fetch);
			await b.generate(
				{ messages: [{ role: 'user', content: 'q' }], system: 'be helpful' },
				{ accounting: ACCOUNTING }
			);
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.messages[0], { role: 'system', content: 'be helpful' });
			assert.deepStrictEqual(sent.messages[1], { role: 'user', content: 'q' });
		});

		it("maps responseFormat='json' to format='json'", async () => {
			const fetch = mockFetch(() => jsonResponse({ response: '{}', done: true }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await b.generate('x', { accounting: ACCOUNTING, responseFormat: 'json' });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.strictEqual(sent.format, 'json');
		});

		it("maps responseFormat={ schema } to Ollama's format object", async () => {
			const fetch = mockFetch(() => jsonResponse({ response: '{}', done: true }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			const schema = { type: 'object', properties: { a: { type: 'string' } } };
			await b.generate('x', { accounting: ACCOUNTING, responseFormat: { schema } });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.format, schema);
		});

		it('maps temperature and maxTokens into options.num_predict / temperature', async () => {
			const fetch = mockFetch(() => jsonResponse({ response: '', done: true }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await b.generate('x', { accounting: ACCOUNTING, temperature: 0.5, maxTokens: 100 });
			const sent = JSON.parse(fetch.calls[0].init.body);
			assert.deepStrictEqual(sent.options, { temperature: 0.5, num_predict: 100 });
		});

		it("maps done_reason='length' to finishReason='length'", async () => {
			const fetch = mockFetch(() => jsonResponse({ response: 'cut', done: true, done_reason: 'length' }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			const result = await b.generate('x', { accounting: ACCOUNTING });
			assert.strictEqual(result.output.finishReason, 'length');
		});

		it('rejects a non-string content from /api/chat', async () => {
			const fetch = mockFetch(() => jsonResponse({ message: { role: 'assistant', content: 42 }, done: true }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(
				() => b.generate([{ role: 'user', content: 'q' }], { accounting: ACCOUNTING }),
				/response content is not a string/
			);
		});

		it('rejects a non-string response from /api/generate', async () => {
			const fetch = mockFetch(() => jsonResponse({ response: { nested: 'obj' }, done: true }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(() => b.generate('x', { accounting: ACCOUNTING }), /response content is not a string/);
		});

		it('drops non-integer token counts from usage', async () => {
			const fetch = mockFetch(() =>
				jsonResponse({ response: 'ok', done: true, prompt_eval_count: 1.5, eval_count: -3 })
			);
			const b = new OllamaBackend({ model: 'm' }, fetch);
			const result = await b.generate('x', { accounting: ACCOUNTING });
			assert.strictEqual(result.usage.promptTokens, undefined);
			assert.strictEqual(result.usage.completionTokens, undefined);
		});
	});

	describe('generateStream', () => {
		it('yields a chunk per NDJSON line with deltaContent', async () => {
			const fetch = mockFetch(() =>
				ndjsonResponse([
					{ response: 'hello ' },
					{ response: 'world' },
					{ response: '', done: true, done_reason: 'stop' },
				])
			);
			const b = new OllamaBackend({ model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.deepStrictEqual(chunks[0], { deltaContent: 'hello ' });
			assert.deepStrictEqual(chunks[1], { deltaContent: 'world' });
			assert.deepStrictEqual(chunks[2], { finishReason: 'stop' });
		});

		it('uses /api/chat shape when input is a messages array', async () => {
			const fetch = mockFetch(() =>
				ndjsonResponse([
					{ message: { role: 'assistant', content: 'hi' } },
					{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
				])
			);
			const b = new OllamaBackend({ model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream([{ role: 'user', content: 'q' }], {
				accounting: ACCOUNTING,
			})) {
				chunks.push(c);
			}
			assert.strictEqual(fetch.calls[0].url.endsWith('/api/chat'), true);
			assert.strictEqual(chunks[0].deltaContent, 'hi');
			assert.strictEqual(chunks[1].finishReason, 'stop');
		});

		it('handles NDJSON split across chunk boundaries', async () => {
			// Emit a single JSON object across two stream chunks.
			const body = new ReadableStream({
				start(controller) {
					const enc = new TextEncoder();
					controller.enqueue(enc.encode('{"response":"hel'));
					controller.enqueue(enc.encode('lo"}\n{"response":"","done":true}\n'));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			const chunks = [];
			for await (const c of b.generateStream('q', { accounting: ACCOUNTING })) chunks.push(c);
			assert.strictEqual(chunks[0].deltaContent, 'hello');
			assert.strictEqual(chunks[1].finishReason, 'stop');
		});

		it('throws OllamaBackendError on invalid NDJSON', async () => {
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('not-json\n'));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(async () => {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* no-op */
				}
			}, OllamaBackendError);
		});

		it('uses a static message on invalid NDJSON (no upstream content in the thrown error)', async () => {
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('<html>oops</html>\n'));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			try {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* no-op */
				}
				assert.fail('expected OllamaBackendError');
			} catch (err) {
				assert.ok(err instanceof OllamaBackendError);
				assert.ok(!err.message.includes('<html>'), 'error message should not include upstream content');
			}
		});

		it('throws OllamaBackendError when a stream line exceeds the byte cap', async () => {
			// Emit just over 1 MiB of bytes with no newline. The parens matter:
			// `+` binds tighter than `<<`, so the original `1 << 20 + 1` (and
			// prettier's autofix `1 << (20 + 1)`) both evaluate to `1 << 21`
			// (2 MiB). We want `(1 << 20) + 1` — exactly one byte past the cap.
			const huge = 'x'.repeat((1 << 20) + 1);
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(huge));
					controller.close();
				},
			});
			const fetch = mockFetch(() => new Response(body, { status: 200 }));
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await assert.rejects(async () => {
				for await (const _c of b.generateStream('q', { accounting: ACCOUNTING })) {
					/* no-op */
				}
			}, /NDJSON line exceeds/);
		});
	});

	describe('AbortSignal propagation', () => {
		it('passes the caller signal straight through when no timeout is configured', async () => {
			const ctrl = new AbortController();
			let seenSignal;
			const fetch = mockFetch(({ init }) => {
				seenSignal = init.signal;
				return jsonResponse({ embeddings: [[0]] });
			});
			const b = new OllamaBackend({ model: 'm' }, fetch);
			await b.embed('x', { accounting: ACCOUNTING, signal: ctrl.signal });
			assert.strictEqual(seenSignal, ctrl.signal);
		});

		it('composes caller signal with per-call timeout via AbortSignal.any', async () => {
			const ctrl = new AbortController();
			let seenSignal;
			const fetch = mockFetch(({ init }) => {
				seenSignal = init.signal;
				return jsonResponse({ embeddings: [[0]] });
			});
			const b = new OllamaBackend({ model: 'm', requestTimeoutMs: 10000 }, fetch);
			await b.embed('x', { accounting: ACCOUNTING, signal: ctrl.signal });
			assert.ok(seenSignal instanceof AbortSignal);
			// AbortSignal.any returns a new signal distinct from both inputs.
			assert.notStrictEqual(seenSignal, ctrl.signal);
		});

		it('aborts when the caller signal aborts (composed-signal case)', async () => {
			const ctrl = new AbortController();
			const fetch = mockFetch(
				({ init }) =>
					new Promise((_resolve, reject) => {
						init.signal.addEventListener('abort', () =>
							reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
						);
					})
			);
			const b = new OllamaBackend({ model: 'm', requestTimeoutMs: 10000 }, fetch);
			const pending = b.embed('x', { accounting: ACCOUNTING, signal: ctrl.signal });
			ctrl.abort();
			await assert.rejects(pending, /aborted/);
		});
	});
});

describe('registerOllamaBackend', () => {
	beforeEach(() => clearRegistry());

	it('registers as an embedding backend under the logical name', () => {
		registerOllamaBackend({ logicalName: 'fast', kind: 'embedding', config: { model: 'm' } });
		const b = resolveEmbedding('fast');
		assert.strictEqual(b.name, 'ollama');
	});

	it('registers as a generative backend under the logical name', () => {
		registerOllamaBackend({ logicalName: 'default', kind: 'generative', config: { model: 'm' } });
		const b = resolveGenerative('default');
		assert.strictEqual(b.name, 'ollama');
	});
});
