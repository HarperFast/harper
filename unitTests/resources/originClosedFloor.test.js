require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { Transaction, RocksDatabase } = require('@harperfast/rocksdb-js');
const {
	certifyOriginFloor,
	getOriginClosedFloor,
	publishOriginFloor,
	reserveLocalKey,
	releaseLocalKey,
	retireOriginFloorSlots,
} = require('#src/resources/originClosedFloor');
const { persistOriginClosedFloor, readOriginClosedFloor, LOCAL_ONLY } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('origin-closed timestamp floor (harper-pro#922)', function () {
	this.timeout(60_000);
	let Tbl, rootStore, auditStore;
	const tableName = 'OriginFloorTable';
	const workers = new Set();

	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table({
			table: tableName,
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		rootStore = Tbl.primaryStore.rootStore;
		auditStore = rootStore.auditStore;
		assert(rootStore instanceof RocksDatabase);
	});

	afterEach(async () => {
		for (const worker of workers) await worker.terminate();
		workers.clear();
	});

	function certify() {
		const floor = certifyOriginFloor(rootStore);
		if (floor !== undefined) {
			persistOriginClosedFloor(auditStore, floor);
			publishOriginFloor(rootStore, floor);
		}
		return getOriginClosedFloor(rootStore)?.floor ?? 0;
	}

	function entriesFor(id, nodeId = 0) {
		const entries = [];
		for (const auditRecord of auditStore.getRange({ start: 1, log: nodeId })) {
			if (auditRecord.tableId === Tbl.tableId && auditRecord.recordId === id) entries.push(auditRecord);
		}
		return entries;
	}

	function startWorker(workerData) {
		const worker = new Worker(__dirname + '/originClosedFloor-thread.js', { workerData });
		workers.add(worker);
		const messages = [];
		const waiters = [];
		worker.on('message', (message) => {
			if (message.type === 'error') for (const { reject } of waiters.splice(0)) reject(new Error(message.message));
			messages.push(message);
			for (const waiter of waiters.splice(0)) waiter.resolve();
		});
		worker.on('error', (error) => {
			for (const { reject } of waiters.splice(0)) reject(error);
		});
		const next = async (type) => {
			for (;;) {
				const index = messages.findIndex((message) => message.type === type);
				if (index >= 0) return messages.splice(index, 1)[0];
				await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
			}
		};
		const exited = Promise.race([
			new Promise((resolve) => worker.once('exit', resolve)),
			sleep(30_000).then(() => Promise.reject(new Error('the worker did not exit within 30 s'))),
		]);
		return { worker, next, exited };
	}

	it('advances and persists on an idle database', async () => {
		const first = certify();
		assert(first > 0, 'the floor is established without any write');
		await sleep(2);
		const second = certify();
		assert(second > first, 'the floor follows the clock while nothing is outstanding');
		assert.equal(readOriginClosedFloor(auditStore), second, 'the advertised floor is the persisted one');
		assert(second <= rootStore.getMonotonicTimestamp(), 'the floor never runs ahead of the clock');
	});

	it('a plain write commits at or above every floor published before it', async () => {
		const before = certify();
		await Tbl.put({ id: 'plain', n: 1 });
		const [entry] = entriesFor('plain');
		assert(entry.txnLogKey >= before, `key ${entry.txnLogKey} below floor ${before}`);
		assert.equal(entry.version, entry.txnLogKey, 'a local write keeps one clock');
		const after = certify();
		assert(after > entry.txnLogKey, 'once the entry is appended the floor passes its key');
	});

	it('a stalled commit holds the floor at its key until the batch is appended (worker thread)', async () => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { next, exited } = startWorker({ mode: 'hold', gate, tableName });
		await next('ready');
		const { key } = await next('reserved');
		for (let round = 0; round < 3; round++) {
			await sleep(2);
			const floor = certify();
			assert(floor <= key, `floor ${floor} passed the stalled commit's key ${key}`);
		}
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		await next('committed');
		await exited;
		const [entry] = entriesFor('held');
		assert.equal(entry.txnLogKey, key, 'the stalled transaction appended under its reserved key');
		await sleep(2);
		assert(certify() > key, 'the floor passes the key once the batch is appended');
	});

	it('a stalled commit holds the floor on the certifying thread too', async () => {
		const nativeCommit = Transaction.prototype.commit;
		let reservedKey;
		let floorDuringStall;
		Transaction.prototype.commit = function () {
			reservedKey = this.getTimestamp();
			floorDuringStall = certify();
			Transaction.prototype.commit = nativeCommit;
			return nativeCommit.call(this);
		};
		try {
			await transaction({}, () => Tbl.put({ id: 'stalled-local', n: 1 }));
		} finally {
			Transaction.prototype.commit = nativeCommit;
		}
		assert(floorDuringStall <= reservedKey, `floor ${floorDuringStall} passed the stalled key ${reservedKey}`);
		assert.equal(entriesFor('stalled-local')[0].txnLogKey, reservedKey);
	});

	it('a commit replayed past an open iterator hands the reservation to the replay handle', async () => {
		let key;
		let iterator;
		await transaction({}, async (txn) => {
			iterator = Tbl.search({ conditions: [] })[Symbol.iterator]();
			iterator.next();
			await Tbl.put({ id: 'replayed', n: 1 });
			key = txn.timestamp;
		});
		assert(key > 0, 'the write reserved a key');
		iterator.return?.();
		await sleep(2);
		assert(certify() > key, 'the floor passes the key once the replay committed and the iterator closed');
		assert.equal(entriesFor('replayed')[0].txnLogKey, key);
	});

	it('a backdated commit replayed past an open iterator still appends at its admitted key', async () => {
		await sleep(2);
		const floor = certify();
		const timestamp = floor - 2000;
		let iterator;
		await transaction({ timestamp }, async () => {
			iterator = Tbl.search({ conditions: [] })[Symbol.iterator]();
			iterator.next();
			await Tbl.put({ id: 'replayed-backdated', n: 1 });
		});
		iterator.return?.();
		const [entry] = entriesFor('replayed-backdated');
		assert.equal(entry.version, timestamp);
		assert(entry.txnLogKey >= floor, `replay appended at ${entry.txnLogKey} below the floor ${floor}`);
	});

	it('a published message in a backdated transaction stays reachable from its record', async () => {
		await sleep(2);
		const floor = certify();
		const timestamp = floor - 3000;
		await Tbl.put({ id: 'published', n: 1 });
		await transaction({ timestamp }, () => Tbl.publish('published', { hello: 'floor' }));
		const [, message] = entriesFor('published');
		assert.equal(message.type, 'message');
		assert(message.txnLogKey >= floor, `message appended at ${message.txnLogKey} below the floor ${floor}`);
		const history = await Tbl.getHistoryOfRecord('published');
		assert(
			history.some((item) => item.localTime === message.txnLogKey),
			'the record points at the message entry by its log key'
		);
	});

	it('a second write at an existing version below the floor is still its re-delivery', async () => {
		await sleep(2);
		const floor = certify();
		const version = floor - 4000;
		await transaction({ timestamp: version }, () => Tbl.put({ id: 'same-version', n: 1 }));
		await transaction({ timestamp: version }, () => Tbl.put({ id: 'same-version', n: 2 }));
		assert.equal(
			Tbl.primaryStore.getEntry('same-version').value.n,
			1,
			'an equal version from the same origin is a duplicate, as before the floor'
		);
		assert.equal(entriesFor('same-version').length, 1);
	});

	it('a re-delivered increment below the floor applies once although its first delivery was rekeyed', async () => {
		await sleep(2);
		const floor = certify();
		await transaction({ timestamp: floor - 10_000 }, () => Tbl.put({ id: 'counter', n: 0 }));
		const version = floor - 6000;
		const deliver = () =>
			transaction({ source: {}, sourceApply: true, timestamp: version }, () =>
				Tbl.patch('counter', { n: { __op__: 'add', value: 1 } })
			);
		await deliver();
		assert.equal((await Tbl.get('counter')).n, 1);
		const [, first] = entriesFor('counter');
		assert(first.txnLogKey >= floor && first.version === version, 'the first delivery was rekeyed above the floor');
		await deliver();
		assert.equal((await Tbl.get('counter')).n, 1, 'the re-delivery of a rekeyed apply is not applied twice');
		assert.equal(entriesFor('counter').length, 2);
		assert(
			Tbl.primaryStore.getEntry('counter').additionalAuditRefs?.some((ref) => ref.version === version),
			'the record keeps the received identity a re-delivery carries'
		);
	});

	it('a worker that dies with its commit in the native lane still appends, and is retired after', async () => {
		const { next, exited } = startWorker({ mode: 'exit-after-submit', tableName });
		await next('ready');
		const { key, threadId } = await next('reserved');
		await exited;
		retireOriginFloorSlots(threadId);
		assert.equal(entriesFor('dying-submitted')[0]?.txnLogKey, key, 'teardown drained the submitted commit');
		await sleep(2);
		assert(certify() > key);
	});

	it('a read handle promoted to a write after the floor passed its key takes a fresh key', async () => {
		let readKey;
		let floorAfterRead;
		await transaction({}, async (txn) => {
			await Tbl.get('promoted');
			readKey = txn.getReadTxn().getTimestamp();
			await sleep(2);
			floorAfterRead = certify();
			assert(floorAfterRead > readKey, 'a read handle holds nothing');
			await Tbl.put({ id: 'promoted', n: 1 });
		});
		const [entry] = entriesFor('promoted');
		assert(entry.txnLogKey >= floorAfterRead, `key ${entry.txnLogKey} below floor ${floorAfterRead}`);
		assert.notEqual(entry.txnLogKey, readKey);
	});

	it('an explicit timestamp below the floor keeps the record version and takes a fresh key', async () => {
		await sleep(2);
		const floor = certify();
		const timestamp = floor - 1000;
		await transaction({ timestamp }, () => Tbl.put({ id: 'explicit-old', n: 1 }));
		const [entry] = entriesFor('explicit-old');
		assert.equal(entry.version, timestamp, 'the explicit value stays the record version');
		assert.equal(Tbl.primaryStore.getEntry('explicit-old').version, timestamp);
		assert(entry.txnLogKey >= floor, `key ${entry.txnLogKey} below floor ${floor}`);
		assert(
			Tbl.primaryStore.getEntry('explicit-old').additionalAuditRefs?.some((ref) => ref.version === entry.txnLogKey),
			'the record points at its audit head by log key'
		);
		const future = floor + 60_000;
		await transaction({ timestamp: future }, () => Tbl.put({ id: 'explicit-new', n: 1 }));
		const [kept] = entriesFor('explicit-new');
		assert.equal(kept.txnLogKey, future, 'an explicit timestamp above the floor is kept as the key');
		assert.equal(kept.version, future);
	});

	it('a source apply for a named remote origin keeps its key in that origin log, an unnamed id does not', async () => {
		await sleep(2);
		const floor = certify();
		const peerId = getIdOfRemoteNode('floor-peer', auditStore);
		const applyFrom = (id, nodeId, logKey) => {
			const context = { source: {}, sourceApply: true, timestamp: logKey };
			return transaction(context, async () => {
				const resource = await Tbl.getResource(id, context);
				return resource._writeUpdate(id, { id, n: 1 }, true, { isNotification: true, nodeId, version: logKey });
			});
		};
		const remoteKey = floor - 5000;
		await applyFrom('from-peer', peerId, remoteKey);
		const [remote] = entriesFor('from-peer', peerId);
		assert.equal(remote.txnLogKey, remoteKey, "the origin's key is kept below this node's floor");
		assert.equal(entriesFor('from-peer', 0).length, 0, 'nothing was appended to local');
		const unnamedKey = floor - 4000;
		await applyFrom('from-unnamed', 999, unnamedKey);
		const [local] = entriesFor('from-unnamed', 0);
		assert(local.txnLogKey >= floor, `local-resolved apply keyed at ${local.txnLogKey} below ${floor}`);
		assert.equal(local.version, unnamedKey, 'the applied record version is kept');
	});

	it('a commit that fails for good releases its reservation', async () => {
		const nativeCommit = Transaction.prototype.commit;
		let reservedKey;
		Transaction.prototype.commit = function () {
			reservedKey = this.getTimestamp();
			Transaction.prototype.commit = nativeCommit;
			this.abort();
			const error = new Error('disk on fire');
			error.code = 'ERR_TEST_TERMINAL';
			return Promise.reject(error);
		};
		try {
			await assert.rejects(
				transaction({}, () => Tbl.put({ id: 'failed', n: 1 })),
				/disk on fire/
			);
		} finally {
			Transaction.prototype.commit = nativeCommit;
		}
		assert(reservedKey > 0);
		await sleep(2);
		assert(certify() > reservedKey, 'the floor advances once the handle is gone');
	});

	it('a raw native handle cannot append to local without a reservation', () => {
		const record = {
			type: 'evict',
			tableId: Tbl.tableId,
			recordId: 'raw',
			version: 1,
			nodeId: 0,
			extendedType: LOCAL_ONLY,
		};
		const unreserved = new Transaction(Tbl.primaryStore.store);
		try {
			assert.throws(
				() => auditStore.put(null, record, { transaction: unreserved, nodeId: 0 }),
				/without an origin-floor reservation/
			);
		} finally {
			unreserved.abort();
		}
		const reserved = new Transaction(Tbl.primaryStore.store);
		try {
			reserveLocalKey(rootStore, reserved);
			auditStore.put(null, record, { transaction: reserved, nodeId: 0 });
		} finally {
			releaseLocalKey(reserved);
			reserved.abort();
		}
	});

	it('a concurrent writer never appends below a floor published before its commit', async () => {
		const epoch = new Int32Array(new SharedArrayBuffer(4));
		const { next } = startWorker({ mode: 'writer', epoch, tableName, writes: 150 });
		await next('ready');
		const floors = [0];
		const done = next('done');
		let finished = false;
		done.then(() => (finished = true));
		while (!finished) {
			floors.push(certify());
			Atomics.store(epoch, 0, floors.length - 1);
			await sleep(1);
		}
		const { results } = await done;
		assert.equal(results.length, 150);
		for (const { key, epochBefore } of results) {
			assert(key >= floors[epochBefore], `key ${key} below floor ${floors[epochBefore]} published before its commit`);
		}
	});

	it('retires the bound of a worker that exits with a reserved key, once main has seen it exit', async () => {
		const { next, exited } = startWorker({ mode: 'exit', tableName });
		await next('ready');
		const { key, threadId } = await next('reserved');
		await exited;
		retireOriginFloorSlots(threadId);
		await sleep(2);
		assert(certify() > key, 'a dead worker holds nothing');
	});

	it('main retires the bound of a worker it terminates', async () => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { worker, next, exited } = startWorker({ mode: 'park', gate, tableName });
		await next('ready');
		const { key, threadId } = await next('reserved');
		await sleep(2);
		assert(certify() <= key, 'the parked worker holds the floor');
		await worker.terminate();
		await exited;
		retireOriginFloorSlots(threadId);
		await sleep(2);
		assert(certify() > key, 'the terminated worker holds nothing once retired');
	});

	it('after a restart behind the persisted floor every key is unique and at or above it', async () => {
		// Far enough ahead that the writes below run behind it, close enough that the shared test
		// database is back on the clock before the next file (the ratchet is process-wide state).
		const persisted = rootStore.getMonotonicTimestamp() + 250;
		persistOriginClosedFloor(auditStore, persisted);
		publishOriginFloor(rootStore, readOriginClosedFloor(auditStore));
		assert.equal(getOriginClosedFloor(rootStore).floor, persisted);
		const epoch = new Int32Array(new SharedArrayBuffer(4));
		const { next } = startWorker({ mode: 'writer', epoch, tableName, writes: 40 });
		await next('ready');
		const keys = [];
		for (let n = 0; n < 40; n++) {
			await Tbl.put({ id: `restart-${n}`, n });
			keys.push(Tbl.primaryStore.getEntry(`restart-${n}`).version);
		}
		const { results } = await next('done');
		for (const { key } of results) keys.push(key);
		for (const key of keys) assert(key >= persisted, `key ${key} below the recovered floor ${persisted}`);
		assert.equal(new Set(keys).size, keys.length, 'keys issued through the ratchet are unique across threads');
		assert(certify() >= persisted, 'certification resumes from the recovered floor');
		while (rootStore.getMonotonicTimestamp() <= persisted) await sleep(10);
	});
});
