/**
 * A sort on an attribute that also carries a caller's condition used to drop that condition whenever
 * the planner did not give it the lead: `orderConditions` reorders narrowest-first, and the branch that
 * un-does the sort alignment spliced whatever `orderAlignedCondition` pointed at — the caller's
 * condition, not just the pseudo-condition the planner had added. The query then returned rows the
 * condition excludes. Reached far more often now that a rebuilding index's condition is ranked last
 * (harper#2537), which is how it surfaced.
 */

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('a sort does not drop a condition on the sorted attribute', function () {
	this.timeout(60000);

	let Table;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Table = table({
			table: 'SortAlignedCondition',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'rare', type: 'String', indexed: true },
				{ name: 'common', type: 'String', indexed: true },
			],
		});
		let lastPut;
		for (let i = 0; i < 20; i++)
			lastPut = Table.put({ id: `k-${i}`, rare: i === 7 ? 'needle' : `r-${i}`, common: i < 10 ? 'left' : 'right' });
		await lastPut;
		if (Table.indexingOperation) await Table.indexingOperation;
	});

	async function ids(request) {
		const found = [];
		for await (const record of Table.search(request)) found.push(record.id);
		return found;
	}

	it('applies a condition on the sort attribute even when another condition leads', async () => {
		// `rare` matches one row and leads; `common` carries both the sort and a condition that excludes it
		assert.deepStrictEqual(
			await ids({
				conditions: [
					{ attribute: 'rare', value: 'needle' },
					{ attribute: 'common', value: 'right' },
				],
				sort: { attribute: 'common' },
			}),
			[],
			'the only row matching "rare" has common=left, so a common=right condition must exclude it'
		);
		assert.deepStrictEqual(
			await ids({
				conditions: [
					{ attribute: 'rare', value: 'needle' },
					{ attribute: 'common', value: 'left' },
				],
				sort: { attribute: 'common' },
			}),
			['k-7'],
			'a matching condition on the sort attribute must still return the row'
		);
	});

	it('still orders by the sort attribute when its condition does not lead', async () => {
		const ordered = await ids({
			conditions: [
				{ attribute: 'common', value: 'right' },
				{ attribute: 'rare', comparator: 'greater_than', value: 'r-1' },
			],
			sort: { attribute: 'rare', descending: true },
		});
		assert.ok(ordered.length > 1, 'the fixture must return several rows for the ordering to be observable');
		const sorted = [...ordered].sort().reverse();
		assert.deepStrictEqual(ordered, sorted, 'the results must still be ordered by the sort attribute, descending');
	});
});
