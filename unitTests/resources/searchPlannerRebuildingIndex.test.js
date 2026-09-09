/**
 * harper#2537. `searchByIndex` refuses a rebuilding index with IndexRebuildingError, but the planner
 * used to rank its condition by the partially-built index's cardinality, so the narrowest-first
 * ordering could hand the lead to a condition the executor was about to refuse — a 503 for a query a
 * sibling index could have answered completely. The planner has to see a rebuilding index as absent.
 */

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { estimateCondition } = require('#src/resources/search');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('the query planner treats a rebuilding index as unavailable (harper#2537)', function () {
	this.timeout(60000);

	let Table;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Table = table({
			table: 'PlannerRebuildingIndex',
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

	/** Stand in for a build in flight without holding one open for the length of the suite. */
	async function whileRebuilding(attribute, body) {
		Table.indices[attribute].isIndexing = true;
		try {
			return await body();
		} finally {
			Table.indices[attribute].isIndexing = false;
		}
	}

	it('estimates a rebuilding index at Infinity for every comparator that would otherwise use it', async () => {
		const estimates = await whileRebuilding('rare', () => {
			const estimate = estimateCondition(Table);
			return {
				equals: estimate({ attribute: 'rare', value: 'needle' }),
				range: estimate({ attribute: 'rare', comparator: 'starts_with', value: 'r-' }),
				between: estimate({ attribute: 'rare', comparator: 'between', value: ['r-0', 'r-9'] }),
				in: estimate({ attribute: 'rare', comparator: 'in', value: ['needle', 'r-1'] }),
				sort: estimate({ attribute: 'rare', comparator: 'sort' }),
			};
		});
		for (const [comparator, estimate] of Object.entries(estimates))
			assert.strictEqual(
				estimate,
				Infinity,
				`a "${comparator}" condition on a rebuilding index must not rank as usable (got ${estimate})`
			);
	});

	it('still estimates a complete index by its cardinality', () => {
		const estimate = estimateCondition(Table);
		assert.ok(
			estimate({ attribute: 'rare', value: 'needle' }) < Infinity,
			'a complete index must still produce a finite estimate'
		);
	});

	it('leads with the available index and answers the query completely', async () => {
		const rows = await whileRebuilding('rare', async () => {
			const found = [];
			for await (const record of Table.search({
				allowFullScan: false,
				conditions: [
					{ attribute: 'rare', value: 'needle' },
					{ attribute: 'common', value: 'left' },
				],
			}))
				found.push(record);
			return found;
		});
		assert.deepStrictEqual(
			rows.map((row) => row.id),
			['k-7'],
			'the sibling index must lead so the rebuilding attribute is applied as a record filter'
		);
	});

	it('still refuses a query whose only condition is on the rebuilding index', async () => {
		await whileRebuilding('rare', () => {
			assert.throws(
				() => Table.search({ allowFullScan: false, conditions: [{ attribute: 'rare', value: 'needle' }] }),
				/not indexed yet/,
				'a search that can only be driven by the rebuilding index must refuse rather than return partial results'
			);
		});
	});
});
