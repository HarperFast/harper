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

describe('Models facade', () => {
	let writer;
	let models;

	beforeEach(() => {
		clearRegistry();
		writer = makeMockWriter();
		models = new Models(writer);
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
	});
});
