// harper#3212

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('non-driving conditions exclude null and omitted attributes like a driving index scan', function () {
	this.timeout(60000);

	let Table;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Table = table({
			table: 'NullOmittedConditionFilters',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'c', type: 'String', indexed: true },
				{ name: 'b', type: 'Int', indexed: true },
			],
		});
		const records = [
			{ id: 'v1', c: 'alpha', b: 1 },
			{ id: 'v5', c: 'alpha', b: 5 },
			{ id: 'vnull', c: 'alpha', b: null },
			{ id: 'vabsent', c: 'alpha' },
			{ id: 'beta1', c: 'beta', b: 1 },
		];
		let lastPut;
		for (const record of records) lastPut = Table.put(record);
		await lastPut;
		if (Table.indexingOperation) await Table.indexingOperation;
	});

	async function idsInBothOrders(rangeCondition) {
		const equalsCondition = { attribute: 'c', value: 'alpha' };
		const results = [];
		for (const conditions of [
			[equalsCondition, rangeCondition],
			[rangeCondition, equalsCondition],
		]) {
			const request = { conditions: conditions.map((condition) => ({ ...condition })), enforceExecutionOrder: true };
			const plan = await Table.search({ ...request, explain: true });
			assert.strictEqual(plan.conditions[0].attribute, conditions[0].attribute, 'the listed first condition leads');
			const found = [];
			for await (const record of Table.search(request)) found.push(record.id);
			results.push(found.sort());
		}
		return results;
	}

	for (const comparator of ['lt', 'le', 'less_than', 'less_than_equal']) {
		it(`${comparator} matches only present values whichever condition leads`, async () => {
			const [equalsLeads, rangeLeads] = await idsInBothOrders({ attribute: 'b', comparator, value: 3 });
			assert.deepStrictEqual(rangeLeads, ['v1']);
			assert.deepStrictEqual(equalsLeads, ['v1']);
		});
	}

	for (const [comparator, value, expected] of [
		['ge', null, ['v1', 'v5', 'vnull']],
		['gt', null, ['v1', 'v5']],
		['between', [null, 3], ['v1', 'vnull']],
	]) {
		it(`${comparator} ${String(value)} excludes omitted values whichever condition leads`, async () => {
			const [equalsLeads, rangeLeads] = await idsInBothOrders({ attribute: 'b', comparator, value });
			assert.deepStrictEqual(rangeLeads, expected);
			assert.deepStrictEqual(equalsLeads, expected);
		});
	}

	it('ne null excludes omitted as well as null values whichever condition leads', async () => {
		const [equalsLeads, neLeads] = await idsInBothOrders({ attribute: 'b', comparator: 'ne', value: null });
		assert.deepStrictEqual(neLeads, ['v1', 'v5']);
		assert.deepStrictEqual(equalsLeads, ['v1', 'v5']);
	});

	it('ne with a non-null value still matches null and omitted values', async () => {
		const found = [];
		for await (const record of Table.search({
			conditions: [
				{ attribute: 'c', value: 'alpha' },
				{ attribute: 'b', comparator: 'ne', value: 1 },
			],
			enforceExecutionOrder: true,
		}))
			found.push(record.id);
		assert.deepStrictEqual(found.sort(), ['v5', 'vabsent', 'vnull']);
	});
});
