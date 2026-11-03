require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');
// might want to enable an iteration with NATS being assigned as a source
describe('Operations on resources', () => {
	let TargetTable;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		TargetTable = table({
			table: 'TargetTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});
	after(() => {});
	it('It can search_by_conditions on a resource', async function () {
		const context = {};
		await transaction(context, async () => {
			await TargetTable.put(1, { name: 'one' }, context);
			await TargetTable.put(2, { name: 'a prime' }, context);
			await TargetTable.put(3, { name: 'another prime' }, context);
			await TargetTable.put(42, { name: 'the answer to everything' }, context);
		});
		let operation_result = await TargetTable.operation({
			operation: 'search_by_conditions',
			conditions: [{ search_attribute: 'name', search_value: 'another prime' }],
		});
		let results = [];
		for await (let entry of operation_result) {
			results.push(entry);
		}
		assert.equal(results[0].name, 'another prime');
		await TargetTable.delete(2);
		operation_result = await TargetTable.operation({
			operation: 'search_by_conditions',
			conditions: [{ search_attribute: 'name', search_value: 'another prime' }],
		});
		results = [];
		for await (let entry of operation_result) {
			results.push(entry);
		}
		assert.equal(results[0].name, 'another prime');
	});
});
