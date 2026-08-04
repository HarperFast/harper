/**
 * Regression test for the finding raised against harper-1839-sql-selectall-pk-sort:
 * `Table.clear()` (resources/Table.ts) only cleared the primary store, leaving
 * secondary-index DBIs populated with entries pointing at records that no
 * longer exist. Any caller of the exported `clear()` API on an indexed table
 * would see phantom search results for indexed attributes after a clear.
 */
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function collect(iter) {
	const out = [];
	for await (const x of iter) out.push(x);
	return out;
}

describe('Table.clear() clears secondary indexes, not just the primary store', () => {
	const TABLE = 'ClearSecondaryIndex';
	const DB = 'test';
	const N = 20;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('search by an indexed attribute finds nothing after clear()', async () => {
		resetDatabases();
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		let last;
		for (let i = 0; i < N; i++) {
			last = Tbl.put({ id: 'k-' + i, tag: 'even' });
		}
		await last;

		const before = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'even' }] }));
		assert.equal(before.length, N, `expected ${N} rows indexed by tag before clear(), got ${before.length}`);

		await Tbl.clear();

		const baseRows = await collect(Tbl.search({ conditions: [] }));
		assert.equal(baseRows.length, 0, `primary store should be empty after clear(), got ${baseRows.length} rows`);

		// A stale index entry that still points at a MISSING primary record does not, by itself,
		// produce wrong results: the query pipeline always re-resolves candidates against the
		// primary store and drops any whose record is gone (see Table.ts transformEntryForSelect,
		// `if (record == null) return canSkip ? SKIP : record;`). So this check alone would pass
		// even on the buggy `primaryStore.clear()`-only implementation.
		const afterClear = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'even' }] }));
		assert.equal(
			afterClear.length,
			0,
			`secondary index should be empty after clear() — found ${afterClear.length} stale/phantom index ` +
				`entries pointing at records clear() removed from the primary store`
		);
	});

	it('re-writing the same ids with a DIFFERENT indexed value after clear() must not leak stale results for the old value', async () => {
		// This is the sharp edge the finding calls out: the test harness pattern of clear() +
		// re-write-same-ids masks the bug when the re-written value matches the old one, but if the
		// new value differs, a stale (unindexed) old-value index entry keeps pointing at the SAME id
		// — which now legitimately exists again, just with a different value — so an equality search
		// on the OLD value incorrectly returns it as a match.
		resetDatabases();
		const Tbl = table({
			table: TABLE + 'Reused',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		if (Tbl.indexingOperation) await Tbl.indexingOperation;

		await Tbl.put({ id: 'r-1', tag: 'before' });
		await Tbl.clear();
		await Tbl.put({ id: 'r-1', tag: 'after' });

		const staleOldValue = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'before' }] }));
		assert.equal(
			staleOldValue.length,
			0,
			`expected 0 rows for the stale old tag value "before", got ${staleOldValue.length} — a leftover ` +
				`secondary-index entry from before clear() is matching a record that has since been re-written ` +
				`with a different value`
		);

		const currentValue = await collect(Tbl.search({ conditions: [{ attribute: 'tag', value: 'after' }] }));
		assert.equal(currentValue.length, 1, `expected the re-written row to be found by its new tag value`);
	});
});
