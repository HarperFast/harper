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

describe('Replication', () => {
	let TestTable;
	const test_tables = [];
	let child_processes = [];
	let node_count = 2;
	let db_count = 3;
	let database_config;
	function addWorkerNode(index) {
		const child_process = fork(
			__filename.replace(/\.js/, '-thread.js'),
			[index, database_config.data.path + '/test-replication-' + index],
			{}
		);
		/*
		let worker = new Worker(__filename.replace(/\.js/, '-thread.js'), {
			workerData: {
				index,
				workerIndex: 0, // just used to indicate that it is below the max ingest thread
				nodeCount: node_count,
				nodeName: 'node-' + (index + 1),
				databasePath: database_config.data.path + '/test-replication-' + index,
				noServerStart: true,
			},
		});*/
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
		this.timeout(1000009);
		getMockLMDBPath();
		database_config = env_get(CONFIG_PARAMS.DATABASES);
		for (let i = 0; i < db_count; i++) {
			test_tables.push(await createTestTable(i, database_config.data.path + '/test-replication-' + i));
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
		Object.defineProperty(databases, 'test', { value: databases['test-replication-0'] });
		TestTable = test_tables[0];

		await createNode(0, database_config.data.path, node_count);
		let started = addWorkerNode(1);
		await started;
		await new Promise((resolve) => setTimeout(resolve, 500));
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});
	it('A write to one table should replicate', async function () {
		let name = 'name ' + Math.random();
		await test_tables[0].put({
			id: '1',
			name,
		});
		await test_tables[0].put({
			id: '2',
			name,
			extraProperty: true,
		});
		let retries = 10;
		do {
			await new Promise((resolve) => setTimeout(resolve, 500));
			let result = await test_tables[1].get('1');
			if (!result) {
				assert(--retries > 0);
				continue;
			}
			assert.equal(result.name, name);
			result = await test_tables[1].get('2');
			assert.equal(result.name, name);
			assert.equal(result.get('extraProperty'), true);
			break;
		} while (true);
	});

	it('A write to second table should replicate back', async function () {
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
			let result = await test_tables[0].get('3');
			if (!result) {
				assert(--retries > 0);
				continue;
			}
			assert.equal(result.name, name);
			break;
		} while (true);
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
	describe('With third node', function () {
		before(async function () {
			await addWorkerNode(2);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			console.log('added child_process');
		});
		it('A write to the table should replicate to both nodes', async function () {
			let name = 'name ' + Math.random();
			await test_tables[0].put({
				id: '5',
				name,
			});
			await test_tables[0].put({
				id: '2',
				name,
				extraProperty: true,
			});
			let retries = 10;
			do {
				await new Promise((resolve) => setTimeout(resolve, 500));
				let result = await test_tables[2].get('5');
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				assert.equal(result.name, name);
				result = await test_tables[2].get('2');
				assert.equal(result.name, name);
				assert.equal(result.get('extraProperty'), true);
				break;
			} while (true);
		});
		it.skip('A write to the table with sharding defined should replicate to one node', async function () {
			let name = 'name ' + Math.random();
			await test_tables[0].put({
				id: '8',
				name,
				locations: ['node-1', 'node-3'],
			});

			let retries = 10;
			do {
				await new Promise((resolve) => setTimeout(resolve, 500));
				let result = test_tables[1].primaryStore.getBinary('8');
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				// verify that this is a small partial record, and invalidation entry
				assert(result.length < 40);
				result = test_tables[2].primaryStore.getBinary('8');
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				// verify that this is a full record
				assert(result.length > 50);
				break;
			} while (true);
			// now verify that the record can be loaded on-demand
			let result = await test_tables[1].get('8');
			assert.equal(result.name, name);
		});
		it('A write to the table during a broken connection should catch up to both nodes', async function () {
			let name = 'name ' + Math.random();

			for (let server of servers) {
				for (let client of server._ws.clients) {
					client._socket.destroy();
				}
			}

			test_tables[0].put({
				id: '6',
				name,
			});
			await test_tables[0].put({
				id: '7',
				name,
				extraProperty: true,
			});
			console.log('timeout', this.test._timeout);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			let retries = 10;
			do {
				await new Promise((resolve) => setTimeout(resolve, 500));
				let result = await test_tables[2].get('6');
				if (!result) {
					assert(--retries > 0);
					continue;
				}
				assert.equal(result.name, name);
				result = await test_tables[2].get('7');
				assert.equal(result.name, name);
				assert.equal(result.get('extraProperty'), true);
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
