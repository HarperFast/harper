require('../test_utils');
const assert = require('assert');
const { Worker } = require('worker_threads');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Resource } = require('../../resources/Resource');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
// might want to enable an iteration with NATS being assigned as a source
describe('Create records', () => {
	let CreateTest, test_thread;
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true);
		CreateTest = table({
			table: 'CreateTest',
			database: 'test',
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'str', type: 'String' },
			],
		});
		test_thread = new Worker(__dirname + '/create-thread.js', {
			workerData: { addPorts: [] },
		});
	});
	it('It assigns incrementing ids', async function () {
		let results = [];
		results.push(await CreateTest.create({ str: 'hello' }));
		results.push(await CreateTest.create({ str: 'hello' }));
		assert.equal(results[0].getId() + 1, results[1].getId());
	});
	it('It increments along with other thread', async function () {
		let id_before = CreateTest.getNewId();
		test_thread.postMessage({ type: 'increment' });
		await new Promise((resolve) => {
			test_thread.on('message', (message) => {
				if (message.type === 'incremented') {
					resolve();
				}
			});
		});
		let id_after = CreateTest.getNewId();
		assert.equal(id_before + 101, id_after);
	});
	it('It can continue with async range updates', async function () {
		let id_before = CreateTest.getNewId();
		for (let i = 0; i < 500; i++) CreateTest.getNewId();
		await new Promise((resolve) => setTimeout(resolve, 100));
		let id_after = CreateTest.getNewId();
		assert.equal(id_before + 501, id_after);
	});
	it('It can continue with forced/sync range updates', async function () {
		let id_before = CreateTest.getNewId();
		for (let i = 0; i < 1100; i++) CreateTest.getNewId();
		let id_after = CreateTest.getNewId();
		assert.equal(id_before + 1101, id_after);
	});
	it('It can continue re-allocate when encountering potential id conflict', async function () {
		let id_before = CreateTest.getNewId();
		await CreateTest.put({
			id: id_before + 1000,
			str: 'hello',
		});
		for (let i = 0; i < 500; i++) CreateTest.getNewId();
		await new Promise((resolve) => setTimeout(resolve, 100));
		let id_after = CreateTest.getNewId();
		assert(Math.abs(id_before - id_after) > 1000000);
	});
	after(() => {
		//		test_thread.terminate();
	});
});
