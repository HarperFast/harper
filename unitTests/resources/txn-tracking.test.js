require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { setTxnExpiration } = require('#src/resources/DatabaseTransaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { setTimeout: delay } = require('node:timers/promises');
describe('Txn Expiration', () => {
	let SlowResource,
		performedDBInteractions = false;
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
				await delay(40);
				// at this point the read transaction should be expired, but we should still be able to do read/writes (in a
				// new transaction)
				await super.get(3);
				await super.put(3, { name: 'three' });
				performedDBInteractions = true;
				await delay(500);
				return super.get(query);
			}
		};
	});
	it('Slow txn will expire', async function () {
		let trackedTxns = setTxnExpiration(20);
		let existingTxns = trackedTxns.size;
		let result = SlowResource.get(3);
		assert.equal(trackedTxns.size, existingTxns + 1);
		const txns = Array.from(trackedTxns);
		const lastTxn = txns[txns.length - 1];
		assert.equal(lastTxn.startedFrom.resourceName, 'SlowResource');
		assert.equal(lastTxn.startedFrom.method, 'get');
		assert.equal(lastTxn.timeout, 20);
		await Promise.race([delay(50), result]);
		assert(performedDBInteractions);
		assert.equal(trackedTxns.size, existingTxns);
	});
	after(function () {
		setTxnExpiration(30000);
	});
});
