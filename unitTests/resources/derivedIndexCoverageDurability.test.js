'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { inspect } = require('node:util');
const { waitFor } = require('../waitFor');
const { DERIVED_INDEX_ACCEPTED, DerivedIndexRuntime, derivedIndexTime } = require('#src/resources/derivedIndexRuntime');
const { DERIVED_INDEX_CURSOR_KEY, HnswDerivedIndexBackend } = require('#src/resources/indexes/hnswDerivedIndex');
const {
	FullTextDerivedIndexBackend,
	decodeFullTextCursorPayload,
	encodeFullTextCursorPayload,
} = require('#src/resources/indexes/fullTextDerivedIndex');

const P0 = Object.freeze({ sequence: 1, offset: 32 });
const P1 = Object.freeze({ sequence: 1, offset: 64 });
const P2 = Object.freeze({ sequence: 1, offset: 128 });
const P3 = Object.freeze({ sequence: 1, offset: 192 });

function audit({ timestamp, recordId, tableId = 1, version = timestamp, type = 'put', endTxn = true }) {
	return {
		logName: 'local',
		txnLogKey: timestamp,
		version,
		recordId,
		tableId,
		type,
		endTxn,
		size: 32,
	};
}

class TestLogStore {
	constructor({ entries = [], initialPosition = P0 } = {}) {
		this.entries = entries.slice();
		this.purgedTimestamps = new Set();
		this.fileCount = 1;
		this.oldestSequenceNumber = 1;
		this.currentSequenceNumber = 1;
		this.committedPosition = initialPosition;
		this.flushedPosition = initialPosition;
		this.nextPosition = initialPosition;
		this.locks = new Set();
		this.waiters = new Map();
		this.sharedBuffers = new Map();
		this.kv = new Map();
		this.rootStore = new EventEmitter();
		this.rootStore.status = 'open';
		this.rootStore.listLogs = () => ['local'];
		this.rootStore.useLog = (name) => ({
			name,
			getStats: () => ({
				fileCount: this.fileCount,
				oldestSequenceNumber: this.oldestSequenceNumber,
				currentSequenceNumber: this.currentSequenceNumber,
				lastCommittedPosition: this.committedPosition,
				lastFlushedPosition: this.flushedPosition,
				nextLogPosition: this.nextPosition,
			}),
		});
		this.clockOffsetMs = 100_000;
		this.rootStore.getMonotonicTimestamp = () => performance.now() + this.clockOffsetMs;
		this.rootStore.getSync = (key) => this.kv.get(key);
		this.rootStore.removeSync = (key) => this.kv.delete(key);
	}

	putSync(key, value) {
		this.kv.set(key, value);
	}

	append(entry, position) {
		this.entries.push(entry);
		if (position) {
			this.committedPosition = position;
			this.flushedPosition = position;
			this.nextPosition = position;
		}
		this.rootStore.emit('committed');
	}

	purgeSegmentThrough(maxTimestamp, newOldestSequence = 2) {
		this.purgedTimestamps.add(50);
		for (const entry of this.entries) {
			if (entry.txnLogKey <= maxTimestamp) {
				this.purgedTimestamps.add(entry.txnLogKey);
			}
		}
		this.oldestSequenceNumber = newOldestSequence;
		this.currentSequenceNumber = Math.max(this.currentSequenceNumber, newOldestSequence);
	}

	getRange(options = {}) {
		const exactStartFailures = new Map();
		let blocked = false;
		let minExclusive = -Infinity;
		let minInclusive = -Infinity;
		if (options.startByLog instanceof Map) {
			if (options.startByLog.has('local')) {
				const start = options.startByLog.get('local');
				if (this.purgedTimestamps.has(start)) {
					exactStartFailures.set('local', 'missing');
					blocked = true;
				} else {
					minExclusive = start;
				}
			}
		} else {
			minInclusive = options.start ?? 0;
		}
		const store = this;
		return {
			corruptFrameStop: { breaks: 0, truncatedVersions: new Set(), midLogBreak: false },
			failedLogs: new Set(),
			exactStartFailures,
			[Symbol.iterator]() {
				let index = 0;
				return {
					next() {
						if (blocked) return { value: undefined, done: true };
						while (index < store.entries.length) {
							const entry = store.entries[index++];
							if (store.purgedTimestamps.has(entry.txnLogKey)) continue;
							if (entry.txnLogKey <= minExclusive) continue;
							if (entry.txnLogKey < minInclusive) continue;
							return { value: { ...entry }, done: false };
						}
						return { value: undefined, done: true };
					},
				};
			},
		};
	}

	ensureLogExists() {}

	tryLock(key, onUnlocked) {
		if (!this.locks.has(key)) {
			this.locks.add(key);
			return true;
		}
		if (onUnlocked) {
			let waiters = this.waiters.get(key);
			if (!waiters) this.waiters.set(key, (waiters = []));
			waiters.push(onUnlocked);
		}
		return false;
	}

	unlock(key) {
		this.locks.delete(key);
		for (const waiter of this.waiters.get(key) ?? []) setImmediate(waiter);
		this.waiters.delete(key);
	}

	getUserSharedBuffer(key, defaultBuffer, options) {
		let memory = this.sharedBuffers.get(key);
		if (!memory) {
			memory = { buffer: new SharedArrayBuffer(defaultBuffer.byteLength), callbacks: new Set() };
			this.sharedBuffers.set(key, memory);
		}
		const wrapper = structuredClone(memory.buffer);
		const { callback } = options ?? {};
		if (callback) memory.callbacks.add(callback);
		wrapper.notify = () => {
			for (const listener of memory.callbacks) setImmediate(listener);
		};
		wrapper.cancel = () => {
			if (callback) memory.callbacks.delete(callback);
		};
		return wrapper;
	}
}

class MemoryHnswIndex {
	constructor(initialCursor) {
		this.store = new Map();
		this.putHistory = [];
		this.applied = [];
		if (initialCursor !== undefined) {
			this.store.set(DERIVED_INDEX_CURSOR_KEY, initialCursor);
		}
		this.indexStore = {
			getSync: (key) => this.store.get(key),
			putSync: (key, value) => {
				const cloned = structuredClone(value);
				this.store.set(key, cloned);
				if (key === DERIVED_INDEX_CURSOR_KEY) {
					this.putHistory.push(cloned);
				}
			},
			removeSync: (key) => this.store.delete(key),
			clear: async () => this.store.clear(),
		};
	}

	applyDerivedValue(primaryKey, vector) {
		this.applied.push({ primaryKey, vector });
	}

	async flushDerived() {}

	async resetDerivedStorage() {
		this.applied.length = 0;
	}
}

function createSharedFullTextState(initialCursor) {
	return {
		payload: initialCursor ? encodeFullTextCursorPayload(initialCursor) : undefined,
		publicationHistory: [],
		resetCalls: 0,
		createLifecycle() {
			const state = this;
			return {
				inspect() {
					if (!state.payload) return { state: 'missing' };
					return { state: 'checkpointed', committedPayload: state.payload };
				},
				async open() {
					return {
						committedPayload: state.payload,
						async applyMutationBatch(batch) {
							return {
								processed: batch.upserts.length + batch.deletes.length,
								rejected: [],
								encodedBytes: 1,
								frames: 1,
							};
						},
						async publish(payload) {
							state.payload = payload;
							state.publicationHistory.push(decodeFullTextCursorPayload(payload));
							this.committedPayload = payload;
							return 1n;
						},
						async close() {
							return {};
						},
					};
				},
				async reset() {
					state.resetCalls++;
					state.payload = undefined;
				},
			};
		},
	};
}

function normalizeCursor(cursor) {
	return cursor === undefined ? undefined : JSON.parse(JSON.stringify(cursor));
}

function safeJson(value) {
	return inspect(value, { depth: null, compact: true, breakLength: Infinity });
}

function createRuntime(store, records, options = {}) {
	return new DerivedIndexRuntime(store, (tableId, recordId) => records.get(`${tableId}:${recordId}`), {
		flushAfterMutations: 1,
		maxFlushAgeMilliseconds: 20,
		idleGraceMilliseconds: 1000,
		scanRecords: function* (tableId) {
			for (const [key, entry] of records.entries()) {
				const [entryTableId, recordId] = key.split(':');
				if (Number(entryTableId) === tableId) {
					yield { recordId, version: entry.version, value: entry.value };
				}
			}
		},
		...options,
	});
}

describe('DerivedIndexRuntime & HNSW/FullText coverage durability and purged-anchor recovery', () => {
	it('Positive Control (HNSW): publishes coverage for indexed writes and recovers purged anchors to a log floor without rebuilding', async () => {
		const initialCursor = { format: 1, logs: { local: 50 }, coverage: { local: P0 } };
		const store = new TestLogStore({ initialPosition: P0 });
		const records = new Map([['1:doc-1', { version: 100, value: { vector: [1, 0, 0, 0] } }]]);
		const hnswIndex = new MemoryHnswIndex(initialCursor);
		const backend1 = new HnswDerivedIndexBackend('hnsw:positive', hnswIndex);
		const owner = createRuntime(store, records, { maxFlushAgeMilliseconds: 15 });
		owner.register({
			backend: backend1,
			projections: new Map([[1, (record) => record.vector]]),
		});

		await waitFor(() => owner.getReadiness(backend1.id).state === 'ready');
		store.append(audit({ timestamp: 100, recordId: 'doc-1', tableId: 1 }), P1);

		await waitFor(() => {
			const cursor = backend1.getDurableCursor();
			return cursor?.logs?.local === 100 && cursor?.coverage?.local?.offset === P1.offset;
		});
		assert.deepStrictEqual(backend1.getDurableCursor(), {
			format: 1,
			logs: { local: 100 },
			coverage: { local: P1 },
		});

		const peerBackend = new HnswDerivedIndexBackend('hnsw:positive', hnswIndex);
		const peer = createRuntime(store, records, { maxFlushAgeMilliseconds: 15 });
		peer.register({
			backend: peerBackend,
			projections: new Map([[1, (record) => record.vector]]),
		});
		const since = derivedIndexTime(store.rootStore);
		const started = performance.now();
		await peer.waitForCoverage(backend1.id, since, 500);
		assert(performance.now() - started < 500, 'peer waitForCoverage should resolve within 500ms');

		await peer.stop();
		await owner.stop();

		store.purgeSegmentThrough(100, 2);

		const backend2 = new HnswDerivedIndexBackend('hnsw:positive', hnswIndex);
		const reopened = createRuntime(store, records, { maxFlushAgeMilliseconds: 15 });
		reopened.register({
			backend: backend2,
			projections: new Map([[1, (record) => record.vector]]),
		});

		await waitFor(() => {
			const cursor = backend2.getDurableCursor();
			return cursor?.floors?.local === 2 && cursor?.logs?.local === undefined;
		});
		assert.strictEqual(reopened.getReadiness(backend2.id).state, 'ready');
		assert.strictEqual(reopened.getMetrics(backend2.id).rebuiltRecords, 0);
		assert.deepStrictEqual(backend2.getDurableCursor(), {
			format: 1,
			logs: {},
			floors: { local: 2 },
			coverage: { local: P1 },
		});
		await reopened.stop();
	});

	it('Positive Control (FullText): publishes coverage for indexed writes and recovers purged anchors to a log floor without rebuilding', async () => {
		const initialCursor = { format: 1, logs: { local: 50 }, coverage: { local: P0 } };
		const store = new TestLogStore({ initialPosition: P0 });
		const records = new Map([['1:doc-1', { version: 100, value: { title: 'hello world' } }]]);
		const ftState = createSharedFullTextState(initialCursor);
		const backend1 = new FullTextDerivedIndexBackend({
			id: 'fulltext:positive',
			lifecycle: ftState.createLifecycle(),
		});
		const owner = createRuntime(store, records, { maxFlushAgeMilliseconds: 15 });
		owner.register({
			backend: backend1,
			projections: new Map([[1, (record) => ({ title: record.title })]]),
		});

		await waitFor(() => owner.getReadiness(backend1.id).state === 'ready');
		store.append(audit({ timestamp: 100, recordId: 'doc-1', tableId: 1 }), P1);

		await waitFor(() => {
			const cursor = backend1.getDurableCursor();
			return cursor?.logs?.local === 100 && cursor?.coverage?.local?.offset === P1.offset;
		});
		assert.deepStrictEqual(normalizeCursor(backend1.getDurableCursor()), {
			format: 1,
			logs: { local: 100 },
			coverage: { local: P1 },
		});
		await owner.stop();

		store.purgeSegmentThrough(100, 2);

		const backend2 = new FullTextDerivedIndexBackend({
			id: 'fulltext:positive',
			lifecycle: ftState.createLifecycle(),
		});
		const reopened = createRuntime(store, records, { maxFlushAgeMilliseconds: 15 });
		reopened.register({
			backend: backend2,
			projections: new Map([[1, (record) => ({ title: record.title })]]),
		});

		await waitFor(() => {
			const cursor = backend2.getDurableCursor();
			return cursor?.floors?.local === 2 && cursor?.logs?.local === undefined;
		});
		assert.strictEqual(reopened.getReadiness(backend2.id).state, 'ready');
		assert.strictEqual(reopened.getMetrics(backend2.id).rebuiltRecords, 0);
		assert.strictEqual(ftState.resetCalls, 0);
		assert.deepStrictEqual(normalizeCursor(backend2.getDurableCursor()), {
			format: 1,
			logs: {},
			floors: { local: 2 },
			coverage: { local: P1 },
		});
		await reopened.stop();
	});

	it('Arm 1: unindexed sibling-table commits must not stamp coverage onto an older durable vector or strip coverage on flush/shutdown', async () => {
		const initialCursor = { format: 1, logs: { local: 50 }, coverage: { local: P0 } };
		const failures = [];

		{
			const store = new TestLogStore({ initialPosition: P0 });
			const records = new Map([
				['1:doc-1', { version: 100, value: { vector: [1, 0, 0, 0] } }],
				['2:sibling-1', { version: 200, value: { note: 'unindexed table commit' } }],
			]);
			const hnswIndex = new MemoryHnswIndex(initialCursor);
			const backend1 = new HnswDerivedIndexBackend('hnsw:arm1', hnswIndex);
			const runtime1 = createRuntime(store, records, {
				flushAfterMutations: 1,
				maxFlushAgeMilliseconds: 1000,
				idleGraceMilliseconds: 5000,
			});
			runtime1.register({
				backend: backend1,
				projections: new Map([[1, (record) => record.vector]]),
			});

			store.append(audit({ timestamp: 100, recordId: 'doc-1', tableId: 1 }), P1);
			await waitFor(() => {
				const cursor = backend1.getDurableCursor();
				return cursor?.logs?.local === 100 && cursor?.coverage?.local?.offset === P1.offset;
			});

			store.append(audit({ timestamp: 200, recordId: 'sibling-1', tableId: 2 }), P2);
			await waitFor(() => runtime1.getMetrics(backend1.id)?.acceptedBatches >= 1);

			// An in-flight write advances nextPosition past committedPosition so the idle pass cannot capture coverage at the barrier.
			store.nextPosition = P3;
			await backend1.flush('age');
			await waitFor(
				() =>
					backend1.getDurableCursor()?.logs?.local === 200 && runtime1.getMetrics(backend1.id)?.acceptedBatches === 0
			);
			await runtime1.stop();
			store.nextPosition = P2;

			const cursorAtClose = backend1.getDurableCursor();
			if (cursorAtClose?.logs?.local !== 200 || cursorAtClose?.coverage?.local?.offset !== P2.offset) {
				failures.push(
					`HNSW Part A1: durable cursor after flushing unindexed commit T2=200 lost coverage (got ${JSON.stringify(cursorAtClose)}, expected logs.local=200 with coverage.local.offset=${P2.offset})`
				);
			}

			store.purgeSegmentThrough(200, 2);
			const backend2 = new HnswDerivedIndexBackend('hnsw:arm1', hnswIndex);
			const runtime2 = createRuntime(store, records, {
				maxFlushAgeMilliseconds: 15,
				maxRebuildAttempts: 0,
			});
			runtime2.register({
				backend: backend2,
				projections: new Map([[1, (record) => record.vector]]),
			});

			await waitFor(() => {
				const state = runtime2.getStatus(backend2.id)?.state;
				const cursor = backend2.getDurableCursor();
				return state === 'needs-rebuild' || state === 'unavailable' || cursor?.floors?.local === 2;
			});
			const status2 = runtime2.getStatus(backend2.id);
			const readiness2 = runtime2.getReadiness(backend2.id);
			if (readiness2.state !== 'ready' || backend2.getDurableCursor()?.floors?.local !== 2) {
				failures.push(
					`HNSW Part A2: reopening after segment 1 purge failed purged-anchor recovery (readiness=${safeJson(readiness2)}, status=${safeJson(status2)}, cursor=${safeJson(backend2.getDurableCursor())})`
				);
			}
			await runtime2.stop();
		}

		{
			const store = new TestLogStore({ initialPosition: P0 });
			const records = new Map([
				['1:doc-1', { version: 100, value: { title: 'indexed doc' } }],
				['2:sibling-1', { version: 200, value: { note: 'unindexed table commit' } }],
			]);
			const ftState = createSharedFullTextState(initialCursor);
			const backend1 = new FullTextDerivedIndexBackend({
				id: 'fulltext:arm1',
				lifecycle: ftState.createLifecycle(),
			});
			const runtime1 = createRuntime(store, records, {
				flushAfterMutations: 1,
				maxFlushAgeMilliseconds: 1000,
				idleGraceMilliseconds: 5000,
			});
			runtime1.register({
				backend: backend1,
				projections: new Map([[1, (record) => ({ title: record.title })]]),
			});

			store.append(audit({ timestamp: 100, recordId: 'doc-1', tableId: 1 }), P1);
			await waitFor(() => {
				const cursor = backend1.getDurableCursor();
				return cursor?.logs?.local === 100 && cursor?.coverage?.local?.offset === P1.offset;
			});

			store.append(audit({ timestamp: 200, recordId: 'sibling-1', tableId: 2 }), P2);
			await waitFor(() => runtime1.getMetrics(backend1.id)?.acceptedBatches >= 1);

			// An in-flight write advances nextPosition past committedPosition so the idle pass cannot capture coverage at the barrier.
			store.nextPosition = P3;
			await backend1.flush('age');
			await waitFor(
				() =>
					backend1.getDurableCursor()?.logs?.local === 200 && runtime1.getMetrics(backend1.id)?.acceptedBatches === 0
			);
			await runtime1.stop();
			store.nextPosition = P2;

			const cursorAtClose = decodeFullTextCursorPayload(ftState.payload);
			if (cursorAtClose?.logs?.local !== 200 || cursorAtClose?.coverage?.local?.offset !== P2.offset) {
				failures.push(
					`FullText Part B1: durable cursor after flushing unindexed commit T2=200 lost coverage (got ${JSON.stringify(cursorAtClose)}, expected logs.local=200 with coverage.local.offset=${P2.offset})`
				);
			}

			store.purgeSegmentThrough(200, 2);
			const backend2 = new FullTextDerivedIndexBackend({
				id: 'fulltext:arm1',
				lifecycle: ftState.createLifecycle(),
			});
			const runtime2 = createRuntime(store, records, {
				maxFlushAgeMilliseconds: 15,
				maxRebuildAttempts: 0,
			});
			runtime2.register({
				backend: backend2,
				projections: new Map([[1, (record) => ({ title: record.title })]]),
			});

			await waitFor(() => {
				const state = runtime2.getStatus(backend2.id)?.state;
				const cursor = backend2.getDurableCursor();
				return state === 'needs-rebuild' || state === 'unavailable' || cursor?.floors?.local === 2;
			});
			const status2 = runtime2.getStatus(backend2.id);
			const readiness2 = runtime2.getReadiness(backend2.id);
			if (readiness2.state !== 'ready' || backend2.getDurableCursor()?.floors?.local !== 2) {
				failures.push(
					`FullText Part B2: reopening after segment 1 purge failed purged-anchor recovery (readiness=${safeJson(readiness2)}, status=${safeJson(status2)}, cursor=${safeJson(backend2.getDurableCursor())})`
				);
			}
			await runtime2.stop();
		}

		assert.deepStrictEqual(failures, []);
	});

	it('Arm 2: HnswDerivedIndexBackend retains explicit coverage on floor-conversion batches after a flush and strips it when un-barriered records were applied before shutdown', async () => {
		let currentEpoch = 1n;
		const hnswIndex = new MemoryHnswIndex({ format: 1, logs: { local: 50 }, coverage: { local: P0 } });
		const backend = new HnswDerivedIndexBackend('hnsw:arm2', hnswIndex);
		backend.attach({
			isOwnerEpoch: (epoch) => epoch === currentEpoch,
			getReadiness: () => ({ state: 'ready', ownerEpoch: currentEpoch, rebuildAttempts: 0 }),
			publicationChanged: () => {},
		});

		const recordBatch = {
			ownerEpoch: 1n,
			transactions: [],
			records: [
				{
					recordId: 'doc-1',
					logVersion: 100,
					state: { kind: 'record', projection: [1, 0, 0, 0], version: 100 },
				},
			],
			through: { format: 1, logs: { local: 100 } },
			bytes: 32,
		};
		assert.strictEqual(backend.deliver(recordBatch), DERIVED_INDEX_ACCEPTED);
		backend.flush('threshold');
		await waitFor(() => backend.getDurableCursor()?.logs?.local === 100);

		const floorConversionBatch = {
			ownerEpoch: 1n,
			transactions: [],
			records: [],
			through: {
				format: 1,
				logs: {},
				floors: { local: 2 },
				coverage: { local: P1 },
			},
			bytes: 0,
		};
		assert.strictEqual(backend.deliver(floorConversionBatch), DERIVED_INDEX_ACCEPTED);
		backend.flush('age');
		await waitFor(() => backend.getDurableCursor()?.floors?.local === 2);

		assert.deepStrictEqual(backend.getDurableCursor(), {
			format: 1,
			logs: {},
			floors: { local: 2 },
			coverage: { local: P1 },
		});

		const unbarrieredBatch = {
			ownerEpoch: 1n,
			transactions: [],
			records: [
				{
					recordId: 'doc-2',
					logVersion: 150,
					state: { kind: 'record', projection: [0, 1, 0, 0], version: 150 },
				},
			],
			bytes: 32,
		};
		assert.strictEqual(backend.deliver(unbarrieredBatch), DERIVED_INDEX_ACCEPTED);
		await waitFor(() => hnswIndex.applied.length === 2);
		await backend.shutdown(1n);

		currentEpoch = 2n;
		const postShutdownFloorBatch = {
			ownerEpoch: 2n,
			transactions: [],
			records: [],
			through: {
				format: 1,
				logs: {},
				floors: { local: 3 },
				coverage: { local: P1 },
			},
			bytes: 0,
		};
		assert.strictEqual(backend.deliver(postShutdownFloorBatch), DERIVED_INDEX_ACCEPTED);
		backend.flush('age');
		await waitFor(() => backend.getDurableCursor()?.floors?.local === 3);

		assert.deepStrictEqual(backend.getDurableCursor(), {
			format: 1,
			logs: {},
			floors: { local: 3 },
		});
		await backend.shutdown(2n);
	});

	it('Arm 3: advancing the durable cursor publishes bound coverage for that cursor and refuses stale coverage from before an indexed mutation', async () => {
		const store = new TestLogStore({ initialPosition: P0 });
		store.rootStore.getMonotonicTimestamp = () => Date.now();
		const records = new Map([
			['1:doc-1', { version: 100, value: { title: 'doc-1' } }],
			['2:sibling-1', { version: 200, value: { note: 'unindexed' } }],
			['1:doc-2', { version: 300, value: { title: 'doc-2' } }],
		]);

		const persisted = [];
		const backend = {
			id: 'runner:arm3',
			cursor: { format: 1, logs: { local: 50 } },
			deliveries: [],
			attach(host) {
				this.host = host;
			},
			getDurableCursor() {
				return this.cursor;
			},
			deliver(batch) {
				this.deliveries.push(batch);
				return DERIVED_INDEX_ACCEPTED;
			},
			flush() {},
			shutdown() {},
			publishCoverage(positions, ownerEpoch) {
				this.cursor = { ...this.cursor, coverage: structuredClone(positions) };
				persisted.push({
					positions: structuredClone(positions),
					cursor: structuredClone(this.cursor),
					ownerEpoch,
				});
			},
			onStateChange(wake) {
				this.stateChange = wake;
				return () => {
					if (this.stateChange === wake) this.stateChange = undefined;
				};
			},
		};

		const runtime = createRuntime(store, records, {
			flushAfterMutations: 1,
			maxFlushAgeMilliseconds: 60_000,
			idleGraceMilliseconds: 60_000,
		});
		runtime.register({
			backend,
			projections: new Map([[1, (record) => ({ title: record.title })]]),
		});

		await waitFor(() => persisted.length === 1);
		assert.deepStrictEqual(persisted[0].cursor, {
			format: 1,
			logs: { local: 50 },
			coverage: { local: P0 },
		});

		store.append(audit({ timestamp: 100, recordId: 'doc-1', tableId: 1 }), P1);
		await waitFor(() => runtime.getMetrics(backend.id)?.acceptedMutations === 1);

		// An in-flight write advances nextPosition past committedPosition so the idle pass cannot capture coverage at the barrier.
		store.nextPosition = { sequence: 1, offset: 96 };
		backend.cursor = { format: 1, logs: { local: 100 } };
		backend.stateChange('changed');

		await waitFor(() => persisted.length === 2);
		assert.deepStrictEqual(persisted[1].cursor, {
			format: 1,
			logs: { local: 100 },
			coverage: { local: P1 },
		});

		store.nextPosition = P1;
		store.append(audit({ timestamp: 200, recordId: 'sibling-1', tableId: 2 }), P2);
		await waitFor(() => runtime.getMetrics(backend.id)?.acceptedBatches === 1);

		// An in-flight write keeps T3's idle pass from capturing coverage, leaving only T2's bound P2 capture on the earlier offered cursor.
		store.entries.push(audit({ timestamp: 300, recordId: 'doc-2', tableId: 1 }));
		store.committedPosition = P3;
		store.flushedPosition = P3;
		store.nextPosition = { sequence: 1, offset: 256 };
		store.rootStore.emit('committed');
		await waitFor(
			() =>
				runtime.getMetrics(backend.id)?.acceptedBatches === 2 && runtime.getMetrics(backend.id)?.acceptedMutations === 1
		);

		backend.cursor = { format: 1, logs: { local: 300 } };
		backend.stateChange('changed');
		await waitFor(() => runtime.getMetrics(backend.id)?.acceptedBatches === 0);

		assert.strictEqual(persisted.length, 2);
		assert.strictEqual(backend.cursor.coverage, undefined);

		await runtime.stop();
	});
});
