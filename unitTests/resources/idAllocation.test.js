require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { setNextEncoding, clearNextEncoding, METADATA } = require('#src/resources/RecordEncoder');
const { LOCAL_ONLY, ACTION_32_BIT } = require('#src/resources/auditStore');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const insert = require('#src/dataLayer/insert');
const { asBinary } = require('#src/resources/asBinary');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { waitFor } = require('../waitFor');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const ID_ALLOCATION = Symbol.for('id_allocation');
const MAX_IDS = 0x10000;
const THIRD_CLASSIC_STRUCTURE = 0x42;
const HEADER_SIZE = 12;

function readAllocation(store) {
	let value = store.encoder.decode(isLMDB ? store.getBinary(ID_ALLOCATION) : store.getBinarySync(ID_ALLOCATION));
	if (value?.[METADATA] !== undefined) value = value.value;
	assert(Number.isSafeInteger(value?.start) && Number.isSafeInteger(value.end), 'the stored allocation is unreadable');
	const { start, end, nodeName, pid } = value;
	return { start, end, nodeName, pid };
}

function writeAllocation(store, allocation) {
	if (isLMDB) return store.putSync(ID_ALLOCATION, allocation, Date.now());
	setNextEncoding(store.getMonotonicTimestamp(), LOCAL_ONLY);
	store.putSync(ID_ALLOCATION, allocation);
}

function writeLegacyAllocation(store, allocation) {
	clearNextEncoding();
	store.putSync(ID_ALLOCATION, allocation);
}

function writeUndecodableAllocation(store) {
	store.putSync(ID_ALLOCATION, asBinary(Buffer.from('42c1c1c1c1c1c1c1c1c1c1c1', 'hex')));
}

function sharedCounter(store) {
	return new BigInt64Array(store.getUserSharedBuffer('id', new ArrayBuffer(8)));
}

function getNewIdsUntil(IdTable, done) {
	for (let i = 0; i < MAX_IDS; i++) {
		const id = IdTable.getNewId();
		if (done(id)) return id;
	}
	assert.fail(`condition not reached within ${MAX_IDS} ids`);
}

function startIdThread(workerData) {
	const thread = new Worker(__dirname + '/fixtures/idAllocationThread.js', { workerData });
	const exited = once(thread, 'exit');
	exited.catch(() => {});
	return { thread, exited };
}

function nextMessage(thread) {
	return once(thread, 'message', { signal: AbortSignal.timeout(30_000) });
}

async function stopIdThreads(threads) {
	// as create.test.js: a graceful exit closes the worker's handles; terminate is the fallback
	await Promise.allSettled(
		threads.map(async ({ thread, exited }) => {
			const fallback = setTimeout(() => thread.terminate().catch(() => {}), 1000);
			thread.postMessage({ type: 'shutdown' });
			try {
				await exited;
			} finally {
				clearTimeout(fallback);
			}
		})
	);
}

// LMDB serializes write transactions, so a sibling commit cannot land inside this thread's allocation transaction.
describe('Auto-increment id allocation under concurrent allocation writes', function () {
	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
	});

	function makeIdTable(name, extraAttributes = []) {
		return table({
			table: name,
			database: 'test',
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'str', type: 'String' },
				...extraAttributes,
			],
		});
	}

	// After the compare's read and before its write, so only the commit's conflict check can show it the sibling.
	// The sibling's counter reset follows its commit, as in production.
	function siblingCommitsAfterNextCompareRead(store, sibling, siblingCounterStart) {
		const getBinarySync = store.getBinarySync;
		const state = { fired: false, compareReads: 0, firstRead: undefined };
		store.getBinarySync = function (key, options) {
			const bytes = getBinarySync.call(this, key, options);
			if (key === ID_ALLOCATION && options?.transaction) {
				state.compareReads++;
				if (!state.fired) {
					state.fired = true;
					state.firstRead = bytes && Buffer.from(bytes);
					writeAllocation(store, sibling);
					if (siblingCounterStart !== undefined) Atomics.store(sharedCounter(store), 0, BigInt(siblingCounterStart));
				}
			}
			return bytes;
		};
		return () => {
			store.getBinarySync = getBinarySync;
			return state;
		};
	}

	function assertAdoptedAfterRetry(store, state, displaced) {
		assert(state.fired, 'expected the allocation to be replaced');
		assert(state.compareReads >= 2, 'the compare did not retry after the sibling commit');
		let firstRead = store.decoder.decode(state.firstRead);
		if (firstRead?.[METADATA] !== undefined) firstRead = firstRead.value;
		assert.strictEqual(firstRead.end, displaced.end, 'the first compare read already saw the sibling');
	}

	it('adopts a sibling range committed while a new range is being allocated', async function () {
		const IdTable = makeIdTable('IdAllocationNewRange');
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		// an existing record just past the range forces the synchronous range check into a re-allocation
		await IdTable.put({ id: initial.end + 50, str: 'existing' });
		const siblingStart = initial.start < 1_000_000_000 ? 1_800_000_000 : 200_000_000;
		const sibling = { ...initial, start: siblingStart, end: siblingStart + 0x400 };
		const restore = siblingCommitsAfterNextCompareRead(store, sibling, sibling.start + 1);
		try {
			getNewIdsUntil(IdTable, () => readAllocation(store).start !== initial.start);
		} finally {
			assertAdoptedAfterRetry(store, restore(), initial);
		}
		assert.deepStrictEqual(readAllocation(store), sibling);
		const nextId = IdTable.getNewId();
		assert(nextId > sibling.start && nextId <= sibling.end, `id ${nextId} is outside the committed range`);
	});

	it('does not overwrite a sibling range extension committed during its own extension', function () {
		const IdTable = makeIdTable('IdAllocationExtend');
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		const sibling = { ...initial, end: initial.end + 0x10000 };
		const restore = siblingCommitsAfterNextCompareRead(store, sibling);
		try {
			getNewIdsUntil(IdTable, () => readAllocation(store).end !== initial.end);
		} finally {
			assertAdoptedAfterRetry(store, restore(), initial);
		}
		assert.deepStrictEqual(readAllocation(store), sibling);
	});

	it('compares the stored bounds when a resolver owns the name end', function () {
		const IdTable = makeIdTable('IdAllocationComputedEnd', [{ name: 'end', type: 'Int', computed: true }]);
		IdTable.setComputedAttribute('end', () => 7);
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		const sibling = { ...initial, end: initial.end + 0x10000 };
		const restore = siblingCommitsAfterNextCompareRead(store, sibling);
		try {
			getNewIdsUntil(IdTable, () => readAllocation(store).end !== initial.end);
		} finally {
			assertAdoptedAfterRetry(store, restore(), initial);
		}
		assert.deepStrictEqual(readAllocation(store), sibling);
	});

	it('bounds ids by a lower sibling range that won over its own extension', function () {
		const Probe = makeIdTable('IdAllocationIdentity');
		Probe.getNewId();
		const { nodeName, pid } = readAllocation(Probe.primaryStore);
		const IdTable = makeIdTable('IdAllocationExtendLost');
		const store = IdTable.primaryStore;
		const initial = { start: 1_800_000_000, end: 1_800_000_000 + 0x400, nodeName, pid };
		writeAllocation(store, initial);
		IdTable.getNewId();
		assert.deepStrictEqual(readAllocation(store), initial);
		const sibling = { start: 200_000_000, end: 200_000_000 + 0x400, nodeName, pid };
		const restore = siblingCommitsAfterNextCompareRead(store, sibling, sibling.start + 1);
		try {
			getNewIdsUntil(IdTable, () => readAllocation(store).start !== initial.start);
		} finally {
			assertAdoptedAfterRetry(store, restore(), initial);
		}
		assert.deepStrictEqual(readAllocation(store), sibling);
		getNewIdsUntil(IdTable, (id) => id >= sibling.end - 50);
		assert(readAllocation(store).end > sibling.end, 'ids approached the stored range end without extending it');
	});
});

// harper#1762. LMDB has no version header.
describe('Auto-increment id allocation as the third record structure', function () {
	const database = 'idAllocationStructure';
	let tableCount = 0;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	async function twoShapeTable(name = `TwoShapes${tableCount++}`) {
		const definition = {
			table: name,
			database,
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'a', type: 'String' },
				{ name: 'b', type: 'String' },
			],
		};
		const IdTable = table(definition);
		await IdTable.put({ id: 1, a: 'first shape' });
		await IdTable.put({ id: 2, b: 'second shape' });
		assert.strictEqual(IdTable.getStructureCounts().classic, 2, 'precondition: two record structures');
		return { IdTable, definition };
	}

	function assertAllocationIsStructure(store, position, message) {
		const bytes = store.getBinarySync(ID_ALLOCATION);
		assert.strictEqual(bytes[position], THIRD_CLASSIC_STRUCTURE, message);
	}

	function assertReadableAllocation(store) {
		const entry = store.getEntry(ID_ALLOCATION);
		assert(entry, 'the stored allocation does not read back');
		assert(Number.isSafeInteger(entry.value.start) && entry.value.end > entry.value.start, 'malformed allocation');
		assert.strictEqual(typeof entry.version, 'number', 'the allocation carries no version');
		if (!isLMDB) assert(entry.metadataFlags & LOCAL_ONLY, 'the allocation is not marked local-only');
		return entry.value;
	}

	async function insertWithoutIds(IdTable, count, prefix) {
		const records = [];
		for (let i = 0; i < count; i++) records.push({ a: `${prefix}${i}` });
		const result = await insert.insert({ operation: 'insert', database, table: IdTable.tableName, records });
		assert.strictEqual(result.inserted_hashes.length, count, 'not every record was inserted');
	}

	async function idsByPrefix(IdTable, expectedRows) {
		const ids = {};
		let count = 0;
		for await (const { id, a, b } of IdTable.search({})) {
			const prefix = (a ?? b).replace(/\d+$/, '');
			(ids[prefix] ??= []).push(id);
			count++;
		}
		assert.strictEqual(count, expectedRows, 'rows were lost or overwritten');
		return ids;
	}

	it('stores the range with a version header, local-only, outside the collection scan', async function () {
		if (isLMDB) return this.skip();
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		assert.strictEqual(
			IdTable.getStructureCounts().classic,
			3,
			'precondition: the allocation added the third structure'
		);
		assertAllocationIsStructure(store, HEADER_SIZE, 'the header is not in front of the structure id');
		assertReadableAllocation(store);
		// a collection subscription's snapshot clock reads the versions of the rows this range visits
		const scanned = Array.from(store.getRange({ start: false, versions: true }), (entry) => entry.key);
		assert(!scanned.includes(ID_ALLOCATION), 'a collection scan visits the allocation');
	});

	it('issues unique ids through post and the insert operation across extensions and a reopen', async function () {
		const { IdTable, definition } = await twoShapeTable('TwoShapesReopen');
		const store = IdTable.primaryStore;
		await IdTable.post({ a: 'first' });
		let written = 3;
		assertReadableAllocation(store);
		const initial = readAllocation(store);
		// Int ranges are 0x400 ids; the background extension is scheduled 0x200 before the end
		for (let i = 0; i < 0x280; i++, written++) await IdTable.post({ a: `post${i}` });
		await waitFor(() => readAllocation(store).end > initial.end, {
			message: 'the background extension was not stored',
		});
		await insertWithoutIds(IdTable, 1500, 'bulk');
		written += 1500;
		// drains a background extension the insert queued
		await new Promise((resolve) => setImmediate(resolve));
		assertReadableAllocation(store);
		const extended = readAllocation(store);
		assert.strictEqual(extended.start, initial.start, 'expected the range to be extended, not replaced');
		assert.ok(await closeDatabase(database));
		const Reopened = table(definition);
		assertReadableAllocation(Reopened.primaryStore);
		assert.deepStrictEqual(
			readAllocation(Reopened.primaryStore),
			extended,
			'the allocation did not survive the reopen'
		);
		await insertWithoutIds(Reopened, 1500, 'reopened');
		written += 1500;
		assert.strictEqual(readAllocation(Reopened.primaryStore).start, extended.start, 'the reopen took a new range');
		const ids = await idsByPrefix(Reopened, written);
		assert(Math.min(...ids.reopened) > Math.max(...ids.bulk), 'the reopened table reissued ids below its last ones');
	});

	it('continues a header-less range a build before #1762 wrote, and stores it with the header', async function () {
		if (isLMDB) return this.skip();
		const probe = await twoShapeTable();
		probe.IdTable.getNewId();
		const { nodeName, pid } = readAllocation(probe.IdTable.primaryStore);
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		const legacy = { start: 1_000_000_000, end: 1_000_000_000 + 0x400, nodeName, pid };
		writeLegacyAllocation(store, legacy);
		assertAllocationIsStructure(store, 0, 'precondition: the legacy allocation starts with the third structure id');
		assert.strictEqual(store.getEntry(ID_ALLOCATION), undefined, 'precondition: a record read cannot decode it');
		await insertWithoutIds(IdTable, 1500, 'continued');
		const ids = await idsByPrefix(IdTable, 1502);
		assert.strictEqual(Math.min(...ids.continued), legacy.start + 1, 'the legacy range was not continued');
		assertReadableAllocation(store);
		assert.strictEqual(readAllocation(store).start, legacy.start, 'the legacy range was replaced');
	});

	it('continues a header-less range whose ninth byte matches the header tag', async function () {
		if (isLMDB) return this.skip();
		const probe = await twoShapeTable();
		probe.IdTable.getNewId();
		const { nodeName, pid } = readAllocation(probe.IdTable.primaryStore);
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		// the end's second byte lands at offset 8, where a header carries its tag
		const legacy = { start: 0x3a0e0000, end: 0x3a0e0400, nodeName, pid };
		writeLegacyAllocation(store, legacy);
		assert.strictEqual(store.getBinarySync(ID_ALLOCATION)[8], ACTION_32_BIT, 'precondition: byte 8 is the header tag');
		await insertWithoutIds(IdTable, 10, 'continued');
		const ids = await idsByPrefix(IdTable, 12);
		assert.strictEqual(Math.min(...ids.continued), legacy.start + 1, 'the legacy range was not continued');
	});

	it('stores an undecodable range from the live counter in a queued extension', async function () {
		if (isLMDB) return this.skip();
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		getNewIdsUntil(IdTable, (id) => id + 0x200 === initial.end);
		// a sibling thread issues past what an extension proposed from the id that queued it would cover
		Atomics.add(sharedCounter(store), 0, 0x500n);
		writeUndecodableAllocation(store);
		await new Promise((resolve) => setImmediate(resolve));
		const issuedThrough = Number(sharedCounter(store)[0]) - 1;
		assertReadableAllocation(store);
		assert(readAllocation(store).end > issuedThrough, 'the stored range ends below issued ids');
	});

	it('keeps the stored bound when a queued extension fails, and extends synchronously', async function () {
		if (isLMDB) return this.skip();
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		const transactionSync = store.transactionSync;
		store.transactionSync = function () {
			store.transactionSync = transactionSync;
			throw new Error('simulated storage failure');
		};
		getNewIdsUntil(IdTable, (id) => id + 0x200 === initial.end);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(store.transactionSync, transactionSync, 'precondition: the queued extension ran');
		assert.deepStrictEqual(readAllocation(store), initial, 'precondition: nothing was stored');
		getNewIdsUntil(IdTable, (id) => id + 100 >= initial.end);
		assert(readAllocation(store).end > initial.end, 'ids passed the stored end without extending it');
	});

	it('does not take the end of a stored range that does not hold the counter', async function () {
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		const other = { ...initial, start: initial.end + 0x10000, end: initial.end + 0x10400 };
		writeAllocation(store, other);
		const lastId = getNewIdsUntil(IdTable, (id) => id + 100 >= initial.end);
		const stored = readAllocation(store);
		assert(stored.start <= lastId + 1 && stored.end > lastId, 'the stored range does not hold the ids issued');
	});

	it('does not issue a stored id below a longer stored end it takes', async function () {
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		// a sibling stored a far end, and a row lies past what this thread's queued extension proposes
		writeAllocation(store, { ...initial, end: initial.end + 0x10000 });
		const storedId = initial.end + 0x300;
		await IdTable.put({ id: storedId, a: 'stored' });
		getNewIdsUntil(IdTable, (id) => id + 0x200 === initial.end);
		await new Promise((resolve) => setImmediate(resolve));
		getNewIdsUntil(IdTable, (id) => {
			assert.notStrictEqual(id, storedId, 'the stored id was issued');
			return id > storedId || readAllocation(store).start !== initial.start;
		});
		assert.strictEqual((await IdTable.get(storedId)).a, 'stored');
	});

	it('issues unique ids after a clear, and a reopen continues above them', async function () {
		const { IdTable, definition } = await twoShapeTable('TwoShapesClear');
		await IdTable.post({ a: 'before the clear' });
		await IdTable.clear();
		// the clear removes the stored range; Int ranges are 0x400 ids, so these reach the extension that stores it again
		for (let i = 0; i < 0x400; i++) await IdTable.post({ a: `cleared${i}` });
		assertReadableAllocation(IdTable.primaryStore);
		assert.ok(await closeDatabase(database));
		const Reopened = table(definition);
		for (let i = 0; i < 0x10; i++) await Reopened.post({ a: `reopened${i}` });
		const ids = await idsByPrefix(Reopened, 0x410);
		assert(Math.min(...ids.reopened) > Math.max(...ids.cleared), 'the reopen reissued ids below the last ones');
	});

	it('stores a missing range again from the live counter', async function () {
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		await IdTable.post({ a: 'before the removal' });
		store.removeSync(ID_ALLOCATION);
		for (let i = 0; i < 0x400; i++) await IdTable.post({ a: `after${i}` });
		assertReadableAllocation(store);
		let count = 0;
		for await (const _record of IdTable.search({})) count++;
		assert.strictEqual(count, 0x403, 'rows were lost or overwritten');
	});

	it('continues the live counter in a thread whose first id finds no stored range', async function () {
		const probe = await twoShapeTable();
		probe.IdTable.getNewId();
		const { nodeName, pid } = readAllocation(probe.IdTable.primaryStore);
		const { IdTable, definition } = await twoShapeTable();
		const store = IdTable.primaryStore;
		// low in the id space, so a new random range almost never covers the counter
		writeAllocation(store, { start: 1000, end: 1000 + 0x400, nodeName, pid });
		for (let i = 0; i < 10; i++) await IdTable.post({ a: `before${i}` });
		store.removeSync(ID_ALLOCATION);
		const liveId = Number(sharedCounter(store)[0]);
		const worker = startIdThread({ definition });
		try {
			const reply = nextMessage(worker.thread);
			worker.thread.postMessage({ type: 'newId' });
			const [{ id, start, end, error }] = await reply;
			assert.strictEqual(error, undefined, `the thread failed to take an id: ${error}`);
			assert.strictEqual(id, liveId, 'the thread did not continue the live counter');
			assert(start <= id + 1 && end > id, `the stored range [${start}, ${end}] does not cover id ${id}`);
		} finally {
			await stopIdThreads([worker]);
		}
	});

	it('stores the range in use again when the stored allocation cannot be decoded mid-range', async function () {
		if (isLMDB) return this.skip();
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		const firstId = IdTable.getNewId();
		assertReadableAllocation(store);
		const initial = readAllocation(store);
		writeUndecodableAllocation(store);
		assert.strictEqual(store.getEntry(ID_ALLOCATION), undefined, 'precondition: the allocation is unreadable');
		const ids = [firstId];
		for (let i = 0; i < 0x400; i++) ids.push(IdTable.getNewId());
		assert.deepStrictEqual(
			ids,
			ids.map((_, i) => firstId + i),
			'the ids did not continue in sequence'
		);
		await new Promise((resolve) => setImmediate(resolve));
		assertReadableAllocation(store);
		const stored = readAllocation(store);
		assert(stored.start > initial.start && stored.start < initial.end, 'expected the range in use to be stored');
		assert(stored.end > initial.end, 'expected the range to be extended');
	});
});

// harper#4609: the range write is not write-ahead logged (#4606), so a hard kill can lose the newest range end while
// the transaction log replays the rows issued under it. These tables start in that state, before the allocator runs.
describe('Auto-increment ids after a restart whose stored range ends below stored rows', function () {
	const database = 'idAllocationStaleEnd';
	let identity;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		const Probe = table({
			table: 'StaleEndProbe',
			database,
			attributes: [{ name: 'id', type: 'Int', isPrimaryKey: true }],
		});
		Probe.getNewId();
		const { nodeName, pid } = readAllocation(Probe.primaryStore);
		identity = { nodeName, pid };
	});

	async function staleEndTable(name, rowsPastEnd) {
		const definition = {
			table: name,
			database,
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'a', type: 'String' },
			],
		};
		const IdTable = table(definition);
		const store = IdTable.primaryStore;
		const range = { start: 1000, end: 1000 + 0x400, ...identity };
		writeAllocation(store, range);
		const storedIds = [];
		for (let id = range.end; id <= range.end + rowsPastEnd; id++) {
			await IdTable.put({ id, a: `stored${id}` });
			storedIds.push(id);
		}
		assert.deepStrictEqual(readAllocation(store), range, 'precondition: the range ends below stored rows');
		assert.strictEqual(Atomics.load(sharedCounter(store), 0), 0n, 'precondition: no thread has started the allocator');
		return { IdTable, definition, range, storedIds };
	}

	async function assertStoredRowsKept(IdTable, storedIds) {
		for (const id of storedIds) {
			assert.strictEqual((await IdTable.get(id))?.a, `stored${id}`, `the row at ${id} was replaced`);
		}
	}

	it('issues no stored id to threads that start the allocator together', async function () {
		const { IdTable, definition, storedIds } = await staleEndTable('StaleEndThreads', 40);
		const threads = [];
		try {
			for (let i = 0; i < 3; i++) threads.push(startIdThread({ definition, announceReady: true }));
			await Promise.all(threads.map(({ thread }) => nextMessage(thread)));
			const replies = Promise.allSettled(threads.map(({ thread }) => nextMessage(thread)));
			for (const { thread } of threads) thread.postMessage({ type: 'newId' });
			const ids = [IdTable.getNewId()];
			for (const result of await replies) {
				assert.strictEqual(result.status, 'fulfilled', `a thread did not answer: ${result.reason}`);
				const [{ id, error }] = result.value;
				assert.strictEqual(error, undefined, `a thread failed to take an id: ${error}`);
				ids.push(id);
			}
			for (const id of ids) assert(!storedIds.includes(id), `id ${id} is already stored`);
			assert.strictEqual(new Set(ids).size, ids.length, `an id was issued twice: ${ids}`);
		} finally {
			await stopIdThreads(threads);
		}
		await assertStoredRowsKept(IdTable, storedIds);
	});

	it('keeps a stored row when a loadAsInstance=false collection POST takes the first id', async function () {
		const { IdTable, range, storedIds } = await staleEndTable('StaleEndStaticPost', 1);
		class StaticIdTable extends IdTable {
			static loadAsInstance = false;
		}
		const id = await StaticIdTable.post(new RequestTarget('/'), { a: 'posted' });
		await assertStoredRowsKept(IdTable, storedIds);
		assert.strictEqual(id, range.end + 2, 'the POST did not take the id after the stored rows');
		assert.strictEqual((await IdTable.get(id))?.a, 'posted');
		assert.strictEqual(readAllocation(IdTable.primaryStore).start, range.start, 'expected the range to be extended');
	});

	it('answers a default-resource POST that takes the first id with a new row, not a 409', async function () {
		const { IdTable, storedIds } = await staleEndTable('StaleEndPost', 1);
		const id = await IdTable.post({ a: 'posted' });
		assert(!storedIds.includes(id), `id ${id} is already stored`);
		await assertStoredRowsKept(IdTable, storedIds);
		assert.strictEqual((await IdTable.get(id))?.a, 'posted');
	});

	it('refuses with a 503 rather than issue a stored id, and recovers', async function () {
		const { IdTable, storedIds } = await staleEndTable('StaleEndExhausted', 1);
		const store = IdTable.primaryStore;
		const readMethod = isLMDB ? 'getBinary' : 'getBinarySync';
		const read = store[readMethod];
		store[readMethod] = function (key, options) {
			return typeof key === 'number' ? Buffer.from([1]) : read.call(this, key, options);
		};
		try {
			assert.throws(() => IdTable.getNewId(), { statusCode: 503 });
		} finally {
			store[readMethod] = read;
		}
		const id = IdTable.getNewId();
		assert(!storedIds.includes(id), `id ${id} is already stored`);
	});
});
