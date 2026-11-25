require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { setNextEncoding, clearNextEncoding, METADATA } = require('#src/resources/RecordEncoder');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const insert = require('#src/dataLayer/insert');
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
	setNextEncoding(store.getMonotonicTimestamp(), LOCAL_ONLY);
	store.putSync(ID_ALLOCATION, allocation);
}

function writeLegacyAllocation(store, allocation) {
	clearNextEncoding();
	store.putSync(ID_ALLOCATION, allocation);
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

// Classic structure ids start at 0x40, so after two record shapes the allocation's is 0x42, the first byte of a
// RocksDB version header (harper#1762). LMDB has no such header.
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

	it('replaces a header-less allocation that reads as undefined', async function () {
		if (isLMDB) return this.skip();
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		const legacy = { start: 1_000_000_000, end: 1_000_000_000 + 0x400, nodeName: 'legacy', pid: 1 };
		writeLegacyAllocation(store, legacy);
		assertAllocationIsStructure(store, 0, 'precondition: the legacy allocation starts with the third structure id');
		assert.strictEqual(store.getEntry(ID_ALLOCATION), undefined, 'precondition: the legacy allocation is unreadable');
		await insertWithoutIds(IdTable, 1500, 'healed');
		await idsByPrefix(IdTable, 1502);
		assertReadableAllocation(store);
	});

	it('does not store an end below ids a sibling issued after the extension was queued', async function () {
		if (isLMDB) return this.skip();
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		// the background extension is queued at this id, and its end is 0x3ff past it
		getNewIdsUntil(IdTable, (id) => id + 0x200 === initial.end);
		Atomics.add(sharedCounter(store), 0, 0x500n);
		writeLegacyAllocation(store, initial);
		await new Promise((resolve) => setImmediate(resolve));
		const issuedThrough = Number(sharedCounter(store)[0]) - 1;
		if (store.getEntry(ID_ALLOCATION))
			assert(readAllocation(store).end >= issuedThrough, 'the stored range ends below issued ids');
		const nextId = IdTable.getNewId();
		assert(nextId > issuedThrough, 'an issued id was handed out again');
		assert(readAllocation(store).end > nextId, 'the range in use was not stored');
	});

	it('stores the range in use again when the stored allocation becomes unreadable mid-range', async function () {
		if (isLMDB) return this.skip();
		const { IdTable } = await twoShapeTable();
		const store = IdTable.primaryStore;
		const firstId = IdTable.getNewId();
		assertReadableAllocation(store);
		const initial = readAllocation(store);
		writeLegacyAllocation(store, initial);
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
