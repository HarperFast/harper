const assert = require('node:assert');
const path = require('node:path');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { createAuditEntry, ENTRY_DATAVIEW } = require('#src/resources/auditStore');
const { SubscriptionResumeState, SubscriptionResumeError } = require('#src/resources/subscriptionResumeState');
const { openSubscriptionResumeLog } = require('#src/resources/subscriptionResumeLog');

describe('compact subscription resume over real physical logs', () => {
	const databases = [];
	const readers = [];
	let sequence = 0;
	const options = {
		historyId: 'same-physical-history/table/all/v1',
		window: 10,
		origins: ['a', 'b'],
		localNodeName: 'a',
	};

	function database(config) {
		const db = new RocksDatabase(
			path.join(__dirname, '../envDir', String(process.pid), `resume-${++sequence}`),
			config
		);
		db.open();
		databases.push(db);
		return new RocksTransactionLogStore(db);
	}

	async function append(store, logName, timestamp, ids = [String(timestamp)], type = 'delete') {
		await store.rootStore.transaction((txn) => {
			txn.setTimestamp(timestamp);
			for (const recordId of ids) {
				ENTRY_DATAVIEW.setUint32(0, 0);
				const data = Buffer.from(createAuditEntry({ type, tableId: 1, recordId, nodeId: 0, version: timestamp }, 4));
				store.rootStore.useLog(logName).addEntry(data, txn.id);
			}
		});
	}

	function checkpoint(positions, config = options) {
		const state = new SubscriptionResumeState(config);
		for (const [origin, timestamp] of positions) state.recordTransaction(origin, timestamp);
		return state.checkpoint();
	}

	async function open(store, saved, config = options) {
		const reader = await openSubscriptionResumeLog(store, { ...config, ...saved });
		readers.push(reader);
		return reader;
	}

	afterEach(async () => {
		for (const reader of readers.splice(0)) reader.return();
		for (const db of databases.splice(0)) await db.close();
	});

	it('replays a backdated suffix that a scalar range drops, across local-name remapping', async () => {
		const store = database();
		await append(store, 'a', 100);
		await append(store, 'a', 20);
		await append(store, 'local', 40);
		const saved = checkpoint([
			['a', 100],
			['b', 40],
		]);
		assert.deepStrictEqual(
			[...store.getRange({ log: 'a', start: saved.startTime })].map((e) => e.txnLogKey),
			[100]
		);
		const reader = await open(store, saved, { ...options, localNodeName: 'b' });
		assert.deepStrictEqual(
			[...reader].map((e) => [e.logName, e.txnLogKey]),
			[
				['local', 40],
				['a', 100],
				['a', 20],
			]
		);
		await append(store, 'a', 10);
		assert.deepStrictEqual(
			[...reader].map((e) => e.txnLogKey),
			[10]
		);
	});

	it('keeps an origin active after its last physical transaction regresses', async () => {
		const store = database();
		await append(store, 'local', 100);
		await append(store, 'local', 20);
		const saved = checkpoint([
			['a', 100],
			['a', 20],
		]);
		assert.deepStrictEqual(
			[...(await open(store, saved))].map((e) => e.txnLogKey),
			[100, 20]
		);
	});

	it('matches an idle physical tail rather than its maximum timestamp', async () => {
		const store = database();
		await append(store, 'local', 100);
		await append(store, 'local', 20);
		await append(store, 'b', 150);
		const saved = checkpoint([
			['a', 100],
			['a', 20],
			['b', 150],
		]);
		assert.deepStrictEqual(
			[...(await open(store, saved))].map((e) => e.txnLogKey),
			[20, 150]
		);
	});

	it('does not classify post-checkpoint writes as activity in the saved window', async () => {
		const store = database();
		await append(store, 'local', 100);
		await append(store, 'b', 40);
		const saved = checkpoint([
			['a', 100],
			['b', 40],
		]);
		await append(store, 'b', 200);
		assert.deepStrictEqual(
			[...(await open(store, saved))].map((e) => e.txnLogKey),
			[40, 100, 200]
		);
	});

	it('rejects unseen pre-window progress on an idle origin', async () => {
		const store = database();
		await append(store, 'local', 100);
		await append(store, 'b', 40);
		const saved = checkpoint([
			['a', 100],
			['b', 40],
		]);
		await append(store, 'b', 50);
		await assert.rejects(open(store, saved), (e) => e.resyncRequired && /does not match/.test(e.message));
	});

	it('replays complete multi-entry transactions from an inclusive boundary', async () => {
		const store = database();
		await append(store, 'local', 100, ['first', 'last']);
		const rows = [...(await open(store, checkpoint([['a', 100]])))];
		assert.deepStrictEqual(
			rows.map((e) => e.recordId),
			['first', 'last']
		);
		assert.strictEqual(rows[0].endTxn, false);
		assert.strictEqual(rows[1].endTxn, true);
	});

	it('binds the checkpoint to history incarnation, scope, window and membership', async () => {
		const store = database();
		await append(store, 'local', 100);
		const saved = checkpoint([['a', 100]]);
		for (const changed of [
			{ historyId: 'reordered-replica-or-restored-history' },
			{ window: 20 },
			{ origins: ['a'] },
		]) {
			await assert.rejects(open(store, saved, { ...options, ...changed }), SubscriptionResumeError);
		}
	});

	it('rejects ambiguous timestamps, malformed records and reload markers', async () => {
		const repeated = database();
		await append(repeated, 'local', 100);
		await append(repeated, 'local', 100, ['again']);
		await assert.rejects(open(repeated, checkpoint([['a', 100]])), /ambiguous transaction/);
		const corrupt = database();
		await corrupt.rootStore.transaction((txn) => {
			txn.setTimestamp(100);
			corrupt.rootStore.useLog('local').addEntry(Buffer.from([0]), txn.id);
		});
		await assert.rejects(open(corrupt, checkpoint([['a', 100]])), /unreadable/);
		const replaced = database();
		await append(replaced, 'local', 100, ['reload'], 'reload');
		const replacedReader = await open(replaced, checkpoint([['a', 100]]));
		assert.throws(() => [...replacedReader], /replaced state/);
	});

	it('invalidates an open iterator on new logs or a reload, and can be closed repeatedly', async () => {
		const store = database();
		await append(store, 'local', 100);
		const reader = await open(store, checkpoint([['a', 100]]));
		assert.strictEqual([...reader].length, 1);
		await append(store, 'new-origin', 101);
		assert.throws(() => reader.next(), /membership changed/);
		assert.throws(() => reader.next(), /membership changed/);
		reader.return();
		assert.strictEqual(reader.next().done, true);
		const other = database();
		await append(other, 'local', 100);
		const second = await open(other, checkpoint([['a', 100]]));
		assert.strictEqual([...second].length, 1);
		await append(other, 'local', 101, ['reload'], 'reload');
		assert.throws(() => second.next(), /replaced state/);
	});

	it('allows an acknowledged reload before the replay anchor', async () => {
		const store = database();
		await append(store, 'local', 10, ['reload'], 'reload');
		await append(store, 'local', 100);
		assert.deepStrictEqual(
			[
				...(await open(
					store,
					checkpoint([
						['a', 10],
						['a', 100],
					])
				)),
			].map((entry) => entry.txnLogKey),
			[100]
		);
	});

	it('demonstrates why a newer startTime must not be persisted with an older fingerprint', async () => {
		const store = database();
		const state = new SubscriptionResumeState(options);
		for (const [origin, timestamp] of [
			['a', 50],
			['b', 55],
		]) {
			await append(store, origin === 'a' ? 'local' : origin, timestamp);
			state.recordTransaction(origin, timestamp);
		}
		const previous = state.checkpoint();
		await append(store, 'b', 70);
		state.recordTransaction('b', 70);
		const current = state.checkpoint();
		await append(store, 'local', 40);
		await append(store, 'local', 65);
		await assert.rejects(open(store, current), /does not match/);
		const mixed = await open(store, { startTime: current.startTime, resumeState: previous.resumeState });
		assert.deepStrictEqual(
			[...mixed].map((entry) => entry.txnLogKey),
			[65, 70]
		);
	});

	it('bounds scan work and releases admission after rejection or cancellation', async () => {
		const store = database();
		await append(
			store,
			'local',
			100,
			Array.from({ length: 1100 }, (_, i) => String(i))
		);
		const saved = checkpoint([['a', 100]]);
		await assert.rejects(open(store, saved, { ...options, maxEntries: 100 }), /budget exceeded/);
		const controller = new AbortController();
		const pending = open(store, saved, { ...options, signal: controller.signal });
		await assert.rejects(open(store, saved), { retryable: true, resyncRequired: false });
		controller.abort();
		await assert.rejects(pending, { name: 'AbortError' });
		assert.strictEqual([...(await open(store, saved))].length, 1100);
	});

	it('releases admission even when closing a validation iterator throws', async () => {
		const store = database();
		await append(store, 'local', 100);
		const saved = checkpoint([['a', 100]]);
		const getRange = store.getRange;
		store.getRange = function (options) {
			const range = getRange.call(this, options);
			const createIterator = range[Symbol.iterator];
			range[Symbol.iterator] = function () {
				const iterator = createIterator.call(this);
				return {
					next: () => iterator.next(),
					return() {
						iterator.return?.();
						throw new Error('injected close failure');
					},
				};
			};
			return range;
		};
		try {
			await assert.rejects(open(store, saved), /injected close failure/);
		} finally {
			store.getRange = getRange;
		}
		assert.strictEqual([...(await open(store, saved))].length, 1);
	});

	it('rejects a surviving in-window anchor when an earlier physical prefix was pruned', async () => {
		const store = database({ transactionLogMaxSize: 128 });
		for (const timestamp of [100, 20, 98]) {
			await append(store, 'local', timestamp, [String(timestamp).repeat(100)]);
			await store.rootStore.put('flush', timestamp);
		}
		await store.rootStore.flush();
		const purged = store.rootStore.purgeLogs({ before: Date.now() + 100_000 });
		assert(purged.length > 0);
		assert(store.rootStore.useLog('local').getStats().oldestSequenceNumber > 1);
		await assert.rejects(open(store, checkpoint([['a', 100]])), /no longer retains its beginning/);
	});

	it('rejects invalid requests before scanning', async () => {
		const store = database();
		const saved = checkpoint([]);
		for (const changed of [{ startTime: -1 }, { maxEntries: 0 }, { localNodeName: 'missing' }]) {
			await assert.rejects(open(store, { ...saved, ...changed }), TypeError);
		}
		await assert.rejects(open(store, { ...saved, resumeState: 'garbage' }), SubscriptionResumeError);
		assert.deepStrictEqual([...(await open(store, saved))], []);
	});
});
