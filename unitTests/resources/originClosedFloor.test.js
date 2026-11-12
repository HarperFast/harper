require('../testUtils');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PID_DIR_PATH } = require('../perPidRoot');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { Worker } = require('node:worker_threads');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { Transaction, RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();
const {
	HEADER_WORDS,
	WORD_INITIAL_CEILING,
	WORD_PROPOSED,
	WORD_PUBLISHED,
	WORD_ISSUANCE_FLOOR,
	WORD_SLOT_LIMIT,
	WORD_COVERED,
	WORD_DURABLE_CEILING,
	WORD_WRITE_FENCE,
	certifyOriginFloor,
	claimLocalKey,
	freshLocalKey,
	forgetOriginFloorRegistry,
	localIssuanceFloor,
	localIssuedAheadThrough,
	getOriginClosedFloor,
	localStartBound,
	publishOriginFloor,
	reserveLocalKey,
	releaseLocalKey,
	retireOriginFloorSlots,
	seedLocalIssuance,
	setLocalWriteFence,
	localWritesFenced,
	restoreLocalWriteFence,
	rekeyLocalRetry,
	timestampAbove,
} = require('#src/resources/originClosedFloor');
const {
	persistOriginClosedFloor,
	readOriginClosedFloor,
	coverLocalIssuance,
	readLocalIssuanceCeiling,
	LOCAL_ONLY,
} = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('origin-closed timestamp floor (harper-pro#922)', function () {
	this.timeout(60_000);
	let Tbl, rootStore, auditStore;
	const tableName = 'OriginFloorTable';
	const workers = new Map(); // worker -> its thread id, which reads -1 once it has exited

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
		for (const [worker, threadId] of workers) {
			await worker.terminate();
			// a worker a failed test left parked mid-reservation would otherwise stall every later certification
			retireOriginFloorSlots(threadId);
		}
		workers.clear();
	});

	function certify() {
		let floor = certifyOriginFloor(rootStore);
		for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
		if (floor) {
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
		workers.set(worker, worker.threadId);
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

	const releaseGate = (gate) => {
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
	};
	const startsAtOrBelow = (start, key) => ('atOrAbove' in start ? start.atOrAbove <= key : start.above < key);

	it('keeps every header word distinct and below HEADER_WORDS', () => {
		const headerWords = [
			WORD_PROPOSED,
			WORD_PUBLISHED,
			WORD_ISSUANCE_FLOOR,
			WORD_COVERED,
			WORD_INITIAL_CEILING,
			WORD_SLOT_LIMIT,
			WORD_DURABLE_CEILING,
			WORD_WRITE_FENCE,
		];
		assert.strictEqual(new Set(headerWords).size, headerWords.length, 'header word indices must be distinct');
		for (const word of headerWords) {
			assert(
				Number.isInteger(word) && word >= 0 && word < HEADER_WORDS,
				`header word ${word} must be in [0, ${HEADER_WORDS})`
			);
		}
	});

	it('refuses a shared buffer of another layout rather than misreading its slots', () => {
		const rootStore = {
			status: 'open',
			getUserSharedBuffer: () => new ArrayBuffer((4 + 1024 + 1024 * 8) * 8),
			getMonotonicTimestamp: () => 1,
		};
		assert.throws(() => localStartBound(rootStore), /another layout/);
	});

	it('a registration sample takes the bound a thread mid-reservation carries; certification waits (worker thread)', async () => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { next, exited } = startWorker({ mode: 'park-reserving', gate, tableName });
		await next('ready');
		await next('parked');
		const start = localStartBound(rootStore);
		assert(start, 'a pending reservation leaves the sample a bound');
		for (let round = 0; round < 3; round++)
			assert.strictEqual(certifyOriginFloor(rootStore), null, 'no floor while a key is undecided');
		releaseGate(gate);
		await next('committed');
		await exited;
		const [entry] = entriesFor('parked-reserving');
		assert(startsAtOrBelow(start, entry.txnLogKey), `start ${JSON.stringify(start)} above ${entry.txnLogKey}`);
	});

	it('a registration sample stays at or below a key decided before it but not yet settled (worker thread)', async () => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { next, exited } = startWorker({
			mode: 'park-rekeying',
			gate,
			tableName,
			record: { id: 'parked-rekeying', n: 1 },
		});
		await next('ready');
		await next('parked');
		await sleep(2);
		const start = localStartBound(rootStore);
		releaseGate(gate);
		await next('committed');
		await exited;
		const [entry] = entriesFor('parked-rekeying');
		assert(startsAtOrBelow(start, entry.txnLogKey), `start ${JSON.stringify(start)} above ${entry.txnLogKey}`);
	});

	it('a thread mid-reservation still bounds the start at its outstanding key, below a newer sample (worker thread)', async () => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { worker, next, exited } = startWorker({ mode: 'hold-then-park-reserving', gate, tableName });
		await next('ready');
		await next('held');
		await sleep(2);
		localStartBound(rootStore); // raises `proposed` above the held key
		worker.postMessage('park');
		await next('parked');
		const start = localStartBound(rootStore);
		releaseGate(gate);
		await next('committed');
		await exited;
		const [held] = entriesFor('held-outstanding');
		assert(startsAtOrBelow(start, held.txnLogKey), `start ${JSON.stringify(start)} above held ${held.txnLogKey}`);
	});

	it('a thread terminated mid-reservation bounds the start until its slot is retired (worker thread)', async () => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { worker, next } = startWorker({
			mode: 'park-reserving',
			gate,
			tableName,
			record: { id: 'terminated-reserving', n: 1 },
		});
		const { threadId } = await next('ready');
		await next('parked');
		await worker.terminate();
		const before = certify();
		assert(localStartBound(rootStore), 'the pending word of a dead thread still yields a bound');
		assert.strictEqual(certifyOriginFloor(rootStore), null, 'certification waits for the retirement');
		retireOriginFloorSlots(threadId);
		await sleep(2);
		assert(certify() > before, 'the floor advances once the slot is retired');
		assert.strictEqual(entriesFor('terminated-reserving').length, 0);
	});

	it('a slot still being claimed constrains nothing', () => {
		// buffer layout from originClosedFloor.ts: 8 header words (the slot limit is word 5), 1024 owner words, then
		// one bound per 8 words
		const words = new BigInt64Array(rootStore.getUserSharedBuffer('origin-closed-floor', new ArrayBuffer(0)));
		let slot = 1023;
		while (Atomics.load(words, 8 + slot) !== 0n || Atomics.load(words, 8 + 1024 + slot * 8) !== 0n) slot--;
		const limitBefore = Atomics.load(words, 5);
		Atomics.store(words, 8 + slot, 1n << 30n);
		Atomics.store(words, 5, BigInt(slot + 1));
		try {
			const start = localStartBound(rootStore);
			const bound = 'atOrAbove' in start ? start.atOrAbove : start.above;
			assert(bound > 0 && bound < Infinity, `a claim in progress must not reach the start: ${bound}`);
			assert.strictEqual(certifyOriginFloor(rootStore), null, 'certification still waits for the claimer');
		} finally {
			Atomics.store(words, 8 + slot, 0n);
			Atomics.store(words, 5, limitBefore);
		}
	});

	it('a scan reaches a slot another thread claimed: the slot limit is raised with the claim (worker thread)', async () => {
		await Tbl.put({ id: 'main-slot', n: 1 }); // main owns a slot first, so the worker's is a later one
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { next } = startWorker({ mode: 'park', gate, tableName });
		const { threadId: workerThreadId } = await next('ready');
		const { key } = await next('reserved');
		const words = new BigInt64Array(rootStore.getUserSharedBuffer('origin-closed-floor', new ArrayBuffer(0)));
		let workerSlot = -1;
		for (let slot = 0; slot < 1024; slot++)
			if (Atomics.load(words, 8 + slot) === BigInt(workerThreadId + 1)) workerSlot = slot;
		assert(workerSlot > 0, `the worker's slot ${workerSlot} is not a later one`);
		const limit = Number(Atomics.load(words, 5));
		assert(limit > workerSlot, `the slot limit ${limit} does not cover the worker's slot ${workerSlot}`);
		assert(startsAtOrBelow(localStartBound(rootStore), key), "the worker's parked key is below the start");
	});

	it('advances and persists on an idle database', async () => {
		const first = certify();
		assert(first > 0, 'the floor is established without any write');
		await sleep(2);
		const second = certify();
		assert(second > first, 'the floor follows the clock while nothing is outstanding');
		assert.equal(readOriginClosedFloor(auditStore), second, 'the advertised floor is the persisted one');
		assert(second <= rootStore.getMonotonicTimestamp(), 'the floor never runs ahead of the clock');
	});

	it('a write fence refuses a new local write, admits a transaction that already reserved, and sets a target above it', async () => {
		let target;
		try {
			await transaction({}, async () => {
				await Tbl.put({ id: 'fence-admitted', n: 1 });
				target = setLocalWriteFence(rootStore, true);
				await Tbl.put({ id: 'fence-admitted-2', n: 2 });
			});
			assert(localWritesFenced(rootStore));
			const [entry] = entriesFor('fence-admitted');
			assert(entry, 'the transaction that reserved before the fence committed');
			assert(entry.txnLogKey < target, `admitted key ${entry.txnLogKey} is below the target ${target}`);
			assert.equal(entriesFor('fence-admitted-2')[0]?.txnLogKey, entry.txnLogKey);
			await assert.rejects(
				async () => Tbl.put({ id: 'fence-refused', n: 3 }),
				(error) => {
					assert.equal(error.statusCode, 503);
					assert.match(error.message, /being removed from its cluster/);
					return true;
				}
			);
			assert.equal(entriesFor('fence-refused').length, 0);
			await sleep(2);
			assert(certify() >= target, 'the floor reaches the target once the admitted transaction has settled');
		} finally {
			setLocalWriteFence(rootStore, false);
		}
		assert(!localWritesFenced(rootStore));
		await Tbl.put({ id: 'fence-cleared', n: 4 });
		assert.equal(entriesFor('fence-cleared').length, 1);
	});

	it('a reservation the fence lands during is released and refused (worker thread)', async () => {
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const { next } = startWorker({ mode: 'park-reserving', gate, tableName, record: { id: 'fence-raced', n: 1 } });
		await next('ready');
		await next('parked');
		const target = setLocalWriteFence(rootStore, true);
		try {
			releaseGate(gate);
			await assert.rejects(next('committed'), /being removed from its cluster/);
			assert.equal(entriesFor('fence-raced').length, 0);
			await sleep(2);
			assert(certify() >= target, 'the refused reservation released its bound');
		} finally {
			setLocalWriteFence(rootStore, false);
		}
	});

	it('a retry re-keyed above the target holds the floor below it until it settles, so a floor at the target covers it', async () => {
		const handle = new Transaction(Tbl.primaryStore.store);
		const key = reserveLocalKey(rootStore, handle);
		let target;
		try {
			target = setLocalWriteFence(rootStore, true);
			const retried = rekeyLocalRetry(handle);
			assert(retried > target, `the retry key ${retried} is above the target ${target}`);
			await sleep(2);
			assert(certify() <= key, 'the original bound holds the floor');
			rootStore.useLog('local').addEntry(Buffer.from('fence-retried'), handle.id);
			handle.commitSync();
			releaseLocalKey(handle);
			await sleep(2);
			const floor = certify();
			assert(floor >= target && floor > retried, `floor ${floor} covers the retried key ${retried}`);
		} finally {
			setLocalWriteFence(rootStore, false);
		}
	});

	it('refuses a write fence on a store without a durable origin floor, where it would refuse nothing', () => {
		assert.throws(() => setLocalWriteFence({ getMonotonicTimestamp: () => 1 }, true), /needs a RocksDB database/);
	});

	it('a restore from a record read before a cancellation does not undo it', () => {
		assert(!localWritesFenced(rootStore));
		restoreLocalWriteFence(rootStore, () => {
			setLocalWriteFence(rootStore, true);
			setLocalWriteFence(rootStore, false);
			return true;
		});
		assert(!localWritesFenced(rootStore), 'a cancel during the read stands');
		restoreLocalWriteFence(rootStore, () => true);
		assert(localWritesFenced(rootStore));
		setLocalWriteFence(rootStore, false);
		assert(!localWritesFenced(rootStore));
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
		await transaction({ timestamp: floor - 10_000 }, () => Tbl.put({ id: 'floor-counter', n: 0 }));
		const version = floor - 6000;
		const deliver = () =>
			transaction({ source: {}, sourceApply: true, timestamp: version }, () =>
				Tbl.patch('floor-counter', { n: { __op__: 'add', value: 1 } })
			);
		await deliver();
		assert.equal((await Tbl.get('floor-counter')).n, 1);
		const [, first] = entriesFor('floor-counter');
		assert(first.txnLogKey >= floor && first.version === version, 'the first delivery was rekeyed above the floor');
		await deliver();
		assert.equal((await Tbl.get('floor-counter')).n, 1, 'the re-delivery of a rekeyed apply is not applied twice');
		assert.equal(entriesFor('floor-counter').length, 2);
		assert(
			Tbl.primaryStore.getEntry('floor-counter').receivedIdentityRefs?.some((ref) => ref.version === version),
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

	it('an explicit timestamp, below or above the floor, keeps the record version and takes a minted key', async () => {
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
		const [ahead] = entriesFor('explicit-new');
		assert.equal(ahead.version, future, 'an explicit timestamp above the floor is the record version too');
		assert(
			ahead.txnLogKey >= floor && ahead.txnLogKey < future,
			`key ${ahead.txnLogKey} is minted between the floor and the explicit value`
		);
		assert.equal(Tbl.primaryStore.getEntry('explicit-new').version, future);
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

	it('raises neither the clock nor the issuance floor when claim coverage fails', () => {
		seedLocalIssuance(rootStore, readLocalIssuanceCeiling(auditStore), () => {
			throw new Error('simulated ceiling write failure');
		});
		const before = localIssuanceFloor(rootStore);
		const aheadBefore = localIssuedAheadThrough(rootStore);
		const floor = Math.max(rootStore.getMonotonicTimestamp(), aheadBefore, readLocalIssuanceCeiling(auditStore)) + 100;
		try {
			assert.throws(() => claimLocalKey(rootStore, floor), /simulated ceiling write failure/);
			assert.equal(localIssuanceFloor(rootStore), before);
			assert.equal(localIssuedAheadThrough(rootStore), aheadBefore, 'a hold step does not treat the floor as issued');
			assert(rootStore.getMonotonicTimestamp() < floor, 'an uncovered claim must not raise the clock');
		} finally {
			seedLocalIssuance(rootStore, readLocalIssuanceCeiling(auditStore), (key) => coverLocalIssuance(auditStore, key));
		}
	});

	for (const ahead of [true, false]) {
		it(`a handle minted before a claim ${ahead ? 'ahead of' : 'behind'} the clock reserves above it`, async () => {
			const id = `pre-claim-${ahead}`;
			let handleKey;
			let floor;
			await transaction({}, async (txn) => {
				await Tbl.get(id);
				handleKey = txn.getReadTxn().getTimestamp();
				floor = ahead ? rootStore.getMonotonicTimestamp() + 200 : timestampAbove(handleKey);
				assert(claimLocalKey(rootStore, floor) >= floor);
				await Tbl.put({ id, n: 1 });
			});
			const [entry] = entriesFor(id);
			assert(entry.txnLogKey >= floor, `key ${entry.txnLogKey} below the claim ${floor}`);
			assert.notEqual(entry.txnLogKey, handleKey);
			await waitFor(() => rootStore.getMonotonicTimestamp() > readLocalIssuanceCeiling(auditStore), 30_000);
		});
	}

	it("covers a key another database's claim lifted, though a wall reading taken during a clock glitch was ahead", async () => {
		const Other = table({
			table: 'OriginFloorOther',
			database: 'originFloorOther',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		await sleep(2);
		const realNow = Date.now;
		Date.now = () => realNow() + 3_600_000;
		try {
			await Tbl.put({ id: 'glitch-warm', n: 0 });
		} finally {
			Date.now = realNow;
		}
		const claimed = claimLocalKey(Other.primaryStore.rootStore, rootStore.getMonotonicTimestamp() + 200);
		await Tbl.put({ id: 'glitch-lifted', n: 1 });
		const [entry] = entriesFor('glitch-lifted');
		assert(entry.txnLogKey > claimed, "the other database's claim lifted this key");
		assert(readLocalIssuanceCeiling(auditStore) >= entry.txnLogKey, "this database's ceiling covers it");
		await waitFor(() => Date.now() > readLocalIssuanceCeiling(Other.auditStore) + 1, 30_000, 20);
	});

	it('claims at one floor ahead of the clock are unique, and every later local key is above them', async () => {
		const floor = rootStore.getMonotonicTimestamp() + 250;
		const claims = [claimLocalKey(rootStore, floor), claimLocalKey(rootStore, floor), claimLocalKey(rootStore, floor)];
		for (const claim of claims) assert(claim >= floor, `claim ${claim} below its floor ${floor}`);
		assert.equal(new Set(claims).size, claims.length, 'no two claims share a key');
		await transaction(() => Tbl.put({ id: 'after-claims', n: 1 }));
		const [entry] = entriesFor('after-claims');
		assert(entry.txnLogKey > Math.max(...claims), 'a later local key is above every claim');
		assert(
			readLocalIssuanceCeiling(auditStore) > entry.txnLogKey,
			'every claim and later key is covered for a restart'
		);
		await waitFor(() => rootStore.getMonotonicTimestamp() > readLocalIssuanceCeiling(auditStore), 30_000);
	});

	it('fresh and fully reopened registries issue above their recovered ceilings', async () => {
		const directory = fs.mkdtempSync(path.join(PID_DIR_PATH, 'issuance-seed-'));
		let recoveredRoot = RocksDatabase.open(directory);
		let raisedTo = 0;
		try {
			const recoveredAudit = new RocksTransactionLogStore(recoveredRoot);
			const ceiling = coverLocalIssuance(recoveredAudit, Date.now() + 200);
			seedLocalIssuance(recoveredRoot, ceiling, (key) => coverLocalIssuance(recoveredAudit, key));
			const key = freshLocalKey(recoveredRoot);
			assert.ok(key > ceiling, 'the first key after the open-time seed is above the ceiling');
			assert.ok(readLocalIssuanceCeiling(recoveredAudit) > key, 'a future key is covered before publication');
			const latestCeiling = readLocalIssuanceCeiling(recoveredAudit);
			raisedTo = latestCeiling;
			forgetOriginFloorRegistry(recoveredRoot);
			recoveredRoot.close();
			recoveredRoot = RocksDatabase.open(directory);
			const reopenedAudit = new RocksTransactionLogStore(recoveredRoot);
			seedLocalIssuance(recoveredRoot, readLocalIssuanceCeiling(reopenedAudit), (next) =>
				coverLocalIssuance(reopenedAudit, next)
			);
			assert.ok(freshLocalKey(recoveredRoot) > latestCeiling, 'full close must discard the old recovery snapshot');
		} finally {
			forgetOriginFloorRegistry(recoveredRoot);
			recoveredRoot.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
		// the raise is process-wide
		await waitFor(() => Date.now() > raisedTo + 1, 10_000, 20);
	});

	it('issuance behind a persisted floor (simulated in-process) yields unique keys at or above it', async () => {
		// Far enough ahead that the writes below run behind it, close enough that the process is back on
		// the wall clock before the next file (the raise is process-wide).
		const persisted = rootStore.getMonotonicTimestamp() + 250;
		persistOriginClosedFloor(auditStore, persisted);
		seedLocalIssuance(
			rootStore,
			readLocalIssuanceCeiling(auditStore),
			(key) => coverLocalIssuance(auditStore, key),
			readOriginClosedFloor(auditStore)
		);
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
		assert.equal(new Set(keys).size, keys.length, 'keys are unique across threads');
		assert(certify() >= persisted, 'certification resumes from the recovered floor');
		const catchUpDeadline = Date.now() + 5000;
		while (rootStore.getMonotonicTimestamp() <= persisted) {
			assert(Date.now() < catchUpDeadline, 'monotonic clock did not catch up to recovered floor');
			await sleep(10);
		}
	});
});
