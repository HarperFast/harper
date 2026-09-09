require('../testUtils');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { waitFor } = require('../waitFor');
const { setupTestDBPath } = require('../testUtils');
const { ClientError } = require('#src/utility/errors/hdbError');
const {
	derivedIndexWriteRejection,
	hasDerivedIndexRegistration,
	registerDerivedIndexTables,
} = require('#src/resources/derivedIndexRegistry');
const {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	DerivedIndexRuntime,
	readDerivedIndexReadiness,
} = require('#src/resources/derivedIndexRuntime');

// A shared fake of the RocksDB transaction-log store: `entriesByCursor` maps a resume timestamp to
// the entries physically after it, `logEntries` is the retained log used by the rebuild boundary
// capture, and every worker (runtime) sharing one instance shares its locks and shared buffers.
class FakeLogStore {
	constructor(
		entriesByCursor,
		{ logNames = ['local'], logEntries = new Map(), onNext, live = false, markers = new Map() } = {}
	) {
		this.entriesByCursor = entriesByCursor;
		this.logEntries = logEntries;
		// Root-store markers survive a "restart" (a new FakeLogStore sharing this map); shared buffers do not.
		this.markers = markers;
		this.onNext = onNext;
		this.live = live;
		this.locks = new Set();
		this.waiters = new Map();
		this.sharedBuffers = new Map();
		this.bufferLookups = 0;
		this.rangeCalls = [];
		this.exactStartFailures = new Map();
		this.rootStore = new EventEmitter();
		this.rootStore.listLogs = () => logNames.slice();
		this.rootStore.useLog = (name) => ({ name, getStats: () => ({ oldestSequenceNumber: 1 }) });
		this.rootStore.getSync = (key) => this.markers.get(key);
		this.rootStore.removeSync = (key) => this.markers.delete(key);
	}

	putSync(key, value) {
		this.markers.set(key, value);
	}

	getRange(options) {
		this.rangeCalls.push(options);
		let entries;
		if (options.log !== undefined) {
			entries = (this.logEntries.get(options.log) ?? []).map((entry) => ({ ...entry }));
		} else {
			const start = options.startByLog.get('local');
			const source = this.entriesByCursor.get(start) ?? [];
			entries = this.live ? source : source.map((entry) => ({ ...entry }));
		}
		const store = this;
		const iterable = {
			corruptFrameStop: { breaks: 0, truncatedVersions: new Set(), midLogBreak: false },
			failedLogs: new Set(),
			exactStartFailures: new Map(options.log === undefined ? this.exactStartFailures : []),
			[Symbol.iterator]() {
				let index = 0;
				return {
					next() {
						store.onNext?.(entries[index], index);
						return index < entries.length ? { value: entries[index++], done: false } : { value: undefined, done: true };
					},
					return() {
						return { value: undefined, done: true };
					},
				};
			},
		};
		return iterable;
	}

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
		this.bufferLookups++;
		let memory = this.sharedBuffers.get(key);
		if (!memory) {
			memory = { buffer: new SharedArrayBuffer(defaultBuffer.byteLength), callbacks: new Set() };
			this.sharedBuffers.set(key, memory);
		}
		// Like the native binding, each lookup returns its own wrapper over the same shared memory with
		// notification and cancellation bound to that lookup's subscription.
		const wrapper = structuredClone(memory.buffer);
		const { callback } = options ?? {};
		if (callback) memory.callbacks.add(callback);
		wrapper.callbacks = memory.callbacks;
		wrapper.notify = () => {
			for (const listener of memory.callbacks) setImmediate(listener);
		};
		wrapper.cancel = () => {
			if (callback) memory.callbacks.delete(callback);
		};
		return wrapper;
	}
}

// A queue-and-accept backend shaped like a native index: deliver() only enqueues, an applier drains
// the queue asynchronously, and the cursor becomes durable at flush(). Every apply and flush is
// fenced by the owner epoch the runtime handed it through attach().
class AsyncBackend {
	constructor(id, { cursor, applyDelay = 0, capacity = Infinity, onReset, applyRecord } = {}) {
		this.id = id;
		this.asynchronous = true;
		this.cursor = cursor;
		this.deliveries = [];
		this.queue = [];
		this.applied = new Map();
		this.appliedCursor = cursor;
		this.flushes = [];
		this.resets = [];
		this.shutdowns = [];
		this.fenced = 0;
		this.applyDelay = applyDelay;
		this.capacity = capacity;
		this.onReset = onReset;
		this.applyRecord = applyRecord;
		this.pendingFlush = undefined;
		this.applying = false;
	}

	attach(host) {
		this.host = host;
	}

	getDurableCursor() {
		return this.cursor;
	}

	deliver(batch) {
		this.deliveries.push(batch);
		if (this.queue.length >= this.capacity) return DERIVED_INDEX_DEFERRED;
		this.currentEpoch = batch.ownerEpoch;
		this.queue.push(batch);
		this.scheduleApply();
		return DERIVED_INDEX_ACCEPTED;
	}

	scheduleApply() {
		if (this.applying || this.queue.length === 0) return;
		this.applying = true;
		setTimeout(() => {
			this.applying = false;
			const batch = this.queue.shift();
			if (!this.host.isOwnerEpoch(batch.ownerEpoch)) {
				this.fenced++;
			} else {
				try {
					for (const record of batch.records) {
						if (this.applyRecord) this.applyRecord(record);
						if (record.state.kind === 'record') this.applied.set(record.recordId, record.state);
						else this.applied.delete(record.recordId);
					}
					if (batch.through) this.appliedCursor = batch.through;
				} catch {
					this.queue.length = 0;
					this.stateChange?.('failed');
					return;
				}
			}
			const hadCapacity = this.queue.length < this.capacity;
			this.scheduleApply();
			if (!hadCapacity || this.queue.length === 0) this.stateChange?.('changed');
		}, this.applyDelay);
	}

	flush(reason) {
		this.flushes.push(reason);
		if (this.pendingFlush) return;
		const epoch = this.currentEpoch;
		this.pendingFlush = new Promise((resolve) =>
			setTimeout(() => {
				this.pendingFlush = undefined;
				if (epoch !== undefined && !this.host.isOwnerEpoch(epoch)) this.fenced++;
				else if (this.queue.length === 0 && !this.applying) {
					this.cursor = this.appliedCursor;
					this.stateChange?.('changed');
				} else this.flush('age');
				resolve();
			}, this.applyDelay + 1)
		);
	}

	reset(ownerEpoch) {
		this.onReset?.(ownerEpoch);
		this.resets.push(ownerEpoch);
		this.queue.length = 0;
		this.applied.clear();
		this.cursor = undefined;
		this.appliedCursor = undefined;
	}

	async shutdown(ownerEpoch) {
		this.shutdowns.push(ownerEpoch);
		while (this.pendingFlush) await this.pendingFlush;
		this.queue.length = 0;
	}

	onStateChange(wake) {
		this.stateChange = wake;
		return () => {
			if (this.stateChange === wake) this.stateChange = undefined;
		};
	}
}

class SyncBackend {
	constructor(id, cursor, deliver) {
		this.id = id;
		this.cursor = cursor;
		this.deliveries = [];
		this.deliverImpl = deliver;
	}

	getDurableCursor() {
		return this.cursor;
	}

	deliver(batch) {
		this.deliveries.push(batch);
		if (this.deliverImpl) return this.deliverImpl(batch, this);
		this.cursor = batch.through;
		return DERIVED_INDEX_ACCEPTED;
	}

	onStateChange(wake) {
		this.stateChange = wake;
		return () => {
			if (this.stateChange === wake) this.stateChange = undefined;
		};
	}
}

const cursor = (timestamp) => ({ format: 1, logs: { local: timestamp } });
const audit = ({ timestamp, recordId, tableId = 1, version = timestamp, type = 'put', endTxn = true, size = 32 }) => ({
	logName: 'local',
	txnLogKey: timestamp,
	version,
	recordId,
	tableId,
	type,
	endTxn,
	size,
});

function runtimeFor(store, records, options) {
	let reads = 0;
	const runtime = new DerivedIndexRuntime(
		store,
		(tableId, recordId) => {
			reads++;
			return records.get(`${tableId}:${recordId}`);
		},
		{
			idleGraceMilliseconds: 5,
			scanRecords: (tableId) =>
				[...records.entries()]
					.filter(([key]) => key.startsWith(`${tableId}:`))
					.map(([key, record]) => ({ recordId: key.slice(key.indexOf(':') + 1), ...record })),
			...options,
		}
	);
	return { runtime, getReads: () => reads };
}

const registration = (backend, options) => ({
	backend,
	projections: new Map([[1, (record) => ({ title: record.title })]]),
	options,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DerivedIndexRuntime for native backends', () => {
	const rejections = [];
	const onRejection = (reason) => rejections.push(reason);
	before(() => process.on('unhandledRejection', onRejection));
	after(() => process.off('unhandledRejection', onRejection));
	afterEach(() => {
		assert.deepStrictEqual(rejections, [], 'runtime work must settle without unhandled rejections');
	});

	it('coalesces repeated keys into one last-write-wins record beside the unchanged transactions', async () => {
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						audit({ timestamp: 20, recordId: 'a', version: 100 }),
						audit({ timestamp: 30, recordId: 'b', version: 200 }),
						audit({ timestamp: 40, recordId: 'a', version: 300 }),
					],
				],
			])
		);
		const backend = new SyncBackend('coalesce', cursor(10));
		const { runtime, getReads } = runtimeFor(
			store,
			new Map([
				['1:a', { version: 300, value: { title: 'a' } }],
				['1:b', { version: 200, value: { title: 'b' } }],
			])
		);
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1);
		const [batch] = backend.deliveries;
		assert.deepStrictEqual(batch.through, cursor(40));
		assert.strictEqual(batch.transactions.length, 3);
		assert.deepStrictEqual(
			batch.records.map(({ recordId, logVersion }) => [recordId, logVersion]),
			[
				['a', 300],
				['b', 200],
			]
		);
		assert.strictEqual(batch.records[0].state, batch.transactions[0].mutations[0].state);
		assert.strictEqual(batch.records[0].state, batch.transactions[2].mutations[0].state);
		assert.strictEqual(batch.transactions[0].mutations[0].logVersion, 100);
		assert.strictEqual(getReads(), 2);
		assert.deepStrictEqual(Object.keys(batch), ['ownerEpoch', 'transactions', 'through']);
		await runtime.stop();
	});

	it('resolves a key after its last collected occurrence so a concurrent write cannot be certified stale', async () => {
		const records = new Map([['1:a', { version: 100, value: { title: 'v1' } }]]);
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						audit({ timestamp: 20, recordId: 'a', version: 100 }),
						audit({ timestamp: 30, recordId: 'a', version: 200 }),
					],
				],
			]),
			{
				onNext: (entry) => {
					// Another worker commits a=v2 after the first occurrence has been read.
					if (entry?.txnLogKey === 30) records.set('1:a', { version: 200, value: { title: 'v2' } });
				},
			}
		);
		const backend = new SyncBackend('ordered', cursor(10));
		const { runtime, getReads } = runtimeFor(store, records);
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1);
		const [batch] = backend.deliveries;
		assert.deepStrictEqual(batch.through, cursor(30));
		assert.deepStrictEqual(batch.records[0].state, { kind: 'record', version: 200, projection: { title: 'v2' } });
		assert.strictEqual(getReads(), 1);
		await runtime.stop();
	});

	it('delivers an oversized transaction in partial chunks that advance no cursor until it closes', async () => {
		const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
		const entries = ids.map((id, index) => audit({ timestamp: 20, recordId: id, endTxn: index === ids.length - 1 }));
		entries.push(audit({ timestamp: 30, recordId: 'z' }));
		const store = new FakeLogStore(new Map([[10, entries]]));
		const records = new Map([...ids, 'z'].map((id) => [`1:${id}`, { version: 20, value: { title: id } }]));
		let defer = true;
		const backend = new SyncBackend('oversized', cursor(10), (batch, target) => {
			if (defer) return DERIVED_INDEX_DEFERRED;
			target.cursor = batch.through;
			return DERIVED_INDEX_ACCEPTED;
		});
		const { runtime } = runtimeFor(store, records, { maxChunkRecords: 3 });
		runtime.register(registration(backend));

		await waitFor(() => runtime.getStatus('oversized')?.state === 'deferred');
		assert.strictEqual(backend.deliveries.length, 1, 'the backend can defer after the first chunk');
		await sleep(5);
		assert(runtime.getMetrics('oversized').stalledMilliseconds > 0, 'a parked runner reports how long it has stalled');
		assert.strictEqual(backend.deliveries[0].records.length, 3);
		assert.strictEqual(backend.deliveries[0].transactions[0].partial, true);
		assert.deepStrictEqual(backend.deliveries[0].through, cursor(10));
		assert.strictEqual(runtime.getMetrics('oversized').deferredBytes, 96);
		defer = false;
		backend.stateChange();

		await waitFor(() => backend.cursor.logs.local === 30);
		const chunks = backend.deliveries.filter((batch, index) => index === 0 || batch !== backend.deliveries[index - 1]);
		assert.deepStrictEqual(
			chunks.map((batch) => [batch.records.map((record) => record.recordId).join(''), batch.through.logs.local]),
			[
				['abc', 10],
				['def', 10],
				['gz', 30],
			]
		);
		assert.deepStrictEqual(
			chunks.map((batch) => batch.transactions.map((transaction) => [transaction.timestamp, transaction.partial])),
			[
				[[20, true]],
				[[20, true]],
				[
					[20, undefined],
					[30, undefined],
				],
			]
		);
		await runtime.stop();
	});

	it('lets a registration override the runtime-wide turn and durability options', async () => {
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						audit({ timestamp: 20, recordId: 'a' }),
						audit({ timestamp: 30, recordId: 'b' }),
						audit({ timestamp: 40, recordId: 'c' }),
					],
				],
			])
		);
		const records = new Map(['a', 'b', 'c'].map((id) => [`1:${id}`, { version: 40, value: { title: id } }]));
		const backend = new SyncBackend('per-registration', cursor(10), () => DERIVED_INDEX_ACCEPTED);
		const { runtime } = runtimeFor(store, records, { maxTransactionsPerTurn: 256, maxAcceptedBatchesAhead: 64 });
		runtime.register(registration(backend, { maxTransactionsPerTurn: 1, maxAcceptedBatchesAhead: 2 }));

		await waitFor(() => runtime.getStatus('per-registration')?.state === 'waiting-durable');
		assert.strictEqual(backend.deliveries.length, 2);
		assert.deepStrictEqual(
			backend.deliveries.map((batch) => batch.through.logs.local),
			[20, 30]
		);
		await sleep(5);
		assert(runtime.getMetrics('per-registration').stalledMilliseconds > 0);
		backend.cursor = backend.deliveries[1].through;
		backend.stateChange();
		await waitFor(() => backend.deliveries.length === 3);
		backend.cursor = backend.deliveries[2].through;
		backend.stateChange();
		await waitFor(() => runtime.getStatus('per-registration').state === 'idle');
		assert.strictEqual(
			runtime.getMetrics('per-registration').stalledMilliseconds,
			0,
			'leaving the ceiling clears the stall clock'
		);
		await runtime.stop();
	});

	it('requests flushes by threshold, by age, and at shutdown', async () => {
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						audit({ timestamp: 20, recordId: 'a' }),
						audit({ timestamp: 30, recordId: 'b' }),
						audit({ timestamp: 40, recordId: 'c' }),
					],
				],
			])
		);
		const records = new Map(['a', 'b', 'c'].map((id) => [`1:${id}`, { version: 40, value: { title: id } }]));
		const backend = new AsyncBackend('cadence', { cursor: cursor(10) });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(
			registration(backend, { maxTransactionsPerTurn: 1, flushAfterMutations: 2, maxFlushAgeMilliseconds: 20 })
		);

		await waitFor(() => backend.flushes.includes('threshold'));
		await waitFor(() => backend.flushes.includes('age'), { timeout: 2000 });
		await waitFor(() => backend.cursor.logs.local === 40 && runtime.getStatus('cadence').state === 'idle');
		assert.strictEqual(runtime.getMetrics('cadence').acceptedBatches, 0);
		const stopped = runtime.stop();
		assert.strictEqual(backend.flushes.at(-1), 'shutdown');
		await stopped;
	});

	it('drives an async-accept backend through a rebuild and publishes ready only after the final barrier', async () => {
		const records = new Map([
			['1:a', { version: 5, value: { title: 'a' } }],
			['1:b', { version: 6, value: { title: 'b' } }],
		]);
		const store = new FakeLogStore(
			new Map([
				[7, [audit({ timestamp: 8, recordId: 'c' }), audit({ timestamp: 9, recordId: 'ignored', tableId: 2 })]],
			]),
			{
				logEntries: new Map([
					['local', [audit({ timestamp: 7, recordId: 'a' }), audit({ timestamp: 8, recordId: 'c' })]],
				]),
			}
		);
		records.set('1:c', { version: 8, value: { title: 'c' } });
		const observed = [];
		const backend = new AsyncBackend('rebuild', {
			applyDelay: 5,
			onReset: () => observed.push(runtime.getReadiness('rebuild').state),
		});
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend, { maxChunkRecords: 1, maxFlushAgeMilliseconds: 10 }));

		await waitFor(() => runtime.getReadiness('rebuild').state === 'ready', { timeout: 5000 });
		assert.deepStrictEqual(observed, ['rebuilding'], 'rebuilding is published before the destructive reset');
		assert.deepStrictEqual(backend.cursor, cursor(9));
		assert.deepStrictEqual([...backend.applied.keys()].sort(), ['a', 'b', 'c']);
		const scanChunks = backend.deliveries.filter((batch) => batch.rebuild);
		assert.strictEqual(scanChunks.length, 4, 'one-record chunks plus the boundary chunk');
		assert.deepStrictEqual(
			scanChunks.map((batch) => batch.through),
			[undefined, undefined, undefined, cursor(7)]
		);
		assert.strictEqual(runtime.getMetrics('rebuild').rebuiltRecords, 3);
		assert.strictEqual(runtime.getMetrics('rebuild').rebuildAttempts, 0);
		await runtime.stop();
	});

	it('does not publish ready while accepted rebuild work is not yet durable', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const backend = new AsyncBackend('slow-barrier', { applyDelay: 30 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 5 }));

		await waitFor(() => backend.deliveries.some((batch) => batch.through));
		assert.strictEqual(runtime.getReadiness('slow-barrier').state, 'rebuilding');
		assert.strictEqual(backend.cursor, undefined);
		await waitFor(() => runtime.getReadiness('slow-barrier').state === 'ready', { timeout: 5000 });
		assert.deepStrictEqual(backend.cursor, cursor(7));
		await runtime.stop();
	});

	it('orders backend shutdown before lock release and fences the old epoch during handoff', async () => {
		const records = new Map([['1:a', { version: 20, value: { title: 'a' } }]]);
		const store = new FakeLogStore(
			new Map([
				[10, [audit({ timestamp: 20, recordId: 'a' })]],
				[20, []],
			])
		);
		let releaseShutdown;
		const backend = new AsyncBackend('handoff', { cursor: cursor(10), applyDelay: 50 });
		backend.shutdown = (epoch) => {
			backend.shutdowns.push(epoch);
			return new Promise((resolve) => (releaseShutdown = resolve));
		};
		const first = runtimeFor(store, records, { idleGraceMilliseconds: 1000 }).runtime;
		first.register(registration(backend));
		await waitFor(() => backend.deliveries.length === 1);
		const firstEpoch = backend.deliveries[0].ownerEpoch;
		assert.strictEqual(backend.host.isOwnerEpoch(firstEpoch), true);

		const stopped = first.stop();
		await waitFor(() => backend.shutdowns.length === 1);
		assert.strictEqual(store.locks.size, 1, 'the lock is held until the backend settles its queue');

		const second = runtimeFor(store, records, { idleGraceMilliseconds: 1000 }).runtime;
		second.register(registration(backend));
		await sleep(20);
		assert.strictEqual(backend.host.isOwnerEpoch(firstEpoch), true, 'the second owner waits for the lock');

		backend.cursor = cursor(20);
		releaseShutdown();
		await stopped;
		backend.shutdown = AsyncBackend.prototype.shutdown;
		await waitFor(() => backend.host.isOwnerEpoch(firstEpoch) === false);
		assert(backend.deliveries.every((batch) => batch.ownerEpoch === firstEpoch || batch.ownerEpoch > firstEpoch));
		await waitFor(() => second.getStatus('handoff').state === 'idle' && store.locks.size === 1);
		await waitFor(() => backend.fenced >= 1, { timeout: 2000 });
		assert.strictEqual(backend.applied.size, 0, 'the old owner apply must not publish into the new generation');
		await second.stop();
	});

	it('waits for a pending flush before releasing ownership', async () => {
		const records = new Map([['1:a', { version: 20, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const backend = new AsyncBackend('flush-pending', { cursor: cursor(10), applyDelay: 30 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 1 }));

		await waitFor(() => backend.pendingFlush !== undefined);
		const stopped = runtime.stop();
		assert.strictEqual(store.locks.size, 1);
		await stopped;
		assert.strictEqual(store.locks.size, 0);
		assert.strictEqual(backend.pendingFlush, undefined);
	});

	it('keeps the lock and rejects stop() when the backend cannot prove its queue is quiescent', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const backend = new AsyncBackend('held', { cursor: cursor(10) });
		backend.shutdown = () => Promise.reject(new Error('native queue did not drain'));
		const { runtime } = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend));
		await waitFor(() => store.locks.size === 1 && runtime.getStatus('held').state === 'idle');

		await assert.rejects(runtime.stop(), /native queue did not drain/);
		assert.strictEqual(store.locks.size, 1);
		const shared = readDerivedIndexReadiness(store, 'held');
		assert.strictEqual(shared.state, 'unavailable');
		assert.strictEqual(shared.reason, 'backend shutdown failed; runner lock held', 'the backend message stays local');
	});

	it('revives an index whose lock was held by a failed shutdown once the backend can settle', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const backend = new AsyncBackend('held-revive', { cursor: cursor(7), applyDelay: 2 });
		let settle = false;
		backend.shutdown = async (epoch) => {
			backend.shutdowns.push(epoch);
			if (!settle) throw new Error('native queue did not drain');
		};
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 5 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => runtime.getStatus('held-revive').state === 'unavailable');
		assert.strictEqual(store.locks.size, 1);

		settle = true;
		assert.strictEqual(runtime.requestRebuild('held-revive'), true);
		await waitFor(() => runtime.getReadiness('held-revive').state === 'ready', { timeout: 5000 });
		assert.strictEqual(backend.resets.length, 1);
		const heldEpoch = backend.shutdowns[0];
		assert.deepStrictEqual(
			backend.shutdowns.slice(0, 2),
			[heldEpoch, heldEpoch],
			'the held epoch is quiesced again first'
		);
		assert(backend.resets[0] > heldEpoch, 'reset runs under a successor epoch only after the held one settled');
		await runtime.stop();
		assert.strictEqual(store.locks.size, 0);
	});

	it('returns one cleanup promise for repeated stop() and waits for every backend', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const failing = new AsyncBackend('cleanup-failing', { cursor: cursor(10) });
		failing.shutdown = () => Promise.reject(new Error('native queue did not drain'));
		const draining = new AsyncBackend('cleanup-draining', { cursor: cursor(10) });
		let releaseDrain;
		draining.shutdown = () => new Promise((resolve) => (releaseDrain = resolve));
		const { runtime } = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 });
		runtime.register(registration(failing));
		runtime.register(registration(draining));
		await waitFor(() => store.locks.size === 2);

		const first = runtime.stop();
		const second = runtime.stop();
		assert.strictEqual(second, first);
		await sleep(20);
		assert.strictEqual(store.locks.size, 2, 'stop() must not settle while a backend is still draining');
		releaseDrain();
		await assert.rejects(first, /native queue did not drain/);
		assert.strictEqual(store.locks.size, 1, 'the drained backend released; the failed one keeps its lock');
		await assert.rejects(runtime.stop(), /native queue did not drain/);
	});

	it('keeps a failed unregister shutdown in the runtime-wide stop() wait', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const failing = new AsyncBackend('unregister-failing', { cursor: cursor(10) });
		failing.shutdown = () => Promise.reject(new Error('native queue did not drain'));
		const { runtime } = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 });
		const unregister = runtime.register(registration(failing));
		await waitFor(() => store.locks.size === 1);
		await assert.rejects(unregister(), /native queue did not drain/);
		await assert.rejects(runtime.stop(), /native queue did not drain/);
		assert.strictEqual(store.locks.size, 1);
	});

	it('delivers a peer rebuild request to an owner parked on backend backpressure', async () => {
		const records = new Map([['1:a', { version: 20, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]), {
			logEntries: new Map([['local', [audit({ timestamp: 10, recordId: 'a' })]]]),
		});
		const ownerBackend = new AsyncBackend('parked', { cursor: cursor(10), capacity: 0, applyDelay: 2 });
		const peerBackend = new AsyncBackend('parked', { cursor: cursor(10) });
		const owner = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		const peer = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		owner.register(registration(ownerBackend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => owner.getStatus('parked').state === 'deferred');
		peer.register(registration(peerBackend));
		ownerBackend.capacity = Infinity;
		assert.strictEqual(peer.requestRebuild('parked'), true);
		await waitFor(() => ownerBackend.resets.length === 1, { timeout: 5000 });
		await waitFor(() => owner.getReadiness('parked').state === 'ready', { timeout: 5000 });
		await peer.stop();
		await owner.stop();
	});

	it('does not run one more attempt for a budget a previous owner already exhausted', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const words = new Int32Array(store.getUserSharedBuffer('derived-index:inherited:readiness', new ArrayBuffer(512)));
		Atomics.store(words, 1, 2);
		Atomics.store(words, 3, 2);
		const backend = new AsyncBackend('inherited');
		const { runtime } = runtimeFor(store, records);
		runtime.register(registration(backend, { maxRebuildAttempts: 2 }));
		await waitFor(() => runtime.getStatus('inherited')?.state === 'unavailable');
		assert.strictEqual(backend.resets.length, 0);
		await runtime.stop();
	});

	it('parks a backend that cannot rebuild when a previous owner condemned the generation', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const words = new Int32Array(store.getUserSharedBuffer('derived-index:condemned:readiness', new ArrayBuffer(512)));
		Atomics.store(words, 1, 3);
		const backend = new SyncBackend('condemned', cursor(10));
		const { runtime } = runtimeFor(store, new Map(), { scanRecords: undefined });
		runtime.register(registration(backend));
		await waitFor(() => runtime.getStatus('condemned')?.state === 'needs-rebuild');
		assert.strictEqual(backend.deliveries.length, 0);
		await waitFor(() => store.locks.size === 0);
		await runtime.stop();
	});

	it('waits for an in-flight reset before quiescing and releasing on stop()', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const events = [];
		let finishReset;
		const backend = new AsyncBackend('reset-race', { applyDelay: 2 });
		backend.reset = (epoch) => {
			backend.resets.push(epoch);
			events.push('reset-start');
			return new Promise((resolve) => (finishReset = () => (events.push('reset-end'), resolve())));
		};
		backend.shutdown = async (epoch) => {
			events.push(`shutdown-${epoch === backend.resets[0] ? 'new' : 'old'}`);
		};
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend));
		await waitFor(() => events.includes('reset-start'));
		const stopped = runtime.stop();
		await sleep(10);
		assert.strictEqual(store.locks.size, 1, 'the lock is held while the reset is in flight');
		assert.deepStrictEqual(events, ['shutdown-old', 'reset-start']);
		finishReset();
		await stopped;
		assert.deepStrictEqual(events, ['shutdown-old', 'reset-start', 'reset-end', 'shutdown-new']);
		assert.strictEqual(store.locks.size, 0);
	});

	it('lets requestRebuild release a lock held by a stopped runner whose shutdown failed', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const stuck = new AsyncBackend('held-stopped', { cursor: cursor(10) });
		let settle = false;
		stuck.shutdown = async () => {
			if (!settle) throw new Error('native queue did not drain');
		};
		const { runtime } = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 });
		const unregister = runtime.register(registration(stuck));
		await waitFor(() => store.locks.size === 1);
		await assert.rejects(unregister(), /native queue did not drain/);

		const replacement = new AsyncBackend('held-stopped', { cursor: cursor(10), applyDelay: 2 });
		runtime.register(registration(replacement, { maxFlushAgeMilliseconds: 5 }));
		await sleep(20);
		assert.strictEqual(
			runtime.getStatus('held-stopped').ownerEpoch,
			undefined,
			'the replacement waits on the held lock'
		);
		settle = true;
		assert.strictEqual(runtime.requestRebuild('held-stopped'), true);
		await waitFor(
			() =>
				runtime.getStatus('held-stopped').ownerEpoch !== undefined &&
				runtime.getStatus('held-stopped').state === 'idle',
			{ timeout: 5000 }
		);
		assert.strictEqual(replacement.resets.length, 1, 'the request also rebuilds under the new owner');
		await runtime.stop();
		assert.strictEqual(store.locks.size, 0);
	});

	it('clears a latched unavailable status once a peer has revived the index', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const words = new Int32Array(store.getUserSharedBuffer('derived-index:latched:readiness', new ArrayBuffer(512)));
		Atomics.store(words, 1, 4);
		const latched = runtimeFor(store, records, { idleGraceMilliseconds: 5 }).runtime;
		latched.register(registration(new AsyncBackend('latched', { applyDelay: 2 })));
		await waitFor(() => latched.getStatus('latched').state === 'unavailable');
		await waitFor(() => store.locks.size === 0);

		const reviver = runtimeFor(store, records, { idleGraceMilliseconds: 5 }).runtime;
		const reviverBackend = new AsyncBackend('latched', { applyDelay: 2 });
		reviver.register(registration(reviverBackend, { maxFlushAgeMilliseconds: 5 }));
		assert.strictEqual(reviver.requestRebuild('latched'), true);
		await waitFor(() => reviver.getReadiness('latched').state === 'ready', { timeout: 5000 });
		await reviver.stop();

		store.rootStore.emit('committed');
		await waitFor(() => latched.getStatus('latched').state !== 'unavailable' && store.locks.size === 1, {
			timeout: 5000,
		});
		await latched.stop();
	});

	it('hands the reload-suppression bound to the next owner through shared memory', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const reload = { ...audit({ timestamp: 8, type: 'reload' }), recordId: null };
		const store = new FakeLogStore(
			new Map([
				[7, [reload, audit({ timestamp: 9, recordId: 'a' })]],
				[9, []],
			]),
			{ logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' }), reload]]]) }
		);
		const first = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		const firstBackend = new AsyncBackend('reload-handoff', { cursor: cursor(7), applyDelay: 2, capacity: 0 });
		first.register(registration(firstBackend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => firstBackend.resets.length === 1 && firstBackend.deliveries.length >= 1);
		// The boundary is captured; the first owner leaves before its replay passes the marker.
		firstBackend.capacity = Infinity;
		await first.stop();

		const second = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		const secondBackend = new AsyncBackend('reload-handoff', { cursor: cursor(7), applyDelay: 2 });
		second.register(registration(secondBackend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => second.getReadiness('reload-handoff').state === 'ready', { timeout: 5000 });
		assert.strictEqual(secondBackend.resets.length, 1, 'one rebuild for the condemned generation, none for the marker');
		assert.deepStrictEqual(secondBackend.cursor, cursor(9));
		await second.stop();
	});

	it('keeps tables registered until the backend has settled its shutdown', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const backend = new AsyncBackend('registered-until-settled', { cursor: cursor(10) });
		let releaseShutdown;
		backend.shutdown = () => new Promise((resolve) => (releaseShutdown = resolve));
		const { runtime } = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 });
		const unregister = runtime.register(registration(backend));
		await waitFor(() => store.locks.size === 1);

		const unregistered = unregister();
		assert.strictEqual(unregister(), unregistered);
		await sleep(10);
		assert.strictEqual(
			hasDerivedIndexRegistration(store, 1),
			true,
			'an eviction during the drain must still write its marker'
		);
		releaseShutdown();
		await unregistered;
		assert.strictEqual(hasDerivedIndexRegistration(store, 1), false);
		await runtime.stop();
	});

	it('never publishes ready between a fault found mid-drain and the destructive reset', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, [audit({ timestamp: 8, recordId: 'a' })]]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		let breakOnce = true;
		store.onNext = () => {
			if (breakOnce) {
				breakOnce = false;
				store.lastIterable.corruptFrameStop.breaks = 1;
			}
		};
		const originalGetRange = store.getRange.bind(store);
		store.getRange = (options) => (store.lastIterable = originalGetRange(options));
		const readinessLog = [];
		const backend = new AsyncBackend('mid-drain', {
			cursor: cursor(7),
			applyDelay: 2,
			onReset: () => readinessLog.push(runtime.getReadiness('mid-drain').state),
		});
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		const seen = new Set();
		const probe = setInterval(() => seen.add(runtime.getReadiness('mid-drain').state), 0);
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 5 }));

		await waitFor(() => backend.resets.length === 1);
		clearInterval(probe);
		assert.deepStrictEqual(readinessLog, ['rebuilding']);
		assert.strictEqual(seen.has('ready') && backend.resets.length === 1 && seen.size === 1, false);
		await waitFor(() => runtime.getReadiness('mid-drain').state === 'ready', { timeout: 5000 });
		assert.strictEqual(runtime.getMetrics('mid-drain').rebuildAttempts, 0);
		await runtime.stop();
	});

	it('does not leave a rebuild request dangling when one arrives during a rebuild', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(
			new Map([
				[7, []],
				[8, []],
			]),
			{ logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]) }
		);
		const backend = new AsyncBackend('dangling', { applyDelay: 2, capacity: 0 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 5 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => runtime.getStatus('dangling').state === 'rebuilding' && backend.deliveries.length >= 1);
		assert.strictEqual(runtime.requestRebuild('dangling'), true);
		backend.capacity = Infinity;
		backend.stateChange('changed');
		await waitFor(() => runtime.getReadiness('dangling').state === 'ready', { timeout: 5000 });
		await waitFor(() => store.locks.size === 0);

		const releasedEpoch = runtime.getStatus('dangling').ownerEpoch;
		backend.cursor = cursor(8);
		store.rootStore.emit('committed');
		await waitFor(
			() => runtime.getStatus('dangling').ownerEpoch > releasedEpoch && runtime.getStatus('dangling').state === 'idle'
		);
		assert.strictEqual(backend.resets.length, 1, 'a healthy re-acquisition must not rebuild again');
		await runtime.stop();
	});

	it('routes a rebuild request from a non-owning worker to a busy owner', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const ownerBackend = new AsyncBackend('routed', { cursor: cursor(7), applyDelay: 2 });
		const peerBackend = new AsyncBackend('routed', { cursor: cursor(7) });
		const owner = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		const peer = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		owner.register(registration(ownerBackend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => owner.getStatus('routed').state === 'idle' && store.locks.size === 1);
		peer.register(registration(peerBackend));

		assert.strictEqual(peer.requestRebuild('routed'), true);
		store.rootStore.emit('committed');
		await waitFor(() => ownerBackend.resets.length === 1, { timeout: 5000 });
		await waitFor(() => owner.getReadiness('routed').state === 'ready', { timeout: 5000 });
		assert.strictEqual(peerBackend.resets.length, 0);
		await peer.stop();
		await owner.stop();
	});

	it('absorbs a peer rebuild request that arrives during a rebuild and never publishes from the peer', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const ownerBackend = new AsyncBackend('absorbed', { applyDelay: 2, capacity: 0 });
		const peerBackend = new AsyncBackend('absorbed');
		const owner = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		const peer = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		owner.register(registration(ownerBackend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => owner.getStatus('absorbed').state === 'rebuilding' && ownerBackend.deliveries.length >= 1);
		peer.register(registration(peerBackend));
		const published = readDerivedIndexReadiness(store, 'absorbed');
		assert.strictEqual(peer.requestRebuild('absorbed'), true);
		assert.deepStrictEqual(
			readDerivedIndexReadiness(store, 'absorbed'),
			published,
			'a non-owner never writes the shared record'
		);

		ownerBackend.capacity = Infinity;
		ownerBackend.stateChange('changed');
		await waitFor(() => owner.getReadiness('absorbed').state === 'ready', { timeout: 5000 });
		await sleep(30);
		assert.strictEqual(ownerBackend.resets.length, 1, 'the in-flight rebuild absorbs the request');
		assert.strictEqual(owner.getReadiness('absorbed').state, 'ready');
		await peer.stop();
		await owner.stop();
	});

	it('ignores a superseded flush rejection and keeps asking a backend that coalesced a request', async () => {
		const records = new Map([['1:a', { version: 20, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const backend = new AsyncBackend('flush-liveness', { cursor: cursor(10) });
		let rejectSuperseded;
		let dropped = 0;
		const realFlush = backend.flush.bind(backend);
		backend.flush = (reason) => {
			if (dropped++ === 0) {
				backend.flushes.push(reason);
				return new Promise((_resolve, reject) => (rejectSuperseded = reject));
			}
			return realFlush(reason);
		};
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 10 }));

		await waitFor(() => backend.cursor.logs.local === 20 && runtime.getStatus('flush-liveness').state === 'idle');
		assert(backend.flushes.length >= 2, 'the age timer re-arms while accepted work is not durable');
		await runtime.stop();
		rejectSuperseded(new Error('cancelled by shutdown'));
		await sleep(10);
		assert.notStrictEqual(readDerivedIndexReadiness(store, 'flush-liveness').state, 'needs-rebuild');
	});

	it('rebuilds across several physical logs, omitting an empty log that still retains its beginning', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logNames: ['local', 'remote'],
			logEntries: new Map([
				['local', [audit({ timestamp: 7, recordId: 'a' })]],
				['remote', []],
			]),
		});
		const backend = new AsyncBackend('multi-log', { applyDelay: 2 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 5 }));

		await waitFor(() => runtime.getReadiness('multi-log').state === 'ready', { timeout: 5000 });
		assert.deepStrictEqual(backend.cursor, { format: 1, logs: { local: 7 } });
		assert.strictEqual(runtime.getMetrics('multi-log').rebuildAttempts, 0);
		await runtime.stop();
	});

	it('does not spend rebuild attempts on reload markers the scan already covered', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const reloads = [8, 9, 10].map((timestamp) => ({ ...audit({ timestamp, type: 'reload' }), recordId: null }));
		const store = new FakeLogStore(
			new Map([
				[7, [...reloads, audit({ timestamp: 11, recordId: 'a' })]],
				[11, []],
			]),
			{ logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' }), ...reloads]]]) }
		);
		const backend = new AsyncBackend('reloads', { cursor: cursor(7), applyDelay: 2 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(
			registration(backend, { maxRebuildAttempts: 2, rebuildBackoffMilliseconds: 5, maxFlushAgeMilliseconds: 5 })
		);

		await waitFor(() => runtime.getReadiness('reloads').state === 'ready', { timeout: 5000 });
		assert.strictEqual(backend.resets.length, 1);
		assert.deepStrictEqual(backend.cursor, cursor(11));
		await runtime.stop();
	});

	it('splits resolution of the first collected transaction at the chunk byte bound', async () => {
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						{ ...audit({ timestamp: 20, recordId: 'a' }), endTxn: false },
						{ ...audit({ timestamp: 20, recordId: 'b' }), endTxn: false },
						audit({ timestamp: 20, recordId: 'c' }),
					],
				],
			])
		);
		const records = new Map(['a', 'b', 'c'].map((id) => [`1:${id}`, { version: 20, value: { title: id }, size: 100 }]));
		const backend = new SyncBackend('split', cursor(10));
		const { runtime } = runtimeFor(store, records, { maxChunkBytes: 150 });
		runtime.register(registration(backend));

		await waitFor(() => backend.cursor.logs.local === 20);
		assert.deepStrictEqual(
			backend.deliveries.map((batch) => [
				batch.records.map((record) => record.recordId).join(''),
				batch.through.logs.local,
				batch.transactions[0].partial,
			]),
			[
				['ab', 10, true],
				['c', 20, undefined],
			]
		);
		await runtime.stop();
	});

	it('fails closed on a rejected flush request without an unhandled rejection', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const backend = new AsyncBackend('flush-reject', { cursor: cursor(10) });
		backend.flush = () => Promise.reject(new Error('msync failed'));
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]), {
			scanRecords: undefined,
		});
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 1 }));

		await waitFor(() => runtime.getStatus('flush-reject')?.state === 'needs-rebuild');
		assert.match(runtime.getStatus('flush-reject').reason, /backend flush request rejected/);
		const shared = runtime.getReadiness('flush-reject');
		assert.strictEqual(shared.state, 'needs-rebuild');
		assert.strictEqual(
			shared.reason,
			'backend flush request rejected',
			'the backend message never reaches the shared record'
		);
		await runtime.stop();
	});

	it('exposes the owner-published readiness to a non-owning worker', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const backend = new AsyncBackend('shared-readiness', { applyDelay: 20 });
		const owner = runtimeFor(store, records, { idleGraceMilliseconds: 1000 }).runtime;
		const peer = new DerivedIndexRuntime(store, () => undefined);
		assert.strictEqual(peer.getReadiness('shared-readiness').state, 'unknown');
		owner.register(registration(backend, { maxFlushAgeMilliseconds: 10 }));

		await waitFor(() => peer.getReadiness('shared-readiness').state === 'rebuilding');
		assert.strictEqual(readDerivedIndexReadiness(store, 'shared-readiness').state, 'rebuilding');
		await waitFor(() => peer.getReadiness('shared-readiness').state === 'ready', { timeout: 5000 });
		assert.strictEqual(peer.getReadiness('shared-readiness').ownerEpoch, backend.deliveries.at(-1).ownerEpoch);
		await owner.stop();
	});

	it('cancels the rebuild-request notification when a runner is unregistered', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const { runtime } = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 });
		for (let cycle = 0; cycle < 3; cycle++) {
			const unregister = runtime.register(registration(new SyncBackend('cycled', cursor(10))));
			await waitFor(() => runtime.getStatus('cycled').state === 'idle' && store.locks.size === 1);
			await unregister();
		}
		assert.strictEqual(store.sharedBuffers.get('derived-index:cycled:readiness').callbacks.size, 0);
		await runtime.stop();
	});

	it('cancels only its own subscription when two runners share a readiness buffer', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const first = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 }).runtime;
		const second = runtimeFor(store, new Map(), { idleGraceMilliseconds: 1000 }).runtime;
		first.register(registration(new SyncBackend('shared-buffer', cursor(10))));
		second.register(registration(new SyncBackend('shared-buffer', cursor(10))));
		const callbacks = store.sharedBuffers.get('derived-index:shared-buffer:readiness').callbacks;
		assert.strictEqual(callbacks.size, 2);
		await first.stop();
		assert.strictEqual(callbacks.size, 1);
		await second.stop();
		assert.strictEqual(callbacks.size, 0);
	});

	it('trips the opt-in lag policy on every worker while the index is behind and clears it with hysteresis', async () => {
		const records = new Map(['a', 'b', 'c'].map((id) => [`1:${id}`, { version: 1, value: { title: id } }]));
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						audit({ timestamp: 1_000, recordId: 'a' }),
						audit({ timestamp: 2_000, recordId: 'b' }),
						audit({ timestamp: 3_000, recordId: 'c' }),
					],
				],
			])
		);
		const backend = new SyncBackend('lagging', cursor(10), () => DERIVED_INDEX_ACCEPTED);
		const owner = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		const peer = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 }).runtime;
		assert.strictEqual(derivedIndexWriteRejection(store, 1), undefined, 'nothing registered: writes admitted');
		owner.register(registration(backend, { maxLagMilliseconds: 500, maxFlushAgeMilliseconds: 5 }));
		peer.register(registration(new SyncBackend('lagging', cursor(10)), { maxLagMilliseconds: 500 }));

		await waitFor(() => derivedIndexWriteRejection(store, 1) !== undefined);
		assert.match(derivedIndexWriteRejection(store, 1), /'lagging' is more than 500 ms behind/);
		assert.match(derivedIndexWriteRejection(store, 2) ?? '', /^$/, 'tables without a derived index are never gated');

		backend.cursor = cursor(3_000);
		backend.stateChange();
		await waitFor(() => derivedIndexWriteRejection(store, 1) === undefined, { timeout: 5000 });
		await owner.stop();
		await peer.stop();
		assert.strictEqual(derivedIndexWriteRejection(store, 1), undefined, 'unregistering removes the admission check');
	});

	it('publishes ready on the first durable advance even when the runner never idles', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, [audit({ timestamp: 8, recordId: 'a' })]]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
			live: true,
		});
		let next = 9;
		store.onNext = (entry) => {
			// Keep the log ahead of the runner so no idle pass ever happens.
			if (entry === undefined && next < 2000)
				store.entriesByCursor.get(7).push(audit({ timestamp: next++, recordId: 'a' }));
		};
		const backend = new AsyncBackend('never-idle', { applyDelay: 1 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 5, maxTransactionsPerTurn: 1 }));
		await waitFor(() => runtime.getReadiness('never-idle').state === 'ready', { timeout: 5000 });
		assert.notStrictEqual(runtime.getStatus('never-idle').state, 'idle');
		assert.strictEqual(runtime.getMetrics('never-idle').rebuildAttempts, 0);
		await runtime.stop();
	});

	it('skips and counts every record of a chunk the projection rejects instead of condemning the index', async () => {
		const ids = Array.from({ length: 40 }, (_, i) => `r${i}`);
		const store = new FakeLogStore(new Map([[10, ids.map((id, i) => audit({ timestamp: 20 + i, recordId: id }))]]));
		const backend = new SyncBackend('all-rejected', cursor(10));
		const { runtime } = runtimeFor(store, new Map(ids.map((id) => [`1:${id}`, { version: 1, value: { title: 1 } }])), {
			scanRecords: undefined,
		});
		runtime.register({
			backend,
			projections: new Map([
				[
					1,
					() => {
						throw new ClientError('title must be a string', 400);
					},
				],
			]),
		});
		await waitFor(() => backend.deliveries.length > 0);
		const states = backend.deliveries.flatMap((batch) => batch.records.map((record) => record.state));
		assert.strictEqual(states.length, 40);
		assert(states.every((state) => state.kind === 'unindexable' && /\(400\)$/.test(state.reason)));
		assert.strictEqual(runtime.getMetrics('all-rejected').unindexableRecords, 40);
		await waitFor(() => backend.cursor.logs.local === 59);
		assert.strictEqual(runtime.getStatus('all-rejected').state, 'idle');
		assert.strictEqual(runtime.getMetrics('all-rejected').rebuildAttempts, 0);
		await runtime.stop();
	});

	it('admits writes again when the index becomes unavailable with no owner left to catch up', async () => {
		const records = new Map([['1:a', { version: 8, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, [audit({ timestamp: 8, recordId: 'a' })]]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const backend = new AsyncBackend('shed-then-dead', { cursor: cursor(7) });
		// Accept but never make anything durable, so catch-up is never proven and the policy trips.
		backend.flush = () => {};
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 });
		runtime.register(
			registration(backend, {
				maxLagMilliseconds: 20,
				maxFlushAgeMilliseconds: 5,
				maxRebuildAttempts: 1,
				rebuildBackoffMilliseconds: 5,
			})
		);
		await waitFor(() => derivedIndexWriteRejection(store, 1) !== undefined, { timeout: 5000 });
		backend.applyRecord = () => {
			throw new Error('native capacity exhausted');
		};
		backend.stateChange('failed');
		await waitFor(() => runtime.getStatus('shed-then-dead')?.state === 'unavailable', { timeout: 5000 });
		assert.strictEqual(derivedIndexWriteRejection(store, 1), undefined, 'an unavailable index must not shed forever');
		await runtime.stop();
	});

	it('arms one retry timer while tryLock keeps throwing under a commit stream', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		let attempts = 0;
		const tryLock = store.tryLock.bind(store);
		store.tryLock = (key, onUnlocked) => {
			if (attempts++ < 2) throw new Error('lock table busy');
			return tryLock(key, onUnlocked);
		};
		const backend = new SyncBackend('lock-storm', cursor(10));
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend, { rebuildBackoffMilliseconds: 200 }));
		await waitFor(() => attempts === 1);
		for (let i = 0; i < 20; i++) {
			store.rootStore.emit('committed');
			await sleep(1);
		}
		assert.strictEqual(attempts, 1, 'commit wakes do not re-enter tryLock while the retry timer is armed');
		await waitFor(() => backend.deliveries.length === 1, { timeout: 5000 });
		assert.strictEqual(attempts, 3, 'one attempt per timer firing');
		await runtime.stop();
	});

	it('rebuilds after a restart when a condemnation was recorded before the reset could invalidate the cursor', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const logEntries = new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]);
		const first = new FakeLogStore(new Map([[7, []]]), { logEntries });
		const condemned = new AsyncBackend('condemn-restart', { cursor: cursor(7), applyDelay: 1 });
		condemned.reset = undefined;
		const before = runtimeFor(first, records, { idleGraceMilliseconds: 60_000 }).runtime;
		before.register(registration(condemned, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => before.getReadiness('condemn-restart').state === 'ready');
		condemned.stateChange('failed');
		await waitFor(() => before.getStatus('condemn-restart')?.state === 'needs-rebuild');
		assert.strictEqual(first.markers.size, 1, 'the condemnation is written to the root store');
		await before.stop();

		// "Restart": fresh shared buffers (readiness reads unknown), same root store markers and log.
		const restarted = new FakeLogStore(new Map([[7, []]]), { logEntries, markers: first.markers });
		const rebuilt = new AsyncBackend('condemn-restart', { cursor: cursor(7), applyDelay: 1 });
		const after = runtimeFor(restarted, records, { idleGraceMilliseconds: 60_000 }).runtime;
		assert.strictEqual(after.getReadiness('condemn-restart').state, 'unknown');
		after.register(registration(rebuilt, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => after.getReadiness('condemn-restart').state === 'ready', { timeout: 5000 });
		assert.strictEqual(rebuilt.resets.length, 1, 'the still-valid cursor is rebuilt, not trusted');
		assert.strictEqual(restarted.markers.size, 0, 'the marker clears at the durable ready');
		await after.stop();

		const again = new FakeLogStore(new Map([[7, []]]), { logEntries, markers: first.markers });
		const trusted = new AsyncBackend('condemn-restart', { cursor: cursor(7), applyDelay: 1 });
		const third = runtimeFor(again, records, { idleGraceMilliseconds: 60_000 }).runtime;
		third.register(registration(trusted, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => third.getReadiness('condemn-restart').state === 'ready', { timeout: 5000 });
		assert.strictEqual(trusted.resets.length, 0, 'a cleared marker lets the cursor be trusted');
		await third.stop();
	});

	it('does not reset the backend when the condemnation marker cannot be persisted', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		store.putSync = () => {
			throw new Error('root store is read-only');
		};
		const backend = new AsyncBackend('marker-fails', { cursor: cursor(7), applyDelay: 1 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => runtime.getReadiness('marker-fails').state === 'ready');
		backend.stateChange('failed');
		await waitFor(() => runtime.getStatus('marker-fails')?.state === 'unavailable');
		assert.match(runtime.getStatus('marker-fails').reason, /condemnation could not be persisted/);
		assert.strictEqual(backend.resets.length, 0, 'no destructive reset without a durable condemnation');
		assert.strictEqual(runtime.getReadiness('marker-fails').state, 'unavailable');
		await runtime.stop();
	});

	it('retries the lock instead of parking when tryLock throws once', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		let attempts = 0;
		const tryLock = store.tryLock.bind(store);
		store.tryLock = (key, onUnlocked) => {
			if (attempts++ === 0) throw new Error('lock table busy');
			return tryLock(key, onUnlocked);
		};
		const backend = new SyncBackend('lock-throw', cursor(10));
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend, { rebuildBackoffMilliseconds: 5 }));
		await waitFor(() => backend.deliveries.length === 1);
		assert.strictEqual(attempts, 2);
		await runtime.stop();
	});

	it('completes a rebuild whose scan the projection rejects entirely, counting the records', async () => {
		const ids = Array.from({ length: 5 }, (_, i) => `r${i}`);
		const records = new Map(ids.map((id) => [`1:${id}`, { version: 1, value: { title: 1 } }]));
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'r0' })]]]),
		});
		const backend = new AsyncBackend('scan-rejected', { applyDelay: 1 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 });
		runtime.register({
			backend,
			projections: new Map([
				[
					1,
					() => {
						throw new ClientError('title must be a string', 400);
					},
				],
			]),
			options: { maxChunkRecords: 2, maxRebuildAttempts: 1, maxFlushAgeMilliseconds: 5 },
		});
		await waitFor(() => runtime.getReadiness('scan-rejected').state === 'ready', { timeout: 5000 });
		assert.strictEqual(runtime.getMetrics('scan-rejected').unindexableRecords, 5);
		assert.strictEqual(runtime.getMetrics('scan-rejected').rebuiltRecords, 5);
		assert.strictEqual(runtime.getMetrics('scan-rejected').rebuildAttempts, 0);
		assert.strictEqual(backend.applied.size, 0);
		await runtime.stop();
	});

	it('yields the event loop through a long run of tombstones during a rebuild scan', async () => {
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'kept' })]]]),
		});
		const backend = new AsyncBackend('tombstone-scan', { applyDelay: 1 });
		let clock = 0;
		let yielded = false;
		let yieldedBefore = -1;
		const { runtime } = runtimeFor(store, new Map(), {
			idleGraceMilliseconds: 60_000,
			now: () => clock,
			scanRecords: function* () {
				setImmediate(() => (yielded = true));
				for (let i = 0; i < 2000; i++) {
					if (yielded && yieldedBefore < 0) yieldedBefore = i;
					clock += 1;
					yield { recordId: `dead${i}`, version: 1, value: null };
				}
				yield { recordId: 'kept', version: 2, value: { title: 'kept' } };
			},
		});
		runtime.register(registration(backend, { maxMillisecondsPerTurn: 5, maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => runtime.getReadiness('tombstone-scan').state === 'ready', { timeout: 5000 });
		assert(yieldedBefore >= 0 && yieldedBefore < 2000, `scan held the event loop through ${yieldedBefore} tombstones`);
		assert.strictEqual(runtime.getMetrics('tombstone-scan').rebuiltRecords, 1);
		assert.deepStrictEqual([...backend.applied.keys()], ['kept']);
		const scanChunks = backend.deliveries.filter((batch) => batch.rebuild);
		assert(
			scanChunks.every((batch) => batch.records.length > 0 || batch.through),
			'no empty chunk before the boundary'
		);
		assert.deepStrictEqual(scanChunks.at(-1).through, cursor(7));
		const lookups = store.bufferLookups;
		await runtime.stop();
		assert.strictEqual(store.bufferLookups, lookups, 'shared-memory views are fetched once per runner');
	});

	it('does not trip the lag policy for a caught-up owner that idles past the budget', async () => {
		const records = new Map([['1:a', { version: 1, value: { title: 'a' } }]]);
		const entries = [];
		const store = new FakeLogStore(new Map([[10, entries]]), { live: true });
		const backend = new SyncBackend('idle-caught-up', cursor(10), () => DERIVED_INDEX_ACCEPTED);
		let clock = 1_000_000;
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 60_000, now: () => clock });
		runtime.register(registration(backend, { maxLagMilliseconds: 400, maxFlushAgeMilliseconds: 5 }));
		await waitFor(() => runtime.getStatus('idle-caught-up')?.state === 'idle');
		clock += 5_000;
		await sleep(350);
		assert.strictEqual(derivedIndexWriteRejection(store, 1), undefined, 'a caught-up idle owner has no lag');
		entries.push(audit({ timestamp: 11, recordId: 'a' }));
		backend.deliverImpl = () => DERIVED_INDEX_DEFERRED;
		store.rootStore.emit('committed');
		await waitFor(() => runtime.getStatus('idle-caught-up').state === 'deferred');
		clock += 1_000;
		await waitFor(() => derivedIndexWriteRejection(store, 1) !== undefined, { timeout: 5000 });
		await runtime.stop();
	});

	it('keeps writes admitted when the registration sets no lag policy', async () => {
		const records = new Map([['1:a', { version: 1, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 5_000_000, recordId: 'a' })]]]));
		const backend = new SyncBackend('unbounded-lag', cursor(10), () => DERIVED_INDEX_ACCEPTED);
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 });
		runtime.register(registration(backend));
		await waitFor(() => backend.deliveries.length === 1);
		await sleep(10);
		assert.strictEqual(derivedIndexWriteRejection(store, 1), undefined);
		await runtime.stop();
	});

	it('rejects an asynchronous backend that lacks the fence, barrier or quiescence hooks', () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const { runtime } = runtimeFor(store, new Map());
		const incomplete = new SyncBackend('incomplete-queued', cursor(10));
		incomplete.asynchronous = true;
		assert.throws(() => runtime.register(registration(incomplete)), /must implement attach\(\)/);
		assert.strictEqual(runtime.getStatus('incomplete-queued'), undefined);
	});

	it('fails closed when a backend that declared no asynchronous effects returns a promise from flush', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const backend = new SyncBackend('undeclared-async', cursor(10), () => DERIVED_INDEX_ACCEPTED);
		backend.flush = () => Promise.resolve();
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]), {
			scanRecords: undefined,
		});
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 1 }));
		await waitFor(() => runtime.getStatus('undeclared-async')?.state === 'needs-rebuild');
		assert.match(runtime.getStatus('undeclared-async').reason, /declared no asynchronous effects/);
		await runtime.stop();
	});

	it('holds the lock under an undeclared asynchronous flush until its promise settles', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const backend = new SyncBackend('undeclared-pending', cursor(10), () => DERIVED_INDEX_ACCEPTED);
		const settlers = [];
		backend.flush = () => new Promise((resolve) => settlers.push(resolve));
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]), {
			scanRecords: undefined,
		});
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 1 }));
		await waitFor(() => runtime.getStatus('undeclared-pending')?.state === 'needs-rebuild');
		await sleep(20);
		assert(store.locks.has('derived-index:undeclared-pending:runner'), 'the lock is held while the promise is pending');
		const stopped = runtime.stop();
		await sleep(20);
		assert(store.locks.has('derived-index:undeclared-pending:runner'), 'stop() waits for the promise too');
		for (const settle of settlers) settle();
		await stopped;
		assert(!store.locks.has('derived-index:undeclared-pending:runner'));
	});

	it('waits for the shutdown flush of an asynchronous backend before releasing the lock', async () => {
		const records = new Map([['1:a', { version: 20, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const backend = new AsyncBackend('flush-before-unlock', { cursor: cursor(10), applyDelay: 2 });
		let finishFlush;
		const events = [];
		backend.flush = (reason) => {
			backend.flushes.push(reason);
			if (reason !== 'shutdown') return;
			return new Promise((resolve) => (finishFlush = () => (events.push('flush-done'), resolve())));
		};
		backend.shutdown = async () => {
			events.push('shutdown');
		};
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 60_000 });
		runtime.register(registration(backend, { maxFlushAgeMilliseconds: 1000 }));
		await waitFor(() => backend.deliveries.length === 1);
		const stopped = runtime.stop();
		await sleep(10);
		assert.deepStrictEqual(events, []);
		assert.strictEqual(store.locks.size, 1);
		finishFlush();
		await stopped;
		assert.deepStrictEqual(events, ['flush-done', 'shutdown']);
		assert.strictEqual(store.locks.size, 0);
	});

	it('leaves no readiness subscription or table admission behind when registration fails', () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const { runtime } = runtimeFor(store, new Map());
		const throwing = new SyncBackend('partial-registration', cursor(10));
		throwing.onStateChange = () => {
			throw new Error('subscribe failed');
		};
		assert.throws(() => runtime.register(registration(throwing, { maxLagMilliseconds: 50 })), /subscribe failed/);
		assert.strictEqual(store.sharedBuffers.get('derived-index:partial-registration:readiness').callbacks.size, 0);
		assert.strictEqual(hasDerivedIndexRegistration(store, 1), false);
	});

	it('reads a publication abandoned mid-write as unknown instead of spinning', () => {
		const store = new FakeLogStore(new Map());
		const words = new Int32Array(store.getUserSharedBuffer('derived-index:abandoned:readiness', new ArrayBuffer(512)));
		Atomics.store(words, 0, 3);
		Atomics.store(words, 1, 1);
		assert.strictEqual(readDerivedIndexReadiness(store, 'abandoned').state, 'unknown');
	});

	it('skips and counts a record the projection rejects instead of rebuilding', async () => {
		const store = new FakeLogStore(
			new Map([[10, [audit({ timestamp: 20, recordId: 'bad' }), audit({ timestamp: 30, recordId: 'good' })]]])
		);
		const backend = new SyncBackend('unindexable', cursor(10));
		const { runtime } = runtimeFor(
			store,
			new Map([
				['1:bad', { version: 20, value: { title: 7 } }],
				['1:good', { version: 30, value: { title: 'good' } }],
			])
		);
		runtime.register({
			backend,
			projections: new Map([
				[
					1,
					(record) => {
						if (typeof record.title !== 'string') throw new ClientError('title must be a string', 400);
						return { title: record.title };
					},
				],
			]),
		});

		await waitFor(() => backend.deliveries.length === 1);
		assert.deepStrictEqual(backend.deliveries[0].records[0].state, {
			kind: 'unindexable',
			version: 20,
			reason: 'Error (400)',
		});
		assert.strictEqual(backend.deliveries[0].records[1].state.kind, 'record');
		assert.strictEqual(runtime.getMetrics('unindexable').unindexableRecords, 1);
		assert.deepStrictEqual(backend.cursor, cursor(30));
		await runtime.stop();
	});

	it('settles a backend that fails every rebuild into an observable unavailable state', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		const backend = new AsyncBackend('exhausted', {
			applyRecord: () => {
				throw new Error('native capacity exhausted');
			},
		});
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(
			registration(backend, { maxRebuildAttempts: 3, rebuildBackoffMilliseconds: 5, maxFlushAgeMilliseconds: 5 })
		);

		await waitFor(() => runtime.getStatus('exhausted')?.state === 'unavailable', { timeout: 5000 });
		assert.strictEqual(backend.resets.length, 3);
		await waitFor(() => store.locks.size === 0, { message: 'an unavailable index releases the lock' });
		const readiness = readDerivedIndexReadiness(store, 'exhausted');
		assert.strictEqual(readiness.state, 'unavailable');
		assert.strictEqual(readiness.rebuildAttempts, 3);
		assert.match(readiness.reason, /permanent failure/);

		// A peer worker (its own backend instance) honours the shared budget instead of starting its own attempts.
		const peerBackend = new AsyncBackend('exhausted');
		const peer = runtimeFor(store, records).runtime;
		peer.register(registration(peerBackend));
		await waitFor(() => peer.getStatus('exhausted')?.state === 'unavailable');
		assert.strictEqual(peerBackend.resets.length, 0);
		await peer.stop();

		backend.applyRecord = undefined;
		assert.strictEqual(runtime.requestRebuild('exhausted'), true);
		await waitFor(() => runtime.getReadiness('exhausted').state === 'ready', { timeout: 5000 });
		assert.deepStrictEqual(backend.cursor, cursor(7));
		await runtime.stop();
	});

	it('retries a rebuild whose boundary was lost to retention during the scan', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const store = new FakeLogStore(new Map([[7, []]]), {
			logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' })]]]),
		});
		store.exactStartFailures.set('local', 'missing');
		const backend = new AsyncBackend('retention', { applyDelay: 2 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend, { rebuildBackoffMilliseconds: 10, maxFlushAgeMilliseconds: 5 }));

		await waitFor(() => runtime.getStatus('retention')?.state === 'needs-rebuild');
		assert.match(runtime.getStatus('retention').reason, /missing durable cursor boundary/);
		assert.strictEqual(readDerivedIndexReadiness(store, 'retention').rebuildAttempts, 1);
		store.exactStartFailures.clear();
		await waitFor(() => runtime.getReadiness('retention').state === 'ready', { timeout: 5000 });
		assert.strictEqual(backend.resets.length, 2);
		await runtime.stop();
	});

	it('handles the reload marker that triggered a rebuild once when the replay meets it again', async () => {
		const records = new Map([['1:a', { version: 5, value: { title: 'a' } }]]);
		const reload = { ...audit({ timestamp: 8, recordId: undefined, type: 'reload' }), recordId: null };
		const store = new FakeLogStore(
			new Map([
				[7, [reload, audit({ timestamp: 9, recordId: 'a' })]],
				[9, []],
			]),
			{ logEntries: new Map([['local', [audit({ timestamp: 7, recordId: 'a' }), reload]]]) }
		);
		const backend = new AsyncBackend('reload', { cursor: cursor(7), applyDelay: 2 });
		const { runtime } = runtimeFor(store, records, { idleGraceMilliseconds: 1000 });
		runtime.register(registration(backend, { rebuildBackoffMilliseconds: 5, maxFlushAgeMilliseconds: 5 }));

		await waitFor(() => runtime.getReadiness('reload').state === 'ready', { timeout: 5000 });
		assert.strictEqual(backend.resets.length, 1);
		assert.deepStrictEqual(backend.cursor, cursor(9));
		await runtime.stop();
	});
});

describe('DerivedIndexRuntime rebuild against an audited RocksDB table', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let runtime;
	before(() => {
		setupTestDBPath();
		require('#js/server/threads/manageThreads').setMainIsWorker(true);
	});
	after(() => runtime?.stop());

	it('sheds user writes end to end once a real runner exceeds its lag budget, and admits them after catch-up', async () => {
		const { table } = require('#src/resources/databases');
		const Gated = table({
			database: 'derived-index-lag-rocks',
			table: 'Gated',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Gated.put('seed', { title: 'seed' });
		const anchor = [...Gated.auditStore.getRange({ start: 1 })]
			.filter((entry) => entry.tableId === Gated.tableId)
			.at(-1).txnLogKey;
		const backend = new SyncBackend('gated', { format: 1, logs: { local: anchor } }, () => DERIVED_INDEX_ACCEPTED);
		const gatedRuntime = new DerivedIndexRuntime(Gated.auditStore, (tableId, recordId) => {
			const entry = Gated.primaryStore.getEntry(recordId);
			return entry?.value ? { version: entry.version, value: entry.value } : undefined;
		});
		gatedRuntime.register({
			backend,
			projections: new Map([[Gated.tableId, (record) => ({ title: record.title })]]),
			options: { maxLagMilliseconds: 40, maxFlushAgeMilliseconds: 5 },
		});
		await Gated.put('g1', { title: 'first' });
		await waitFor(() => backend.deliveries.length >= 1);
		// The backend accepts but never makes anything durable, so catch-up is never proven.
		await waitFor(() => derivedIndexWriteRejection(Gated.auditStore, Gated.tableId) !== undefined, { timeout: 5000 });
		let rejected;
		try {
			await Gated.put('g2', { title: 'blocked' });
		} catch (error) {
			rejected = error;
		}
		assert.strictEqual(rejected?.code, 'DERIVED_INDEX_LAGGING');
		// A canonical-source apply is never shed: dropping it would advance the source cursor past it.
		const { transaction } = require('#src/resources/transaction');
		const canonical = { sourceApply: true };
		await transaction(canonical, () => Gated.put('g-source', { title: 'canonical' }, canonical));
		assert.strictEqual((await Gated.get('g-source'))?.title, 'canonical');
		assert.notStrictEqual(derivedIndexWriteRejection(Gated.auditStore, Gated.tableId), undefined, 'still tripped');
		await waitFor(() => backend.deliveries.length >= 2, { timeout: 5000 });

		backend.cursor = backend.deliveries.at(-1).through;
		backend.stateChange();
		await waitFor(() => derivedIndexWriteRejection(Gated.auditStore, Gated.tableId) === undefined, { timeout: 5000 });
		await Gated.put('g2', { title: 'admitted' });
		await gatedRuntime.stop();
	});

	it('rebuilds from the primary store on the retained log boundary and replays to the head', async () => {
		const { table } = require('#src/resources/databases');
		const Product = table({
			database: 'derived-index-rebuild-rocks',
			table: 'Product',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		for (const id of ['p1', 'p2', 'p3']) await Product.put(id, { title: `title ${id}` });
		await Product.delete('p2');

		const backend = new AsyncBackend('rocks-rebuild', { applyDelay: 2 });
		runtime = new DerivedIndexRuntime(
			Product.auditStore,
			(tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{
				idleGraceMilliseconds: 60_000,
				scanRecords: () =>
					Product.primaryStore.getRange({ versions: true }).map((entry) => ({
						recordId: entry.key,
						version: entry.version,
						value: entry.value,
					})),
			}
		);
		runtime.register({
			backend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
			options: { maxFlushAgeMilliseconds: 10, maxChunkRecords: 2 },
		});

		await waitFor(() => runtime.getReadiness('rocks-rebuild').state === 'ready', { timeout: 10_000 });
		assert.deepStrictEqual([...backend.applied.keys()].sort(), ['p1', 'p3']);
		const oldest = Product.auditStore.getRange({ log: 'local', start: 0 })[Symbol.iterator]().next().value.txnLogKey;
		const scanChunks = backend.deliveries.filter((batch) => batch.rebuild);
		assert.strictEqual(scanChunks.at(-1).through.logs.local, oldest, 'the boundary is the oldest retained transaction');
		assert.strictEqual(backend.cursor.format, 1);
		assert(backend.cursor.logs.local >= oldest);

		await Product.put('p4', { title: 'title p4' });
		await waitFor(() => backend.applied.has('p4'), { timeout: 5000 });
		assert.deepStrictEqual(backend.applied.get('p4').projection, { title: 'title p4' });
		assert.strictEqual(runtime.getMetrics('rocks-rebuild').rebuildAttempts, 0);

		// The write path honours an admission check with a retryable 503; unrelated tables are untouched.
		const release = registerDerivedIndexTables(Product.auditStore, [Product.tableId], () => 'derived index is behind');
		// The guard fires before the first await, so the write may throw synchronously or reject.
		const failure = async (write) => {
			try {
				await write();
			} catch (error) {
				return error;
			}
			assert.fail('expected the write to be rejected');
		};
		const blocked = await failure(() => Product.put('p5', { title: 'blocked' }));
		assert.strictEqual(blocked.statusCode, 503);
		assert.strictEqual(blocked.code, 'DERIVED_INDEX_LAGGING');
		assert.strictEqual(blocked.retryable, true);
		assert.strictEqual((await failure(() => Product.delete('p4'))).statusCode, 503);
		assert.strictEqual((await failure(() => Product.create({ title: 'created' }))).statusCode, 503);
		release();
		await Product.put('p5', { title: 'admitted' });
		await waitFor(() => backend.applied.has('p5'), { timeout: 5000 });

		// A peer runtime on the same real store: shared readiness, the request word and the buffer
		// notification all go through the native binding here, not the fake.
		const peer = new DerivedIndexRuntime(Product.auditStore, () => undefined, { scanRecords: () => [] });
		assert.strictEqual(peer.getReadiness('rocks-rebuild').state, 'ready');
		// The binding hands every caller a plain ArrayBuffer over one process-wide allocation: a second
		// wrapper of the same key observes the owner's publication, and never a SharedArrayBuffer.
		const wrapper = Product.auditStore.getUserSharedBuffer(
			'derived-index:rocks-rebuild:readiness',
			new ArrayBuffer(512)
		);
		assert(!(wrapper instanceof SharedArrayBuffer));
		assert.strictEqual(readDerivedIndexReadiness(Product.auditStore, 'rocks-rebuild').state, 'ready');
		assert.notStrictEqual(new Int32Array(wrapper)[0], 0, 'the wrapper sees the published sequence word');
		// A real worker thread, through the binding alone, reads the owner's publication.
		const { Worker } = require('node:worker_threads');
		const worker = new Worker(
			`const { parentPort, workerData } = require('node:worker_threads');
			const { RocksDatabase } = require(workerData.binding);
			const db = new RocksDatabase(workerData.path).open();
			const words = new Int32Array(db.getUserSharedBuffer(workerData.key, new ArrayBuffer(512)), 0, 8);
			parentPort.postMessage({ state: Atomics.load(words, 1), sequence: Atomics.load(words, 0) });
			db.close();`,
			{
				eval: true,
				workerData: {
					binding: require.resolve('@harperfast/rocksdb-js'),
					path: Product.auditStore.rootStore.path,
					key: 'derived-index:rocks-rebuild:readiness',
				},
			}
		);
		const seen = await new Promise((resolve, reject) => {
			worker.once('message', resolve);
			worker.once('error', reject);
		});
		await new Promise((resolve) => worker.once('exit', resolve));
		assert.strictEqual(seen.state, 1, 'a worker thread reads the ready state the owner published');
		assert(seen.sequence > 0 && seen.sequence % 2 === 0, 'and a settled sequence word');
		// The marker is written through the audit store's symbol-keyed putSync and read back through the
		// root store: one keyspace on the real binding.
		const condemnable = new AsyncBackend('rocks-condemn', { applyDelay: 2 });
		const condemning = new DerivedIndexRuntime(Product.auditStore, () => undefined, { scanRecords: () => [] });
		condemning.register({ backend: condemnable, projections: new Map([[Product.tableId, (record) => record]]) });
		await waitFor(() => condemning.getReadiness('rocks-condemn').state === 'ready', { timeout: 5000 });
		condemnable.reset = undefined;
		condemnable.stateChange('failed');
		await waitFor(() => condemning.getStatus('rocks-condemn')?.state === 'needs-rebuild');
		const markerKey = Symbol.for('derived-index:rocks-condemn:condemned');
		assert.notStrictEqual(
			Product.auditStore.rootStore.getSync(markerKey),
			undefined,
			'marker readable via the root store'
		);
		await condemning.stop();
		const rebuildable = new AsyncBackend('rocks-condemn', { applyDelay: 2 });
		const rebuilding = new DerivedIndexRuntime(
			Product.auditStore,
			(tableId, recordId) => {
				const entry = Product.primaryStore.getEntry(recordId);
				return entry?.value ? { version: entry.version, value: entry.value } : undefined;
			},
			{ scanRecords: () => [] }
		);
		rebuilding.register({
			backend: rebuildable,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
			options: { maxFlushAgeMilliseconds: 5 },
		});
		await waitFor(() => rebuilding.getReadiness('rocks-condemn').state === 'ready', { timeout: 5000 });
		assert.strictEqual(rebuildable.resets.length, 1);
		assert.strictEqual(
			Product.auditStore.rootStore.getSync(markerKey),
			undefined,
			'marker removed at the durable ready'
		);
		await rebuilding.stop();

		const peerBackend = new AsyncBackend('rocks-rebuild', { applyDelay: 2 });
		const unregisterPeer = peer.register({
			backend: peerBackend,
			projections: new Map([[Product.tableId, (record) => ({ title: record.title })]]),
		});
		assert.strictEqual(peer.requestRebuild('rocks-rebuild'), true);
		await waitFor(() => backend.resets.length === 2, { timeout: 5000 });
		await waitFor(() => runtime.getReadiness('rocks-rebuild').state === 'ready', { timeout: 10_000 });
		// create() left Harper's internal id-allocation entry in the primary store; the scan must skip it.
		assert.deepStrictEqual([...backend.applied.keys()].sort(), ['p1', 'p3', 'p4', 'p5']);
		assert.strictEqual(peerBackend.resets.length, 0);
		await unregisterPeer();
		await peer.stop();
	});
});
