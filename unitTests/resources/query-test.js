require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
// might want to enable an iteration with NATS being assigned as a source
describe('Querying through Resource API', () => {
	let QueryTable;
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		QueryTable = table({
			table: 'QueryTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		for (let i = 0; i < 10; i++) {
			QueryTable.put({ id: 'id-' + i, name: i > 0 ? 'name-' + i : null });
		}
	});
	it('Query data in a table', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [
				{ attribute: 'id', comparator: 'le', value: 'id-1' },
				{ attribute: 'name', comparator: 'ne', value: null },
			],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
	});
});
