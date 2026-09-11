const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { waitFor } = require('../waitFor');
const {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	DerivedIndexRuntime,
} = require('#src/resources/derivedIndexRuntime');

class FakeLogStore {
	constructor(entriesByCursor, logNames = ['local']) {
		this.entriesByCursor = entriesByCursor;
		this.locks = new Set();
		this.waiters = new Map();
		this.sharedBuffers = new Map();
		this.rangeCalls = [];
		this.rootStore = new EventEmitter();
		this.rootStore.listLogs = () => logNames.slice();
		this.rootStore.useLog = (name) => ({ name, getStats: () => ({ oldestSequenceNumber: 1 }) });
	}

	getRange(options) {
		this.rangeCalls.push(options);
		const start = options.startByLog.get('local');
		const iterable = (this.entriesByCursor.get(start) ?? []).map((entry) => ({ ...entry }));
		iterable.corruptFrameStop = { breaks: 0, truncatedVersions: new Set(), midLogBreak: false };
		iterable.failedLogs = new Set();
		iterable.exactStartFailures = new Map();
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

	getUserSharedBuffer(key, defaultBuffer) {
		let buffer = this.sharedBuffers.get(key);
		if (!buffer) {
			buffer = new SharedArrayBuffer(defaultBuffer.byteLength);
			this.sharedBuffers.set(key, buffer);
		}
		return buffer;
	}
}

class FakeBackend {
	constructor(id, cursor, deliver) {
		this.id = id;
		this.cursor = cursor;
		this.deliveries = [];
		this.deliverImpl = deliver;
	}

	attach() {}

	flush() {}

	shutdown() {}

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
const audit = ({ timestamp, recordId, tableId = 1, version = timestamp, type = 'put', endTxn = true }) => ({
	logName: 'local',
	txnLogKey: timestamp,
	version,
	recordId,
	tableId,
	type,
	endTxn,
	size: 32,
});

function runtimeFor(store, records, options) {
	let reads = 0;
	const runtime = new DerivedIndexRuntime(
		store,
		(tableId, recordId) => {
			reads++;
			return records.get(`${tableId}:${recordId}`);
		},
		{ idleGraceMilliseconds: 5, ...options }
	);
	return { runtime, getReads: () => reads };
}

const registration = (backend) => ({
	backend,
	projections: new Map([[1, (record) => ({ title: record.title })]]),
});

describe('DerivedIndexRuntime', () => {
	it('delivers authoritative projected state once per record and advances through unrelated transactions', async () => {
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						audit({ timestamp: 20, recordId: 'a', version: 100 }),
						audit({ timestamp: 30, recordId: 'a', version: 200 }),
						audit({ timestamp: 40, recordId: 'ignored', tableId: 2 }),
					],
				],
			])
		);
		const backend = new FakeBackend('search', cursor(10));
		const { runtime, getReads } = runtimeFor(store, new Map([['1:a', { version: 300, value: { title: 'current' } }]]));
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1);
		const [batch] = backend.deliveries;
		assert.deepStrictEqual(batch.through, cursor(40));
		assert.strictEqual(batch.transactions.length, 2);
		assert.deepStrictEqual(
			batch.transactions.map(({ timestamp, mutations }) => [timestamp, mutations[0].logVersion, mutations[0].state]),
			[
				[20, 100, { kind: 'record', version: 300, projection: { title: 'current' } }],
				[30, 200, { kind: 'record', version: 300, projection: { title: 'current' } }],
			]
		);
		assert.strictEqual(getReads(), 1);
		assert.strictEqual(store.rootStore.listenerCount('committed'), 1);
		assert.strictEqual(store.rangeCalls[0].readUncommitted, undefined);
		runtime.stop();
		assert.strictEqual(store.rootStore.listenerCount('committed'), 0);
	});

	it('retains a deferred batch and retries it only after the backend wakes', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		let accept = false;
		const backend = new FakeBackend('deferred', cursor(10), (batch, target) => {
			if (!accept) return DERIVED_INDEX_DEFERRED;
			target.cursor = batch.through;
			return DERIVED_INDEX_ACCEPTED;
		});
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1);
		assert.strictEqual(runtime.getStatus('deferred').state, 'deferred');
		assert.deepStrictEqual(backend.cursor, cursor(10));
		store.rootStore.emit('committed');
		store.rootStore.emit('committed');
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(backend.deliveries.length, 1, 'commits must not retry backend-deferred work');
		accept = true;
		backend.stateChange();
		await waitFor(() => backend.deliveries.length === 2);
		assert.strictEqual(backend.deliveries[1], backend.deliveries[0]);
		assert.deepStrictEqual(backend.cursor, cursor(20));
		runtime.stop();
	});

	it('does not resume after a synchronous permanent-failure callback from deliver', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const backend = new FakeBackend('synchronous-failure', cursor(10), (_batch, target) => {
			target.stateChange('failed');
			return DERIVED_INDEX_ACCEPTED;
		});
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend));

		await waitFor(() => runtime.getStatus('synchronous-failure')?.state === 'needs-rebuild');
		assert.strictEqual(backend.deliveries.length, 1);
		store.rootStore.emit('committed');
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(backend.deliveries.length, 1);
		runtime.stop();
	});

	it('reconstructs before handling a result returned after synchronous accepted-work loss', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		let first = true;
		const backend = new FakeBackend('synchronous-loss', cursor(10), (batch, target) => {
			if (first) {
				first = false;
				target.stateChange('accepted-work-lost');
				return DERIVED_INDEX_ACCEPTED;
			}
			target.cursor = batch.through;
			return DERIVED_INDEX_ACCEPTED;
		});
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 2 && backend.cursor.logs.local === 20);
		assert(store.rangeCalls.length >= 2);
		assert.deepStrictEqual(backend.deliveries[1].transactions, backend.deliveries[0].transactions);
		runtime.stop();
	});

	it('replays from the durable cursor when a backend reports lost accepted work', async () => {
		const entries = new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]);
		const store = new FakeLogStore(entries);
		let persist = false;
		const backend = new FakeBackend('loss', cursor(10), (batch, target) => {
			if (persist) target.cursor = batch.through;
			return DERIVED_INDEX_ACCEPTED;
		});
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1);
		persist = true;
		backend.stateChange('accepted-work-lost');
		await waitFor(() => backend.deliveries.length === 2);
		assert.deepStrictEqual(backend.deliveries[1], backend.deliveries[0]);
		assert.deepStrictEqual(backend.cursor, cursor(20));
		assert(store.rangeCalls.length >= 2, 'lost work must reconstruct the exact-resume iterator');
		runtime.stop();
	});

	it('fails closed when the exact durable cursor boundary is unavailable', async () => {
		const store = new FakeLogStore(new Map());
		store.getRange = function (options) {
			const iterable = FakeLogStore.prototype.getRange.call(this, options);
			iterable.exactStartFailures.set('local', 'missing');
			return iterable;
		};
		const backend = new FakeBackend('broken', cursor(10));
		const { runtime } = runtimeFor(store, new Map());
		runtime.register(registration(backend));

		await waitFor(() => runtime.getStatus('broken')?.state === 'needs-rebuild');
		assert.match(runtime.getStatus('broken').reason, /missing durable cursor boundary/);
		assert.strictEqual(backend.deliveries.length, 0);
		assert.strictEqual(store.locks.size, 0);
		runtime.stop();
	});

	for (const [name, mutateRange, reason] of [
		[
			'a corrupt transaction-log frame',
			(iterable) => {
				iterable.corruptFrameStop.breaks = 1;
			},
			/corrupt frame/,
		],
		['an unexpected transaction-log failure', (iterable) => iterable.failedLogs.add('local'), /iterator failed/],
	]) {
		it(`fails closed on ${name}`, async () => {
			const store = new FakeLogStore(new Map([[10, []]]));
			store.getRange = function (options) {
				const iterable = FakeLogStore.prototype.getRange.call(this, options);
				mutateRange(iterable);
				return iterable;
			};
			const backend = new FakeBackend(`range-failure-${reason}`, cursor(10));
			const { runtime } = runtimeFor(store, new Map());
			runtime.register(registration(backend));

			await waitFor(() => runtime.getStatus(backend.id)?.state === 'needs-rebuild');
			assert.match(runtime.getStatus(backend.id).reason, reason);
			assert.strictEqual(backend.deliveries.length, 0);
			runtime.stop();
		});
	}

	it('delivers a cursor-only batch for unrelated committed work', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'ignored', tableId: 2 })]]]));
		const backend = new FakeBackend('cursor-only', cursor(10));
		const { runtime, getReads } = runtimeFor(store, new Map());
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1);
		assert.deepStrictEqual(backend.deliveries[0], { ownerEpoch: 1n, transactions: [], through: cursor(20) });
		assert.strictEqual(getReads(), 0);
		runtime.stop();
	});

	it('bounds accepted work while the backend durability barrier lags', async () => {
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
		const backend = new FakeBackend('durability-cap', cursor(10), () => DERIVED_INDEX_ACCEPTED);
		const records = new Map(['a', 'b', 'c'].map((id) => [`1:${id}`, { version: 40, value: { title: id } }]));
		const { runtime } = runtimeFor(store, records, {
			maxTransactionsPerTurn: 1,
			maxAcceptedBatchesAhead: 2,
		});
		runtime.register(registration(backend));

		await waitFor(() => runtime.getStatus('durability-cap')?.state === 'waiting-durable');
		assert.strictEqual(backend.deliveries.length, 2);
		store.rootStore.emit('committed');
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(backend.deliveries.length, 2, 'commits must not bypass the durability cap');

		backend.cursor = backend.deliveries[0].through;
		backend.stateChange();
		await waitFor(() => backend.deliveries.length === 3);
		assert.strictEqual(backend.deliveries[2].through.logs.local, 40);
		runtime.stop();
	});

	it('applies drain budgets only between complete transactions', async () => {
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[
						{ ...audit({ timestamp: 20, recordId: 'a' }), endTxn: false },
						audit({ timestamp: 20, recordId: 'b' }),
						audit({ timestamp: 30, recordId: 'c' }),
					],
				],
			])
		);
		const records = new Map(['a', 'b', 'c'].map((id) => [`1:${id}`, { version: 30, value: { title: id } }]));
		const backend = new FakeBackend('bounded', cursor(10));
		const { runtime } = runtimeFor(store, records, { maxTransactionsPerTurn: 1, maxBytesPerTurn: 1 });
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 2);
		assert.strictEqual(backend.deliveries[0].transactions.length, 1);
		assert.strictEqual(backend.deliveries[0].transactions[0].mutations.length, 2);
		assert.strictEqual(backend.deliveries[0].through.logs.local, 20);
		assert.strictEqual(backend.deliveries[1].through.logs.local, 30);
		runtime.stop();
	});

	it('isolates one backend failure from another backend runner', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		const failed = new FakeBackend('failed', cursor(10), () => {
			throw new Error('backend failure');
		});
		const healthy = new FakeBackend('healthy', cursor(10));
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(failed));
		runtime.register(registration(healthy));

		await waitFor(() => runtime.getStatus('failed')?.state === 'needs-rebuild' && healthy.deliveries.length === 1);
		assert.match(runtime.getStatus('failed').reason, /backend delivery threw/);
		assert.deepStrictEqual(healthy.cursor, cursor(20));
		runtime.stop();
	});

	it('requires a fresh lock acquisition after another worker releases ownership', async () => {
		const store = new FakeLogStore(
			new Map([
				[10, [audit({ timestamp: 20, recordId: 'a' })]],
				[20, []],
			])
		);
		const backend = new FakeBackend('shared', cursor(10));
		const records = new Map([['1:a', { version: 20, value: { title: 'a' } }]]);
		const first = runtimeFor(store, records).runtime;
		const second = runtimeFor(store, records).runtime;
		first.register(registration(backend));
		second.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1 && store.rangeCalls.length >= 2);
		assert.deepStrictEqual(backend.cursor, cursor(20));
		assert.strictEqual(backend.deliveries.length, 1, 'the waiting runner must exact-resume after acquiring the lock');
		first.stop();
		second.stop();
	});

	it('does not lose a synchronous lock-release notification', async () => {
		const store = new FakeLogStore(new Map([[10, [audit({ timestamp: 20, recordId: 'a' })]]]));
		let attempts = 0;
		store.tryLock = (key, onUnlocked) => {
			attempts++;
			if (attempts === 1) {
				onUnlocked();
				return false;
			}
			store.locks.add(key);
			return true;
		};
		const backend = new FakeBackend('synchronous-unlock', cursor(10));
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 1);
		assert.strictEqual(attempts, 2);
		runtime.stop();
	});

	it('rejects a durable cursor assembled from different offered batch boundaries', async () => {
		const initial = { format: 1, logs: { local: 10, remote: 11 } };
		const store = new FakeLogStore(
			new Map([
				[
					10,
					[audit({ timestamp: 20, recordId: 'a' }), { ...audit({ timestamp: 21, recordId: 'b' }), logName: 'remote' }],
				],
			]),
			['local', 'remote']
		);
		const backend = new FakeBackend('mixed-cursor', initial, () => DERIVED_INDEX_ACCEPTED);
		const records = new Map(['a', 'b'].map((id) => [`1:${id}`, { version: 21, value: { title: id } }]));
		const { runtime } = runtimeFor(store, records, { maxTransactionsPerTurn: 1 });
		runtime.register(registration(backend));

		await waitFor(() => backend.deliveries.length === 2);
		assert.deepStrictEqual(
			backend.deliveries.map((batch) => batch.through),
			[
				{ format: 1, logs: { local: 20, remote: 11 } },
				{ format: 1, logs: { local: 20, remote: 21 } },
			]
		);
		backend.cursor = { format: 1, logs: { local: 10, remote: 21 } };
		backend.stateChange();

		await waitFor(() => runtime.getStatus('mixed-cursor')?.state === 'needs-rebuild');
		assert.match(runtime.getStatus('mixed-cursor').reason, /unoffered cursor vector/);
		runtime.stop();
	});

	it('fails closed when one physical log repeats a completed timestamp', async () => {
		const store = new FakeLogStore(
			new Map([[10, [audit({ timestamp: 20, recordId: 'a' }), audit({ timestamp: 20, recordId: 'b' })]]])
		);
		const backend = new FakeBackend('duplicate', cursor(10));
		const { runtime } = runtimeFor(store, new Map());
		runtime.register(registration(backend));

		await waitFor(() => runtime.getStatus('duplicate')?.state === 'needs-rebuild');
		assert.match(runtime.getStatus('duplicate').reason, /repeated completed timestamp/);
		assert.strictEqual(backend.deliveries.length, 0);
		runtime.stop();
	});

	it('reacquires after the idle grace period when a later commit wakes it', async () => {
		const entries = new Map([[10, []]]);
		const store = new FakeLogStore(entries);
		const backend = new FakeBackend('idle-wake', cursor(10));
		const { runtime } = runtimeFor(store, new Map([['1:a', { version: 20, value: { title: 'a' } }]]));
		runtime.register(registration(backend));

		await waitFor(() => store.locks.size === 0);
		entries.set(10, [audit({ timestamp: 20, recordId: 'a' })]);
		store.rootStore.emit('committed');

		await waitFor(() => backend.deliveries.length === 1);
		assert.deepStrictEqual(backend.cursor, cursor(20));
		runtime.stop();
	});

	it('unregisters the backend wake and root commit listeners', async () => {
		const store = new FakeLogStore(new Map([[10, []]]));
		const backend = new FakeBackend('unregister', cursor(10));
		const { runtime } = runtimeFor(store, new Map());
		const unregister = runtime.register(registration(backend));

		await waitFor(() => backend.stateChange !== undefined);
		unregister();
		assert.strictEqual(backend.stateChange, undefined);
		assert.strictEqual(store.rootStore.listenerCount('committed'), 0);
		assert.strictEqual(runtime.getStatus('unregister'), undefined);
		runtime.stop();
	});

	it('fails closed if a saved physical log disappears', async () => {
		const logNames = ['local'];
		const store = new FakeLogStore(new Map([[10, []]]), logNames);
		const backend = new FakeBackend('removed-log', cursor(10));
		const { runtime } = runtimeFor(store, new Map());
		runtime.register(registration(backend));

		await waitFor(() => store.locks.size === 0);
		logNames.length = 0;
		store.rootStore.emit('committed');

		await waitFor(() => runtime.getStatus('removed-log')?.state === 'needs-rebuild');
		assert.match(runtime.getStatus('removed-log').reason, /saved transaction log 'local' is missing/);
		runtime.stop();
	});
});
