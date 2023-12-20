require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
// might want to enable an iteration with NATS being assigned as a source
describe('Transactions', () => {
	let TxnTest, TxnTest2, TxnTest3;
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true);
		TxnTest = table({
			table: 'TxnTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		TxnTest2 = table({
			table: 'TxnTest2',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		TxnTest3 = table({
			table: 'TxnTest3',
			database: 'test2',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});
	after(() => {});
	it('Can run txn', async function () {
		const context = {};
		await transaction(context, () => {
			TxnTest.put(42, { name: 'the answer' }, context);
		});
		assert.equal((await TxnTest.get(42)).name, 'the answer');
	});
	it('Do not allow write after txn commits', async function () {
		const context = {};
		await transaction(context, () => {});
		let error;
		try {
			TxnTest.put(42, { name: 'wrong answer' }, context);
		} catch (e) {
			error = e;
		}
		assert(error.message?.includes('Can not'));
	});
	it('Can run txn with three tables and two databases', async function () {
		const context = {};
		let start = Date.now();
		await transaction(context, () => {
			TxnTest.put(7, { name: 'a prime' }, context);
			TxnTest2.put(13, { name: 'a bigger prime' }, context);
			TxnTest3.put(14, { name: 'not a prime' }, context);
		});
		assert.equal((await TxnTest.get(7)).name, 'a prime');
		assert.equal((await TxnTest2.get(13)).name, 'a bigger prime');
		assert.equal((await TxnTest3.get(14)).name, 'not a prime');
		let last_txn;
		for await (let entry of TxnTest.getHistory(start)) {
			last_txn = entry;
		}
		assert.equal(last_txn.id, 7);
		let last_txn2;
		for await (let entry of TxnTest2.getHistory(start)) {
			last_txn2 = entry;
		}
		assert.equal(last_txn2.id, 13);
		assert.equal(last_txn.version, last_txn2.version);
	});
});
