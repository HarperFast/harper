import { describe, it, before, after } from 'mocha';
import assert from 'assert';
import { Worker } from 'worker_threads';
import { cleanupTestSandbox, createTestSandbox } from '../testUtils';
import { table } from '@/resources/databases';
import { setMainIsWorker } from '@/server/threads/manageThreads';

describe('Create records', () => {
	let CreateTest, testThread;

	before(async function () {
		createTestSandbox();
		setMainIsWorker(true);
		CreateTest = table({
			table: 'CreateTest',
			database: 'test',
			attributes: [
				{ name: 'id', type: 'Int', isPrimaryKey: true },
				{ name: 'str', type: 'String' },
			],
		});
		testThread = new Worker(__dirname + '/create-thread.js', {
			workerData: { addPorts: [] },
		});
	});

	after(cleanupTestSandbox);

	it('It assigns incrementing ids', async function () {
		let results = [];
		results.push(await CreateTest.create({ str: 'hello' }));
		results.push(await CreateTest.create({ str: 'hello' }));
		assert.equal(results[0].getId() + 1, results[1].getId());
	});

	it('It increments along with other thread', async function () {
		let id_before = CreateTest.getNewId();
		testThread.postMessage({ type: 'increment' });
		await new Promise<void>((resolve) => {
			testThread.on('message', (message) => {
				if (message.type === 'incremented') {
					resolve();
				}
			});
		});
		let idAfter = CreateTest.getNewId();
		assert.equal(id_before + 101, idAfter);
	});

	it('It can continue with async range updates', async function () {
		let idBefore = CreateTest.getNewId();
		for (let i = 0; i < 500; i++) CreateTest.getNewId();
		await new Promise((resolve) => setTimeout(resolve, 100));
		let idAfter = CreateTest.getNewId();
		assert.equal(idBefore + 501, idAfter);
	});

	it('It can continue with forced/sync range updates', async function () {
		let idBefore = CreateTest.getNewId();
		for (let i = 0; i < 1100; i++) CreateTest.getNewId();
		let idAfter = CreateTest.getNewId();
		assert.equal(idBefore + 1101, idAfter);
	});

	it('It can continue re-allocate when encountering potential id conflict', async function () {
		let idBefore = CreateTest.getNewId();
		await CreateTest.put({
			id: idBefore + 1000,
			str: 'hello',
		});
		for (let i = 0; i < 500; i++) CreateTest.getNewId();
		await new Promise((resolve) => setTimeout(resolve, 100));
		let idAfter = CreateTest.getNewId();
		assert(Math.abs(idBefore - idAfter) > 1000000);
	});

	after(() => {
		testThread.terminate();
	});
});
