const assert = require('assert');
const sinon = require('sinon');
const { getMockLMDBPath } = require('../../test_utils');
const { start, setReplicator, servers, sendOperationToNode } = require('../../../server/replication/replicator');
const { table, databases } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const { Worker, workerData } = require('worker_threads');
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const { get: env_get } = require('../../..//utility/environment/environmentManager');
const env = require('../../../utility/environment/environmentManager');
const { fork } = require('node:child_process');
const { createTestTable, createNode } = require('./setup-replication');
const { clusterStatus } = require('../../../utility/clustering/clusterStatus');
const { ResourceBridge } = require('../../../dataLayer/harperBridge/ResourceBridge');
const { open } = require('lmdb');
const { transaction } = require('../../../resources/transaction');
OpenDBIObject = require('../../../utility/lmdb/OpenDBIObject');

describe('Replication', () => {
	let TestTable;
	const test_stores = [];
	let child_processes = [];
	let node_count = 2;
	let db_count = 3;
	let database_config;
	function addWorkerNode(index) {
		const child_process = fork(
			__filename.replace(/\-test.js/, '-thread.js'),
			[index, database_config.data.path + '/test-replication-' + index],
			{}
		);
		child_processes.push(child_process);
		child_process.on('error', (error) => {
			console.log('error from child_process:', error);
		});
		child_process.on('exit', (error) => {
			console.log('exit from child_process:', error);
		});
		return new Promise((resolve) => {
			child_process.on('message', (message) => {
				console.log('message from child_process:', message);
				if (message.type === 'replication-started') resolve();
			});
		});
	}
	before(async function () {
		this.timeout(100000);
		getMockLMDBPath();
		database_config = env_get(CONFIG_PARAMS.DATABASES);
		TestTable = await createTestTable(database_config.data.path + '/test-replication-0');

		for (let i = 0; i < db_count; i++) {
			test_stores.push(
				open(
					database_config.data.path + '/test-replication-' + i + '/test.mdb',
					Object.assign(new OpenDBIObject(false, true), {
						name: 'TestTable/',
						compression: { startingOffset: 32 },
					})
				)
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));

		await createNode(0, database_config.data.path, node_count);
		let started = addWorkerNode(1);
		await started;
		await new Promise((resolve) => setTimeout(resolve, 400));
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});
	it('A write to one table should replicate', async function () {
		let name = 'name ' + Math.random();
		await TestTable.put({
			id: '1',
			name,
		});
		await TestTable.put({
			id: '2',
			name,
			extraProperty: true,
		});
		let retries = 10;
		do {
			await new Promise((resolve) => setTimeout(resolve, 200));
			let result = await test_stores[1].get('1')?.value;
			if (!result) {
				assert(--retries > 0);
				continue;
			}
			assert.equal(result.name, name);
			result = await test_stores[1].get('2')?.value;
			assert.equal(result.name, name);
			assert.equal(result.extraProperty, true);
			break;
		} while (true);
	});
	it('A write to one table with replicated confirmation', async function () {
		let name = 'name ' + Math.random();
		let context = { replicatedConfirmation: 1 };
		await transaction(context, async (transaction) => {
			TestTable.put(
				{
					id: '1',
					name,
				},
				context
			);
			TestTable.put(
				{
					id: '2',
					name,
					extraProperty: true,
				},
				context
			);
		});
		let result = await test_stores[1].get('1')?.value;
		assert.equal(result.name, name);
		result = await test_stores[1].get('2')?.value;
		assert.equal(result.name, name);
		assert.equal(result.extraProperty, true);
	});

	it('A write to second table should replicate back', async function () {
		this.timeout(5000);
		let name = 'name ' + Math.random();
		child_processes[0].send({
			action: 'put',
			data: {
				id: '3',
				name,
			},
		});
		let retries = 10;
		do {
			await new Promise((resolve) => setTimeout(resolve, 500));
			let result = await TestTable.get('3');
			if (!result) {
				assert(--retries > 0);
				continue;
			}
			assert.equal(result.name, name);
			break;
		} while (true);
	});
	it('Resolves a transaction time tie', async function () {
		let name1 = 'name ' + Math.random();
		let name2 = 'name ' + Math.random();
		let now = Date.now();
		let context = { timestamp: now };
		// write to both tables at with the same timestamp, this should always resolve to node-2 since it is
		// alphabetically higher than node-1
		await TestTable.put(
			{
				id: '3',
				name: name1,
			},
			context
		);
		child_processes[0].send({
			action: 'put',
			timestamp: now,
			data: {
				id: '3',
				name: name2,
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		let result = await TestTable.get('3');
		assert.equal(result.name, name2);
		result = await test_stores[1].get('3')?.value;
		assert.equal(result.name, name2);
	});
	it('Can send operation API over WebSocket with replication protocol', async function () {
		const cluster_status = await sendOperationToNode({ url: 'ws://localhost:9326' }, { operation: 'cluster_status' });
		assert(cluster_status.connections.length >= 1);
		assert.equal(cluster_status.node_name, 'node-2');
		let caught_error;
		try {
			await sendOperationToNode({ url: 'ws://localhost:9326' }, { operation: 'not_an_operation' });
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error);
	});
	it('Create a new table on node-1 and verify that it is replicated to node-2', async function () {
		let operation_result = await new ResourceBridge().createTable(null, {
			operation: 'create_table',
			table: 'NewTestTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		let name = 'name ' + Math.random();
		await databases.test.NewTestTable.put({
			id: '4',
			name,
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		let node2NewTestTable = test_stores[1].openDB('NewTestTable/', new OpenDBIObject(false, true));
		let result = await node2NewTestTable.get('4').value;
		assert.equal(result.name, name);
	});
	it.skip('Should handle high load', async function () {
		this.timeout(10000);
		let big_string = 'this will be expanded to a large string';
		for (let i = 0; i < 7; i++) big_string += big_string;
		let name;
		for (let i = 0; i < 10000; i++) {
			name = 'name ' + Math.random();
			let result = TestTable.put({
				id: '14',
				name,
				bigString: big_string,
			});
			if (i % 1000 === 0) {
				await result;
				console.log('wrote', i, 'records');
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		let result = await test_stores[1].get('14')?.value;
		assert.equal(result.name, name);
	});

	describe('With third node', function () {
		before(async function () {
			this.timeout(10000);
			await addWorkerNode(2);
			await new Promise((resolve) => setTimeout(resolve, 500));
			console.log('added child_process');
		});
		it('A write to the table should replicate to both nodes', async function () {
			let name = 'name ' + Math.random();
			await TestTable.put({
				id: '5',
				name,
			});
			await TestTable.put({
				id: '2',
				name,
				extraProperty: true,
			});
			let retries = 10;
			do {
				await new Promise((resolve) => setTimeout(resolve, 500));
				let result = await test_stores[2].get('5')?.value;
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				assert.equal(result.name, name);
				result = await test_stores[2].get('2')?.value;
				assert.equal(result.name, name);
				assert.equal(result.extraProperty, true);
				break;
			} while (true);
		});
		it('A write to the table with sharding defined should replicate to one node', async function () {
			this.timeout(100000);
			let name = 'name ' + Math.random();
			await TestTable.put(
				{
					id: '8',
					name,
					//locations: ['node-1', 'node-3'],
				},
				{
					replicateTo: ['node-3'],
				}
			);

			let retries = 10;
			do {
				await new Promise((resolve) => setTimeout(resolve, 500));
				let result = test_stores[1].getBinary('8');
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				// verify that this is a small partial record, and invalidation entry
				assert(result.length < 30);
				result = test_stores[2].getBinary('8');
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				// verify that this is a full record
				assert(result.length > 30);
				break;
			} while (true);
			// now verify that the record can be loaded on-demand in the other thread
			child_processes[0].send({
				action: 'get',
				id: '8',
			});
			await new Promise((resolve) => {
				child_processes[0].once('message', resolve);
			});
			let result = test_stores[1].get('8')?.value;
			assert.equal(result.name, name);
		});
		it('A write to the table during a single broken connection should route through another node', async function () {
			let name = 'name ' + Math.random();

			for (let server of servers) {
				for (let client of server._ws.clients) {
					client._socket.destroy();
					break; // only the first one
				}
			}

			TestTable.put({
				id: '6',
				name,
			});
			await TestTable.put({
				id: '7',
				name,
				extraProperty: true,
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			let retries = 10;
			do {
				await new Promise((resolve) => setTimeout(resolve, 100));
				let result = test_stores[1].get('6')?.value;
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				assert.equal(result.name, name);
				result = test_stores[1].get('7')?.value;
				assert.equal(result.name, name);
				assert.equal(result.extraProperty, true);
				break;
			} while (true);
		});
		it('A write to the table during a broken connection should catch up to both nodes', async function () {
			this.timeout(10000);
			let name = 'name ' + Math.random();

			for (let server of servers) {
				for (let client of server._ws.clients) {
					client._socket.destroy();
				}
			}

			TestTable.put({
				id: '16',
				name,
			});
			await TestTable.put({
				id: '17',
				name,
				extraProperty: true,
			});
			await new Promise((resolve) => setTimeout(resolve, 1000));
			let retries = 10;
			do {
				await new Promise((resolve) => setTimeout(resolve, 500));
				let result = test_stores[2].get('16')?.value;
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				assert.equal(result.name, name);
				result = test_stores[2].get('17')?.value;
				assert.equal(result.name, name);
				assert.equal(result.extraProperty, true);
				break;
			} while (true);
		});
	});

	after(() => {
		for (const child_process of child_processes) {
			child_process.kill();
		}
	});
});
