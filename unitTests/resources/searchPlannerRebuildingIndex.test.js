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
	let Parent;

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

		Parent = table({
			table: 'PlannerRebuildingParent',
			database: 'test',
			schemaDefined: true,
			schemaRelationshipsDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'status', type: 'String', indexed: true },
				{ name: 'childId', type: 'ID', indexed: true },
				{
					name: 'child',
					type: 'PlannerRebuildingIndex',
					relationship: { from: 'childId' },
					relationshipReference: { database: 'test', table: 'PlannerRebuildingIndex' },
					definition: { tableClass: Table },
				},
			],
		});
		for (let i = 0; i < 20; i++)
			lastPut = Parent.put({ id: `p-${i}`, status: i < 10 ? 'open' : 'closed', childId: `k-${i}` });
		await lastPut;
		if (Parent.indexingOperation) await Parent.indexingOperation;
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

	it('follows a relationship path for every comparator, not only equality', async () => {
		const estimates = await whileRebuilding('rare', () => {
			const estimate = estimateCondition(Parent);
			return {
				equals: estimate({ attribute: ['child', 'rare'], value: 'needle' }),
				between: estimate({ attribute: ['child', 'rare'], comparator: 'between', value: ['r-0', 'r-9'] }),
				starts_with: estimate({ attribute: ['child', 'rare'], comparator: 'starts_with', value: 'r-' }),
			};
		});
		for (const [comparator, estimate] of Object.entries(estimates))
			assert.strictEqual(
				estimate,
				Infinity,
				`a relationship "${comparator}" whose leaf index is rebuilding must not rank as usable (got ${estimate})`
			);
	});

	it('treats a rebuilding local join index as unusable too', () => {
		Parent.indices.childId.isIndexing = true;
		try {
			assert.strictEqual(
				estimateCondition(Parent)({ attribute: ['child', 'rare'], comparator: 'between', value: ['r-0', 'r-9'] }),
				Infinity,
				'the join is driven by the local from-index, so a rebuild of it must rank the condition as unusable'
			);
		} finally {
			Parent.indices.childId.isIndexing = false;
		}
	});

	it('still estimates a relationship finitely when every index it needs is complete', () => {
		assert.ok(
			estimateCondition(Parent)({ attribute: ['child', 'rare'], value: 'needle' }) < Infinity,
			'a complete relationship path must still produce a finite estimate'
		);
	});
});
