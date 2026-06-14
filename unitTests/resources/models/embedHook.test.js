'use strict';

const assert = require('node:assert/strict');
const { buildEmbedBefore, createDefaultEmbedder, __setEmbedFnForTest } = require('#src/resources/models/embedHook');

const VECTOR_F32 = new Float32Array([0.1, 0.2, 0.3]);
// Embedders can return any of the `Embedder` shapes (Float32Array, Array<number>, etc.).
// `buildEmbedBefore` normalizes the output to `Array<number>` for storage — the record
// encoder mangles typed arrays via `updateAndFreeze`, so we flatten at the boundary.
// `VECTOR` is what's STORED; `VECTOR_F32` is what the embedder may RETURN.
const VECTOR = Array.from(VECTOR_F32);

function fakeEmbedCapturing() {
	const calls = [];
	const fn = async (input, opts) => {
		calls.push({ input, opts });
		return [VECTOR];
	};
	fn.calls = calls;
	return fn;
}

describe('embedHook', () => {
	describe('createDefaultEmbedder', () => {
		afterEach(() => __setEmbedFnForTest(undefined));

		it('reads source field, calls Models.embed with document inputType, returns first vector as Array<number>', async () => {
			const embedFn = fakeEmbedCapturing();
			__setEmbedFnForTest(embedFn);
			const embedder = createDefaultEmbedder({ source: 'content', model: 'default' });
			const vec = await embedder({ content: 'hello world' });
			// Default embedder converts Float32Array → Array<number> so Harper's record
			// encoder doesn't mangle it via `updateAndFreeze`. HNSW accepts both.
			assert.ok(Array.isArray(vec), 'vec should be a plain Array');
			assert.deepEqual(vec, Array.from(VECTOR));
			assert.equal(embedFn.calls.length, 1);
			assert.equal(embedFn.calls[0].input, 'hello world');
			assert.equal(embedFn.calls[0].opts.model, 'default');
			assert.equal(embedFn.calls[0].opts.inputType, 'document');
		});

		it('returns null when source value is null', async () => {
			const embedFn = fakeEmbedCapturing();
			__setEmbedFnForTest(embedFn);
			const embedder = createDefaultEmbedder({ source: 'content', model: 'default' });
			assert.equal(await embedder({ content: null }), null);
			assert.equal(embedFn.calls.length, 0);
		});

		it('returns null when source value is undefined', async () => {
			const embedFn = fakeEmbedCapturing();
			__setEmbedFnForTest(embedFn);
			const embedder = createDefaultEmbedder({ source: 'content', model: 'default' });
			assert.equal(await embedder({}), null);
			assert.equal(embedFn.calls.length, 0);
		});

		it('stringifies non-string source values before passing to embed()', async () => {
			const embedFn = fakeEmbedCapturing();
			__setEmbedFnForTest(embedFn);
			const embedder = createDefaultEmbedder({ source: 'count', model: 'default' });
			await embedder({ count: 42 });
			assert.equal(embedFn.calls[0].input, '42');
		});
	});

	describe('buildEmbedBefore', () => {
		const attrs = [{ name: 'embedding', embed: { source: 'content', model: 'default' } }];

		it('returns undefined when embedAttributes is empty', () => {
			assert.equal(buildEmbedBefore({ content: 'x' }, {}, {}, [], {}), undefined);
			assert.equal(buildEmbedBefore({ content: 'x' }, {}, {}, undefined, {}), undefined);
		});

		it('returns undefined on cluster-replication receive (options.isNotification === true)', () => {
			const before = buildEmbedBefore({ content: 'x' }, {}, { isNotification: true }, attrs, {
				embedding: async () => VECTOR,
			});
			assert.equal(before, undefined);
		});

		it('returns undefined on REST x-replicate-from: none (context.replicateFrom === false)', () => {
			const before = buildEmbedBefore({ content: 'x' }, { replicateFrom: false }, {}, attrs, {
				embedding: async () => VECTOR,
			});
			assert.equal(before, undefined);
		});

		it('DOES fire on a local-originating write where replicateFrom is undefined', () => {
			// Originating writes have undefined replicateFrom (not false); make sure the predicate
			// does not over-skip and silently drop local embedding work.
			const before = buildEmbedBefore({ content: 'x' }, {}, {}, attrs, {
				embedding: async () => VECTOR,
			});
			assert.ok(before, 'embedder should fire on local-originating writes');
		});

		it('returns undefined on replay context (alreadyLogged === true)', () => {
			const before = buildEmbedBefore({ content: 'x' }, { alreadyLogged: true }, {}, attrs, {
				embedding: async () => VECTOR,
			});
			assert.equal(before, undefined);
		});

		it('returns undefined when no embed-source field is in the write payload (patch that omits source)', () => {
			const before = buildEmbedBefore({ otherField: 'unchanged' }, {}, {}, attrs, {
				embedding: async () => VECTOR,
			});
			assert.equal(before, undefined);
		});

		it('returns undefined when record is not an object', () => {
			assert.equal(buildEmbedBefore(null, {}, {}, attrs, { embedding: async () => VECTOR }), undefined);
			assert.equal(buildEmbedBefore(undefined, {}, {}, attrs, { embedding: async () => VECTOR }), undefined);
		});

		it('runs the embedder and writes vector to the target attribute when source is present', async () => {
			const record = { content: 'hello' };
			const before = buildEmbedBefore(record, {}, {}, attrs, {
				embedding: async (r) => {
					assert.equal(r.content, 'hello');
					return VECTOR;
				},
			});
			assert.ok(before);
			await before();
			assert.deepEqual(record.embedding, VECTOR);
		});

		it('clears the embedding to null when source is explicitly null', async () => {
			const record = { content: null };
			let called = false;
			const before = buildEmbedBefore(record, {}, {}, attrs, {
				embedding: async () => {
					called = true;
					return VECTOR;
				},
			});
			assert.ok(before);
			await before();
			assert.equal(record.embedding, null);
			assert.equal(called, false, 'embedder should not run when source is null');
		});

		it('skips attributes whose source is not in the payload (multi-attribute table)', async () => {
			const multiAttrs = [
				{ name: 'embA', embed: { source: 'titleField', model: 'default' } },
				{ name: 'embB', embed: { source: 'bodyField', model: 'default' } },
			];
			const record = { bodyField: 'b' }; // only bodyField is in this patch
			let embACalls = 0;
			let embBCalls = 0;
			const before = buildEmbedBefore(record, {}, {}, multiAttrs, {
				embA: async () => {
					embACalls++;
					return VECTOR;
				},
				embB: async () => {
					embBCalls++;
					return VECTOR;
				},
			});
			assert.ok(before);
			await before();
			assert.equal(embACalls, 0, 'embA source not in payload, skipped');
			assert.equal(embBCalls, 1, 'embB source in payload, fired');
			assert.equal(record.embA, undefined);
			assert.deepEqual(record.embB, VECTOR);
		});

		it('skips an attribute that has no registered embedder', async () => {
			const record = { content: 'hello' };
			const before = buildEmbedBefore(record, {}, {}, attrs, {}); // no embedder
			assert.ok(before);
			await before();
			assert.equal(record.embedding, undefined, 'no vector written when no embedder is registered');
		});

		it('writes null to the target when the embedder returns null/undefined', async () => {
			const record = { content: 'hello' };
			const before = buildEmbedBefore(record, {}, {}, attrs, {
				embedding: async () => null,
			});
			assert.ok(before);
			await before();
			assert.equal(record.embedding, null);
		});

		it('normalizes custom-embedder typed-array output to Array<number> for storage', async () => {
			// Custom embedders may return a typed array; the hook flattens it to a plain
			// array so it round-trips through the record encoder.
			const record = { content: 'hello' };
			const before = buildEmbedBefore(record, {}, {}, attrs, {
				embedding: async () => VECTOR_F32, // typed-array return from a custom embedder
			});
			assert.ok(before);
			await before();
			assert.ok(Array.isArray(record.embedding), `expected Array, got ${record.embedding?.constructor?.name}`);
			assert.deepEqual(record.embedding, VECTOR);
		});

		it('skips the embed call when the source payload is a CRDT operation', async () => {
			// CRDT ops (`{__op__, value}`) get unwrapped at validate-time (`Table.validate`).
			// Harper today only supports numeric `add` (`resources/crdt.ts`), which isn't a
			// meaningful @embed source. Sending the raw op object to the embedder would
			// stringify to "[object Object]" and waste an embedder API call.
			const record = { content: { __op__: 'add', value: 5 } };
			let called = false;
			const before = buildEmbedBefore(record, {}, {}, attrs, {
				embedding: async () => {
					called = true;
					return VECTOR;
				},
			});
			assert.ok(before);
			await before();
			assert.equal(called, false, 'embedder should not run when source value is a CRDT op');
			assert.equal(record.embedding, undefined, 'no vector should be written for CRDT-op source');
		});

		it('propagates a sanitized error when the embedder throws', async () => {
			const record = { content: 'hello' };
			const before = buildEmbedBefore(record, {}, {}, attrs, {
				embedding: async () => {
					throw new Error('https://internal-embed.svc:9000 401 key=sk-abc123 unauthorized');
				},
			});
			assert.ok(before);
			// the embedder's raw backend message must NOT propagate as-is to the caller; the
			// sanitized error should reference only the attribute name and a generic phrase.
			await assert.rejects(before(), (err) => {
				assert.ok(!/sk-abc123/.test(err.message), 'API key tail leaked');
				assert.ok(!/internal-embed\.svc/.test(err.message), 'internal hostname leaked');
				assert.ok(/embedding/i.test(err.message), 'error message should mention embedding');
				return true;
			});
			// record.embedding should not have been written
			assert.equal(record.embedding, undefined);
		});
	});
});
