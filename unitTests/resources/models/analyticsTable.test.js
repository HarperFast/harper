'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { ModelCallAnalyticsWriter } = require('#src/resources/models/analyticsTable');

/**
 * Mock primaryStore that records put/remove operations in an in-memory Map.
 * Mirrors only the API surface the writer uses (`put`, `remove`, `getKeys`).
 *
 * Database-touching coverage for hdb_model_calls is left to a separate
 * integration test — same posture as `resources/analytics/write.ts`'s
 * unit test (`unitTests/resources/analytics/write.test.js`), which only
 * exercises its pure helper functions and leaves the table interactions
 * for end-to-end coverage.
 */
function makeMockTable() {
	const store = new Map();
	return {
		store,
		primaryStore: {
			put(id, record) {
				store.set(id, record);
			},
			remove(id) {
				store.delete(id);
			},
			getKeys({ start, end } = {}) {
				const keys = Array.from(store.keys()).sort((a, b) => a - b);
				return keys.filter(
					(k) => (start === false || start === undefined || k >= start) && (end === undefined || k < end)
				);
			},
		},
	};
}

function makeRecord(overrides = {}) {
	return {
		backend: 'test',
		method: 'embed',
		latency_ms: 10,
		success: true,
		...overrides,
	};
}

describe('ModelCallAnalyticsWriter', () => {
	let table;
	let writer;

	beforeEach(() => {
		table = makeMockTable();
		writer = new ModelCallAnalyticsWriter({
			flushIntervalMs: 60_000,
			cleanupIntervalMs: 60_000,
			getTable: () => table,
		});
	});

	afterEach(async () => {
		writer.stop();
		await writer.flush();
	});

	describe('write + buffering', () => {
		it('buffers a record without writing immediately', () => {
			writer.write(makeRecord());
			assert.strictEqual(writer.bufferSize, 1);
			assert.strictEqual(table.store.size, 0);
		});

		it('multiple writes grow the buffer in order', () => {
			writer.write(makeRecord({ backend: 'a' }));
			writer.write(makeRecord({ backend: 'b' }));
			writer.write(makeRecord({ backend: 'c' }));
			assert.strictEqual(writer.bufferSize, 3);
			assert.strictEqual(table.store.size, 0);
		});

		it('write() is a no-op after stop()', () => {
			writer.stop();
			writer.write(makeRecord());
			assert.strictEqual(writer.bufferSize, 0);
		});
	});

	describe('flush', () => {
		it('writes buffered records to the table and clears the buffer', async () => {
			writer.write(makeRecord({ backend: 'a' }));
			writer.write(makeRecord({ backend: 'b' }));
			await writer.flush();
			assert.strictEqual(writer.bufferSize, 0);
			assert.strictEqual(table.store.size, 2);
		});

		it('is a no-op when the buffer is empty', async () => {
			await writer.flush();
			assert.strictEqual(table.store.size, 0);
		});

		it('still works after stop() to drain any pre-stop buffer', async () => {
			writer.write(makeRecord());
			writer.stop();
			await writer.flush();
			assert.strictEqual(table.store.size, 1);
		});

		it('writes records with all the schema fields the facade builds', async () => {
			const record = makeRecord({
				backend: 'test',
				method: 'generate',
				tenant: 't-1',
				app: '/Resource',
				model: 'm-1',
				adapter: 'lora',
				conversation_id: 'conv',
				prompt_tokens: 12,
				completion_tokens: 7,
				latency_ms: 42,
				success: true,
			});
			writer.write(record);
			await writer.flush();
			const stored = Array.from(table.store.values())[0];
			assert.strictEqual(stored.backend, 'test');
			assert.strictEqual(stored.method, 'generate');
			assert.strictEqual(stored.tenant, 't-1');
			assert.strictEqual(stored.app, '/Resource');
			assert.strictEqual(stored.model, 'm-1');
			assert.strictEqual(stored.adapter, 'lora');
			assert.strictEqual(stored.conversation_id, 'conv');
			assert.strictEqual(stored.prompt_tokens, 12);
			assert.strictEqual(stored.completion_tokens, 7);
			assert.strictEqual(stored.latency_ms, 42);
			assert.strictEqual(stored.success, true);
			assert.ok(typeof stored.id === 'number', 'id should be a numeric monotonic timestamp');
		});

		it('continues writing remaining records when one put rejects asynchronously (no silent loss)', async () => {
			let callCount = 0;
			const rejections = [];
			const asyncTable = {
				store: new Map(),
				primaryStore: {
					put(id, record) {
						callCount++;
						if (callCount === 2) {
							const p = Promise.reject(new Error('async LMDB rejection'));
							rejections.push(p);
							// Avoid unhandled-rejection warnings if the writer doesn't await fast.
							p.catch(() => {});
							return p;
						}
						this.store.set(id, record);
						return Promise.resolve();
					},
					remove() {},
					getKeys: () => [],
				},
			};
			asyncTable.primaryStore.store = asyncTable.store;
			const w = new ModelCallAnalyticsWriter({
				flushIntervalMs: 60_000,
				cleanupIntervalMs: 60_000,
				getTable: () => asyncTable,
			});
			w.write(makeRecord({ backend: 'a' }));
			w.write(makeRecord({ backend: 'b' }));
			w.write(makeRecord({ backend: 'c' }));
			await w.flush();
			w.stop();
			// Records 1 and 3 wrote; record 2's async rejection was awaited (no unhandled rejection).
			assert.strictEqual(asyncTable.store.size, 2);
			assert.strictEqual(rejections.length, 1);
		});

		it('continues writing remaining records when one put throws', async () => {
			let callCount = 0;
			const throwingTable = {
				store: new Map(),
				primaryStore: {
					put(id, record) {
						callCount++;
						if (callCount === 2) throw new Error('simulated put failure');
						this.store.set(id, record);
					},
					remove() {},
					getKeys: () => [],
				},
			};
			throwingTable.primaryStore.store = throwingTable.store;
			const w = new ModelCallAnalyticsWriter({
				flushIntervalMs: 60_000,
				cleanupIntervalMs: 60_000,
				getTable: () => throwingTable,
			});
			w.write(makeRecord({ backend: 'a' }));
			w.write(makeRecord({ backend: 'b' }));
			w.write(makeRecord({ backend: 'c' }));
			await w.flush();
			w.stop();
			// Records 1 and 3 wrote; record 2 threw and was logged + dropped.
			assert.strictEqual(throwingTable.store.size, 2);
		});
	});

	describe('maxBufferSize triggers flush', () => {
		it('reaching the cap schedules an out-of-cadence flush', async () => {
			const small = new ModelCallAnalyticsWriter({
				flushIntervalMs: 60_000,
				cleanupIntervalMs: 60_000,
				maxBufferSize: 2,
				getTable: () => table,
			});
			small.write(makeRecord());
			small.write(makeRecord());
			// The size-cap flush is fire-and-forget; give microtasks a turn.
			await delay(5);
			assert.strictEqual(small.bufferSize, 0);
			assert.strictEqual(table.store.size, 2);
			small.stop();
		});
	});

	describe('cleanup', () => {
		it('removes rows whose ids are older than retentionMs', async () => {
			const oldId = Date.now() - 1_000_000;
			const newId = Date.now();
			table.store.set(oldId, makeRecord({ backend: 'old' }));
			table.store.set(newId, makeRecord({ backend: 'new' }));
			const w = new ModelCallAnalyticsWriter({
				flushIntervalMs: 60_000,
				cleanupIntervalMs: 60_000,
				retentionMs: 1000,
				getTable: () => table,
			});
			await w.cleanup();
			w.stop();
			assert.strictEqual(table.store.has(oldId), false);
			assert.strictEqual(table.store.has(newId), true);
		});

		it('is a no-op when no rows are older than retentionMs', async () => {
			table.store.set(Date.now(), makeRecord());
			const w = new ModelCallAnalyticsWriter({
				flushIntervalMs: 60_000,
				cleanupIntervalMs: 60_000,
				retentionMs: 60_000,
				getTable: () => table,
			});
			await w.cleanup();
			w.stop();
			assert.strictEqual(table.store.size, 1);
		});
	});
});

// ---- schema correctness (finding 1: phantom indexes) ----------------------------
// flush() writes via primaryStore.put which bypasses updateIndices, so
// `indexed: true` on any non-PK attribute produces a permanently-empty index.
// Uses the exported MODEL_CALL_ATTRIBUTES const for a structural assertion that is
// not fragile to source reformatting or minification.
const { MODEL_CALL_ATTRIBUTES } = require('#src/resources/models/analyticsTable');

describe('getModelCallsTable schema', () => {
	it('hdb_model_calls attributes do not carry indexed:true (would produce phantom empty indexes)', () => {
		assert.ok(Array.isArray(MODEL_CALL_ATTRIBUTES), 'MODEL_CALL_ATTRIBUTES must be exported');
		const nonPk = MODEL_CALL_ATTRIBUTES.filter((a) => !a.isPrimaryKey);
		const offenders = nonPk.filter((a) => a.indexed);
		assert.strictEqual(
			offenders.length,
			0,
			'hdb_model_calls schema carries indexed: true on non-PK attributes — ' +
				'flush() bypasses updateIndices so the index would be permanently empty. ' +
				'Offending: ' +
				offenders.map((a) => a.name).join(', ')
		);
	});

	it('the primary key attribute has isPrimaryKey: true and name "id"', () => {
		const pk = MODEL_CALL_ATTRIBUTES.find((a) => a.isPrimaryKey);
		assert.ok(pk, 'expected one isPrimaryKey attribute');
		assert.strictEqual(pk.name, 'id');
	});

	it('flush still writes rows retrievable by their numeric id (PK scan)', async () => {
		const { ModelCallAnalyticsWriter: Writer } = require('#src/resources/models/analyticsTable');
		const store = new Map();
		const mockTbl = {
			primaryStore: {
				put(id, record) {
					store.set(id, record);
				},
				remove(id) {
					store.delete(id);
				},
				getKeys() {
					return [];
				},
			},
		};
		const w = new Writer({ flushIntervalMs: 60_000, cleanupIntervalMs: 60_000, getTable: () => mockTbl });
		w.write({ backend: 'test', method: 'embed', latency_ms: 5, success: true });
		await w.flush();
		w.stop();
		assert.strictEqual(store.size, 1, 'expected one row after flush');
		const [row] = store.values();
		assert.strictEqual(row.backend, 'test');
		assert.ok(typeof row.id === 'number', 'row must have a numeric id (PK)');
	});
});
