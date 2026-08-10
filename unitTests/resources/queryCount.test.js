require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Covers the `Prefer: count=` pagination support in Table.search: a `count` target returns the
// requested page (offset/limit window) as an array carrying `recordCount` (total matching records)
// and `recordCountExact`, instead of the default lazy streaming iterable.
describe('Table.search count (REST pagination total-count)', () => {
	let CountTable;
	const TOTAL = 20;
	const GROUP_A = 12; // ids 0..11
	const GROUP_B = TOTAL - GROUP_A; // ids 12..19

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		CountTable = table({
			table: 'QueryCountTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'group', indexed: true },
				{ name: 'name' },
			],
		});
		let last;
		for (let i = 0; i < TOTAL; i++) {
			last = CountTable.put({ id: i, group: i < GROUP_A ? 'a' : 'b', name: 'n-' + i });
		}
		await last;
	});

	it('exact: whole-collection page carries the exact total', async function () {
		const page = await CountTable.search({ limit: 5, offset: 0, count: 'exact' });
		assert.ok(Array.isArray(page));
		assert.strictEqual(page.length, 5);
		assert.strictEqual(page.recordCount, TOTAL);
		assert.strictEqual(page.recordCountExact, true);
	});

	it('exact: total is independent of the offset/limit window', async function () {
		const nearEnd = await CountTable.search({ limit: 5, offset: 18, count: 'exact' });
		assert.strictEqual(nearEnd.length, 2); // only ids 18,19 remain
		assert.strictEqual(nearEnd.recordCount, TOTAL);

		const pastEnd = await CountTable.search({ limit: 5, offset: 25, count: 'exact' });
		assert.strictEqual(pastEnd.length, 0);
		assert.strictEqual(pastEnd.recordCount, TOTAL);
		assert.strictEqual(pastEnd.recordCountExact, true);
	});

	it('exact: a filtered query counts only matching records', async function () {
		const paged = await CountTable.search({ conditions: [{ attribute: 'group', value: 'a' }], limit: 5, count: 'exact' });
		assert.strictEqual(paged.length, 5);
		assert.strictEqual(paged.recordCount, GROUP_A);
		assert.strictEqual(paged.recordCountExact, true);

		// no limit: the page is the whole matched set and the count agrees with it
		const all = await CountTable.search({ conditions: [{ attribute: 'group', value: 'b' }], count: 'exact' });
		assert.strictEqual(all.length, GROUP_B);
		assert.strictEqual(all.recordCount, GROUP_B);
	});

	it('estimated: returns the page plus a positive estimate, flagged non-exact', async function () {
		const page = await CountTable.search({ limit: 5, count: 'estimated' });
		assert.strictEqual(page.length, 5);
		assert.strictEqual(typeof page.recordCount, 'number');
		assert.ok(page.recordCount > 0, `expected a positive estimate, got ${page.recordCount}`);
		assert.strictEqual(page.recordCountExact, false);

		const filtered = await CountTable.search({
			conditions: [{ attribute: 'group', value: 'a' }],
			limit: 3,
			count: 'estimated',
		});
		assert.strictEqual(filtered.length, 3);
		assert.ok(filtered.recordCount > 0);
		assert.strictEqual(filtered.recordCountExact, false);
	});

	it('default (no count): still returns the lazy streaming iterable, not a materialized page', async function () {
		const results = CountTable.search({ limit: 5 });
		assert.ok(!Array.isArray(results), 'default search must not materialize an array');
		assert.strictEqual(results.recordCount, undefined);
		let n = 0;
		for await (const _ of results) n++;
		assert.strictEqual(n, 5);
	});
});
