require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const ID_ALLOCATION = Symbol.for('id_allocation');

// A sibling worker thread commits its own id_allocation write between this thread's read of the
// record and its commit. LMDB serializes write transactions, so this interleaving only exists on RocksDB.
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

	// Interposes on the next write of the id_allocation record and commits `onWrite()`'s result first,
	// outside any transaction, as a sibling worker's committed allocation write would land.
	function siblingCommitsBeforeNextAllocationWrite(store, onWrite) {
		const put = store.put;
		let fired = false;
		store.put = function (key, ...args) {
			if (key === ID_ALLOCATION && !fired) {
				fired = true;
				put.call(store, ID_ALLOCATION, onWrite(), Date.now());
			}
			return put.call(store, key, ...args);
		};
		return () => {
			store.put = put;
			return fired;
		};
	}

	function farRangeStart(allocation) {
		return allocation.start < 1_000_000_000 ? 1_800_000_000 : 200_000_000;
	}

	it('adopts a sibling range committed while a new range is being allocated', async function () {
		const IdTable = makeIdTable('IdAllocationNewRange');
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		// an existing record just past the range forces the synchronous range check into a re-allocation
		await IdTable.put({ id: initial.end + 50, str: 'existing' });
		const counter = new BigInt64Array(store.getUserSharedBuffer('id', new ArrayBuffer(8)));
		const siblingStart = farRangeStart(initial);
		const sibling = { start: siblingStart, end: siblingStart + 0x400, nodeName: initial.nodeName, pid: initial.pid };
		const restore = siblingCommitsBeforeNextAllocationWrite(store, () => {
			Atomics.store(counter, 0, BigInt(sibling.start + 1));
			return sibling;
		});
		try {
			while (readAllocation(store).start === initial.start) IdTable.getNewId();
		} finally {
			assert(restore(), 'expected the range to be re-allocated');
		}
		assert.deepStrictEqual(readAllocation(store), sibling);
		const nextId = IdTable.getNewId();
		assert(nextId > sibling.start && nextId <= sibling.end, `id ${nextId} is outside the committed range`);
	});

	it('does not overwrite a sibling range extension committed during its own extension', async function () {
		const IdTable = makeIdTable('IdAllocationExtend');
		const store = IdTable.primaryStore;
		IdTable.getNewId();
		const initial = readAllocation(store);
		const sibling = { ...initial, end: initial.end + 0x10000 };
		const restore = siblingCommitsBeforeNextAllocationWrite(store, () => sibling);
		try {
			while (readAllocation(store).end === initial.end) IdTable.getNewId();
		} finally {
			assert(restore(), 'expected the range to be extended');
		}
		assert.deepStrictEqual(readAllocation(store), sibling);
	});
});
