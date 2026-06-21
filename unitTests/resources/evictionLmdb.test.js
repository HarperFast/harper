require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Regression for #1287 (LMDB leg). The cleanup scan keeps the per-record TableResource.evict() path
// for LMDB (RocksDB coalesces into a batcher instead). evict()'s LMDB branch returned
// DatabaseTransaction.commit()'s plain resolution object — the optimistic remove goes straight to the
// store, so the wrapper transaction has no tracked writes and commit() returns `{ txnTime }`, not a
// promise. The scan then did `resolution.catch(...)` and threw `TypeError: resolution.catch is not a
// function` every cycle, degrading eviction to roughly one record per scan and growing the store.
//
// evict() must return a thenable that resolves once the removal is durable (RocksDB has its own
// coverage in evictionBatch.test.js, so this leg is LMDB-only).
describe('evict() returns a thenable on the LMDB path (#1287)', () => {
	if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return;
	let EvictTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		EvictTable = table({
			table: 'EvictLmdbThenableTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
	});

	it('evict() resolves a thenable and physically removes the record + its index entry', async function () {
		await EvictTable.put('a1', { id: 'a1', name: 'group 7' });
		const entry = EvictTable.primaryStore.getEntry('a1');
		assert.ok(entry, 'record should be resident before eviction');
		assert.equal(EvictTable.indices['name'].getValuesCount('group 7'), 1, 'index should be populated');

		const resolution = EvictTable.evict('a1', entry.value, entry.version);
		// The core regression: the cleanup scan does `resolution.catch(...)`, so a non-thenable return
		// throws and aborts the scan. evict() must hand back a real promise.
		assert.equal(typeof resolution?.then, 'function', 'evict() must return a thenable');
		assert.equal(typeof resolution?.catch, 'function', 'evict() thenable must expose catch()');
		await resolution;

		assert.equal(EvictTable.primaryStore.getEntry('a1'), undefined, 'record should be physically evicted');
		assert.equal(
			EvictTable.indices['name'].getValuesCount('group 7'),
			0,
			'index entry must be removed with the record'
		);
	});
});
