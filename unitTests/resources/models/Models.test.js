'use strict';

const assert = require('node:assert/strict');
// Importing databases first primes Harper's module graph in the order other unit tests
// (e.g. Resource-get-context.test.js) load it; otherwise the transaction.ts ↔
// DatabaseTransaction/blob require chain hits a cycle when loaded ESM-first by mocha.
require('#src/resources/databases');
const { contextStorage } = require('#src/resources/transaction');
const { setEmbedding, setGenerative, clearRegistry } = require('#src/resources/models/backendRegistry');
const { TestBackend } = require('#src/resources/models/TestBackend');
const {
	Models,
	ModelCapabilityError,
	ModelPendingNotSupportedError,
	models: modelsSingleton,
} = require('#src/resources/models/Models');

function makeMockWriter() {
	const records = [];
	return {
		records,
		write(record) {
			records.push(record);
		},
	};
}

describe('models singleton', () => {
	it('is a live Models instance', () => {
		assert.ok(modelsSingleton instanceof Models);
	});

	it('_assignPackageExport wires global.models to the same object', () => {
		assert.strictEqual(global.models, modelsSingleton);
	});
});

// Captures (value, metric, path) tuples that Models passes to recordAction.
// Production wires the module-scoped recordAction; tests pass this spy so we can
// assert exactly which aggregate metrics are emitted without touching the global
// analytics pipeline.
function makeMetricSpy() {
	const calls = [];
	const emitter = (value, metric, path) => calls.push({ value, metric, path });
	return { calls, emitter };
}

describe('Models facade', () => {
	let writer;
	let metricSpy;
	let models;

	beforeEach(() => {
		clearRegistry();
		writer = makeMockWriter();
		metricSpy = makeMetricSpy();
		models = new Models(writer, metricSpy.emitter);
		const test = new TestBackend();
		setEmbedding('default', test);
		setGenerative('default', test);
	});

	afterEach(() => {
		clearRegistry();
	});

	describe('embed', () => {
		it('returns the unwrapped vector array (not a ModelCallResult)', async () => {
			const vectors = await models.embed('hello');
			assert.ok(Array.isArray(vectors));
			assert.ok(vectors[0] instanceof Float32Array);
		});

		it('writes an analytics record with backend=test, method=embed, success=true', async () => {
			await models.embed('hello');
			assert.strictEqual(writer.records.length, 1);
			const r = writer.records[0];
			assert.strictEqual(r.backend, 'test');
			assert.strictEqual(r.method, 'embed');
			assert.strictEqual(r.success, true);
			assert.ok(r.latency_ms >= 0);
		});

		it('with no ALS context, accounting tenant/app are undefined and no error is thrown', async () => {
			await models.embed('hello');
			const r = writer.records[0];
			assert.strictEqual(r.tenant, undefined);
			assert.strictEqual(r.app, undefined);
		});

		it('inside an ALS-bound context, accounting picks up tenant + handlerPath', async () => {
			const ctx = { user: { tenant: 't-42' }, handlerPath: '/MyResource' };
			await contextStorage.run(ctx, async () => {
				await models.embed('hello');
			});
			const r = writer.records[0];
			assert.strictEqual(r.tenant, 't-42');
			assert.strictEqual(r.app, '/MyResource');
		});

		it('extractTenantId prefers user.tenant, falls back to user.tenantId', async () => {
			await contextStorage.run({ user: { tenantId: 'fallback' }, handlerPath: '/x' }, async () => {
				await models.embed('hello');
			});
			assert.strictEqual(writer.records[0].tenant, 'fallback');
		});

		it('forwards opts.signal to the backend over the ctx signal when both present', async () => {
			let seenSignal;
			setEmbedding('default', {
				name: 'spy',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed(_input, opts) {
					seenSignal = opts.signal;
					return { status: 'completed', output: [new Float32Array(1)] };
				},
			});
			const callerSignal = new AbortController().signal;
			const ctxSignal = new AbortController().signal;
			await contextStorage.run({ signal: ctxSignal }, async () => {
				await models.embed('x', { signal: callerSignal });
			});
			assert.strictEqual(seenSignal, callerSignal);
		});

		it('forwards ctx.signal to the backend when opts.signal is absent', async () => {
			let seenSignal;
			setEmbedding('default', {
				name: 'spy',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed(_input, opts) {
					seenSignal = opts.signal;
					return { status: 'completed', output: [new Float32Array(1)] };
				},
			});
			const ctxSignal = new AbortController().signal;
			await contextStorage.run({ signal: ctxSignal }, async () => {
				await models.embed('x');
			});
			assert.strictEqual(seenSignal, ctxSignal);
		});

		it('throws ModelCapabilityError when the backend does not support embed AND records the failure', async () => {
			setEmbedding('default', {
				name: 'no-embed',
				capabilities: () => ({ embed: false, generate: true, stream: false, tools: false, adapters: false }),
			});
			await assert.rejects(() => models.embed('x'), ModelCapabilityError);
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].backend, 'no-embed');
			assert.strictEqual(writer.records[0].success, false);
			assert.strictEqual(writer.records[0].error_code, 'capability_unsupported');
		});

		it('writes ONE record with success=false on pending result (not duplicate from unwrap+catch)', async () => {
			setEmbedding('default', {
				name: 'pending',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed() {
					return { status: 'pending', operationId: 'op-1' };
				},
			});
			await assert.rejects(() => models.embed('x'), ModelPendingNotSupportedError);
			assert.strictEqual(writer.records.length, 1, 'pending result must not produce duplicate rows');
			assert.strictEqual(writer.records[0].success, false);
			assert.strictEqual(writer.records[0].error_code, 'pending_unsupported');
		});

		it("records pre-call ModelBackendNotFoundError with backend='unknown' and error_code='backend_not_found'", async () => {
			// No backend mapped for the requested logical name.
			await assert.rejects(() => models.embed('x', { model: 'no-such-name' }));
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].backend, 'unknown');
			assert.strictEqual(writer.records[0].model, 'no-such-name');
			assert.strictEqual(writer.records[0].success, false);
			assert.strictEqual(writer.records[0].error_code, 'backend_not_found');
		});

		it('writes an analytics record with success=false and sanitized error_code on backend failure', async () => {
			setEmbedding('default', {
				name: 'failing',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed() {
					throw new Error('upstream boom');
				},
			});
			await assert.rejects(() => models.embed('x'));
			const r = writer.records[0];
			assert.strictEqual(r.success, false);
			assert.strictEqual(r.error_code, 'backend_error');
			for (const value of Object.values(r)) {
				if (typeof value === 'string') {
					assert.ok(!value.includes('upstream boom'), 'raw upstream message should not leak into the record');
				}
			}
		});

		it("classifies AbortError as error_code = 'aborted'", async () => {
			setEmbedding('default', {
				name: 'aborter',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed() {
					const err = new Error('aborted');
					err.name = 'AbortError';
					throw err;
				},
			});
			await assert.rejects(() => models.embed('x'));
			assert.strictEqual(writer.records[0].error_code, 'aborted');
		});
	});

	describe('aggregate analytics emission (recordAction)', () => {
		it('emits model-embed count=1 with backend name as path on successful embed', async () => {
			await models.embed('hello');
			const countCall = metricSpy.calls.find((c) => c.metric === 'model-embed');
			assert.ok(countCall, 'expected a model-embed metric to be emitted');
			assert.strictEqual(countCall.value, 1);
			assert.strictEqual(countCall.path, 'test');
		});

		it('emits model-embed-tokens with the sum from usage.embeddingTokens', async () => {
			setEmbedding('default', {
				name: 'tokenful-embed',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed() {
					return { status: 'completed', output: [new Float32Array(1)], usage: { embeddingTokens: 17 } };
				},
			});
			await models.embed('x');
			const tokenCall = metricSpy.calls.find((c) => c.metric === 'model-embed-tokens');
			assert.ok(tokenCall, 'expected model-embed-tokens to be emitted');
			assert.strictEqual(tokenCall.value, 17);
			assert.strictEqual(tokenCall.path, 'tokenful-embed');
		});

		it('omits the tokens metric entirely when usage is absent or zero', async () => {
			setEmbedding('default', {
				name: 'no-usage',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed() {
					return { status: 'completed', output: [new Float32Array(1)] };
				},
			});
			await models.embed('x');
			assert.ok(
				!metricSpy.calls.some((c) => c.metric.endsWith('-tokens')),
				'no -tokens metric should be emitted when backend reports no usage'
			);
			// Count metric should still be there though.
			assert.ok(metricSpy.calls.some((c) => c.metric === 'model-embed'));
		});

		it('sums prompt + completion tokens for generate into a single model-generate-tokens metric', async () => {
			setGenerative('default', {
				name: 'tokenful-gen',
				capabilities: () => ({ embed: false, generate: true, stream: false, tools: false, adapters: false }),
				async generate() {
					return {
						status: 'completed',
						output: { content: 'hi', finishReason: 'stop' },
						usage: { promptTokens: 12, completionTokens: 8 },
					};
				},
			});
			await models.generate('x');
			const tokenCall = metricSpy.calls.find((c) => c.metric === 'model-generate-tokens');
			assert.ok(tokenCall, 'expected model-generate-tokens to be emitted');
			assert.strictEqual(tokenCall.value, 20);
		});

		it('emits a model-generateStream count + tokens at the end of a successful stream', async () => {
			setGenerative('default', {
				name: 'stream-with-usage',
				capabilities: () => ({ embed: false, generate: true, stream: true, tools: false, adapters: false }),
				async *generateStream() {
					yield { deltaContent: 'one ' };
					yield { deltaContent: 'two' };
					yield { finishReason: 'stop' };
				},
			});
			for await (const _chunk of models.generateStream('x')) {
				// drain
			}
			// stream backend reports no usage in this test, so only the count metric
			assert.ok(metricSpy.calls.some((c) => c.metric === 'model-generateStream' && c.value === 1));
		});

		it('does NOT emit aggregate metrics on failed calls (forensics row still goes to hdb_model_calls)', async () => {
			setEmbedding('default', {
				name: 'failing',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed() {
					throw new Error('upstream boom');
				},
			});
			await assert.rejects(() => models.embed('x'));
			assert.strictEqual(metricSpy.calls.length, 0, 'no aggregate metrics should fire on failure');
			// But the per-call writer row IS there for forensics.
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].success, false);
		});

		it('does NOT emit aggregate metrics on pre-call backend-not-found (no billable work happened)', async () => {
			await assert.rejects(() => models.embed('x', { model: 'no-such-name' }));
			assert.strictEqual(metricSpy.calls.length, 0);
		});

		it('does NOT emit aggregate metrics when the backend returns status=pending', async () => {
			setEmbedding('default', {
				name: 'pending',
				capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
				async embed() {
					return { status: 'pending', operationId: 'op-1' };
				},
			});
			await assert.rejects(() => models.embed('x'), ModelPendingNotSupportedError);
			assert.strictEqual(metricSpy.calls.length, 0);
		});
	});

	describe('generate', () => {
		it('returns unwrapped GenerateResult with content', async () => {
			const result = await models.generate('hello');
			assert.strictEqual(typeof result.content, 'string');
			assert.strictEqual(result.finishReason, 'stop');
		});

		it('records adapter and conversation_id when provided on GenerateOpts', async () => {
			await models.generate('hello', { adapter: 'lora-1', conversationId: 'conv-99' });
			const r = writer.records[0];
			assert.strictEqual(r.adapter, 'lora-1');
			assert.strictEqual(r.conversation_id, 'conv-99');
		});

		it('writes a failure record and rethrows when the generative backend throws', async () => {
			setGenerative('default', {
				name: 'failing-gen',
				capabilities: () => ({ embed: false, generate: true, stream: false, tools: false, adapters: false }),
				async generate() {
					throw new Error('generate boom');
				},
			});
			await assert.rejects(() => models.generate('x'), /generate boom/);
			const r = writer.records[0];
			assert.strictEqual(r.method, 'generate');
			assert.strictEqual(r.success, false);
			assert.strictEqual(r.error_code, 'backend_error');
		});

		describe("toolMode: 'auto' (entry dispatch)", () => {
			// Loop behavior lives in `agentLoop.test.js`. Tests here cover the dispatch
			// branch in `Models.generate` itself — that the entry point picks the right
			// path and that `'return'` is unaffected.

			it("toolMode: 'return' still flows the single-shot path", async () => {
				const result = await models.generate('hello', { toolMode: 'return' });
				assert.strictEqual(typeof result.content, 'string');
				assert.strictEqual(writer.records.length, 1);
				assert.strictEqual(writer.records[0].method, 'generate');
				assert.strictEqual(writer.records[0].success, true);
			});

			it('still-gated modes throw 501 at the loop entry (sanity — full matrix in agentLoop.test.js)', async () => {
				// Spot-check that the dispatch branch reaches the guarded loop body. Each
				// deferred mode has its own assertion in `agentLoop.test.js`.
				await assert.rejects(
					() => models.generate('hello', { toolMode: 'auto', toolArgValidation: 'strict' }),
					(err) => err.statusCode === 501
				);
			});

			it('auto + tools against a tools-incapable backend fails loud (no silent no-op)', async () => {
				// TestBackend is tools:false. Declaring tools for an auto loop against it would
				// otherwise run as a plain generation, silently ignoring the tools.
				await assert.rejects(
					() =>
						models.generate(
							{ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: '', parameters: {} }] },
							{ toolMode: 'auto', toolHandlers: { t: () => ({}) } }
						),
					(err) => err instanceof ModelCapabilityError && /tools/.test(err.message)
				);
			});

			it('auto WITHOUT tools is unaffected by the tools guard', async () => {
				const result = await models.generate('hi', { toolMode: 'auto' });
				assert.strictEqual(typeof result.content, 'string');
				assert.strictEqual(result.finishReason, 'stop');
			});
		});
	});

	describe('generateStream', () => {
		it('yields chunks and writes one analytics record at stream end', async () => {
			const chunks = [];
			for await (const chunk of models.generateStream('hello')) {
				chunks.push(chunk);
			}
			assert.ok(chunks.length > 1);
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].method, 'generateStream');
			assert.strictEqual(writer.records[0].success, true);
		});

		it('records success=false when the stream throws mid-iteration', async () => {
			setGenerative('default', {
				name: 'stream-err',
				capabilities: () => ({ embed: false, generate: true, stream: true, tools: false, adapters: false }),
				async *generateStream() {
					yield { deltaContent: 'partial ' };
					throw new Error('stream boom');
				},
			});
			await assert.rejects(async () => {
				for await (const _chunk of models.generateStream('x')) {
					// drain
				}
			});
			assert.strictEqual(writer.records[0].success, false);
			assert.strictEqual(writer.records[0].error_code, 'backend_error');
		});

		it("records success=false with error_code='aborted' when the consumer breaks early", async () => {
			setGenerative('default', {
				name: 'long-stream',
				capabilities: () => ({ embed: false, generate: true, stream: true, tools: false, adapters: false }),
				async *generateStream() {
					yield { deltaContent: 'one ' };
					yield { deltaContent: 'two ' };
					yield { deltaContent: 'three ' };
					yield { finishReason: 'stop' };
				},
			});
			let count = 0;
			for await (const _chunk of models.generateStream('x')) {
				if (++count === 2) break;
			}
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].success, false);
			assert.strictEqual(writer.records[0].error_code, 'aborted');
		});

		it("records pre-call failure with backend='unknown' when the generative backend isn't registered", async () => {
			await assert.rejects(async () => {
				// eslint-disable-next-line no-unused-vars
				for await (const _ of models.generateStream('x', { model: 'no-such-name' })) {
					// will not iterate — resolve throws first
				}
			});
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].backend, 'unknown');
			assert.strictEqual(writer.records[0].error_code, 'backend_not_found');
			assert.strictEqual(writer.records[0].method, 'generateStream');
		});

		it('records capability-mismatch on generateStream with the resolved backend name (not "unknown")', async () => {
			setGenerative('default', {
				name: 'no-stream',
				capabilities: () => ({ embed: false, generate: true, stream: false, tools: false, adapters: false }),
			});
			await assert.rejects(async () => {
				// eslint-disable-next-line no-unused-vars
				for await (const _ of models.generateStream('x')) {
					// will not iterate — requireCapability throws first
				}
			});
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].backend, 'no-stream');
			assert.strictEqual(writer.records[0].error_code, 'capability_unsupported');
			assert.strictEqual(writer.records[0].method, 'generateStream');
		});

		describe("toolMode: 'auto' (entry dispatch)", () => {
			// Streaming auto-loop behavior is in `agentLoop.test.js`. Tests here cover
			// the dispatch branch in `Models.generateStream` itself.

			it("toolMode: 'return' still flows the single-shot stream", async () => {
				const chunks = [];
				for await (const chunk of models.generateStream('hello', { toolMode: 'return' })) {
					chunks.push(chunk);
				}
				assert.ok(chunks.length > 1);
				assert.strictEqual(writer.records.length, 1);
				assert.strictEqual(writer.records[0].method, 'generateStream');
				assert.strictEqual(writer.records[0].success, true);
			});

			it('auto + tools against a tools-incapable backend throws synchronously (before iteration)', () => {
				// The guard runs in the synchronous body of generateStream, before the iterable
				// is returned — so it throws on call, not on first `next()`.
				assert.throws(
					() =>
						models.generateStream(
							{ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: '', parameters: {} }] },
							{ toolMode: 'auto', toolHandlers: { t: () => ({}) } }
						),
					(err) => err instanceof ModelCapabilityError && /tools/.test(err.message)
				);
			});
		});
	});
});
