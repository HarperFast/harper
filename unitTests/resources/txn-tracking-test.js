require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { setTxnExpiration } = require('../../resources/DatabaseTransaction');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { table } = require('../../resources/databases');
describe('Txn Expiration', () => {
	let SlowResource;
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		let BasicTable = table({
			table: 'BasicTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		SlowResource = class extends BasicTable {
			async get(query) {
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return super.get(query);
			}
		};
	});
	it('Slow txn will expire', async function () {
		let tracked_txns = setTxnExpiration(20);
		let result = SlowResource.get(3);
		assert.equal(tracked_txns.size, 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(tracked_txns.size, 0);
	});
	after(function () {
		setTxnExpiration(30000);
	});
});
