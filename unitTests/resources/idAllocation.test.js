require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const ID_ALLOCATION = Symbol.for('id_allocation');
const MAX_IDS = 0x10000;

// LMDB serializes write transactions, so a sibling commit cannot land inside this thread's allocation transaction.
describe('Auto-increment id allocation under concurrent allocation writes', function () {
	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
	});

	function makeIdTable(name) {
		return table({
			table: name,
			database: 'test',
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'str', type: 'String' },
			],
		});
	}

	function readAllocation(store) {
		const { start, end, nodeName, pid } = store.getEntry(ID_ALLOCATION).value;
		return { start, end, nodeName, pid };
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

	// the sibling's counter reset follows its commit, as in production
	function siblingCommitsBeforeNextAllocationWrite(store, sibling, siblingCounterStart) {
		const put = store.put;
		let fired = false;
		store.put = function (key, ...args) {
			if (key === ID_ALLOCATION && !fired) {
				fired = true;
				put.call(store, ID_ALLOCATION, sibling, Date.now());
				if (siblingCounterStart !== undefined) Atomics.store(sharedCounter(store), 0, BigInt(siblingCounterStart));
			}
			return put.call(store, key, ...args);
		};
		return () => {
			store.put = put;
			return fired;
		};
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
		const restore = siblingCommitsBeforeNextAllocationWrite(store, sibling, sibling.start + 1);
		try {
			getNewIdsUntil(IdTable, () => readAllocation(store).start !== initial.start);
		} finally {
			assert(restore(), 'expected the range to be re-allocated');
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
		const restore = siblingCommitsBeforeNextAllocationWrite(store, sibling);
		try {
			getNewIdsUntil(IdTable, () => readAllocation(store).end !== initial.end);
		} finally {
			assert(restore(), 'expected the range to be extended');
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
		store.put(ID_ALLOCATION, initial, Date.now());
		IdTable.getNewId();
		assert.deepStrictEqual(readAllocation(store), initial);
		const sibling = { start: 200_000_000, end: 200_000_000 + 0x400, nodeName, pid };
		const restore = siblingCommitsBeforeNextAllocationWrite(store, sibling, sibling.start + 1);
		try {
			getNewIdsUntil(IdTable, () => readAllocation(store).start !== initial.start);
		} finally {
			assert(restore(), 'expected the range to be extended');
		}
		assert.deepStrictEqual(readAllocation(store), sibling);
		getNewIdsUntil(IdTable, (id) => id >= sibling.end - 50);
		assert(readAllocation(store).end > sibling.end, 'ids approached the stored range end without extending it');
	});
});
