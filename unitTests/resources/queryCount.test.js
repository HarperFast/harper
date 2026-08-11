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
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'group', indexed: true }, { name: 'name' }],
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
		const paged = await CountTable.search({
			conditions: [{ attribute: 'group', value: 'a' }],
			limit: 5,
			count: 'exact',
		});
		assert.strictEqual(paged.length, 5);
		assert.strictEqual(paged.recordCount, GROUP_A);
		assert.strictEqual(paged.recordCountExact, true);

		// a limit wide enough to cover the whole matched set gives page == matches, count == matches
		const all = await CountTable.search({ conditions: [{ attribute: 'group', value: 'b' }], limit: 100, count: 'exact' });
		assert.strictEqual(all.length, GROUP_B);
		assert.strictEqual(all.recordCount, GROUP_B);
	});

	it('count without a limit falls through to streaming (no unbounded drain)', async function () {
		// A count is a pagination feature; without a limit the page would be the entire matched set, so the
		// request is served by the normal streaming path with no count instead of materializing everything.
		const results = CountTable.search({ conditions: [{ attribute: 'group', value: 'b' }], count: 'exact' });
		assert.ok(!Array.isArray(results), 'count without a limit must not materialize a page');
		assert.strictEqual(results.recordCount, undefined);
		let n = 0;
		for await (const _ of results) n++;
		assert.strictEqual(n, GROUP_B); // still returns every matching row, just no count
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

	it('estimated: a sorted whole-collection estimate is not halved by the planner sort condition', async function () {
		// Regression: the synthetic `sort` pseudo-condition used to flip hasUserConditions and feed
		// estimateCondition, yielding ~entryCount/2 and impossible ranges (e.g. items 3-4/3).
		const page = await CountTable.search({ sort: { attribute: 'id' }, offset: 3, limit: 3, count: 'estimated' });
		assert.strictEqual(page.length, 3);
		assert.ok(
			page.recordCount >= 3 + page.length,
			`range must be valid: total ${page.recordCount} vs page end ${3 + page.length}`
		);
		assert.ok(
			page.recordCount >= TOTAL * 0.75,
			`sorted estimate ${page.recordCount} should track table size ${TOTAL}, not half it`
		);
	});

	it('estimated: an opaque rowFilter yields an unknown total (null), not a misleading estimate', async function () {
		const page = await CountTable.search({ rowFilter: (r) => r.group === 'a', limit: 3, count: 'estimated' });
		assert.ok(page.length <= 3);
		assert.ok(
			page.every((r) => r.group === 'a'),
			'page must honor the rowFilter'
		);
		assert.strictEqual(page.recordCount, null);
		assert.strictEqual(page.recordCountExact, false);
	});

	it('exact: honors a rowFilter in both the page and the count', async function () {
		const page = await CountTable.search({ rowFilter: (r) => r.group === 'b', limit: 100, count: 'exact' });
		assert.strictEqual(page.length, GROUP_B);
		assert.strictEqual(page.recordCount, GROUP_B);
		assert.strictEqual(page.recordCountExact, true);
	});
});
