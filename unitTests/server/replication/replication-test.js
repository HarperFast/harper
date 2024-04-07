const assert = require('assert');
const sinon = require('sinon');
const { getMockLMDBPath } = require('../../test_utils');
const { start, setReplicator, servers } = require('../../../server/replication/replicator');
const { table, databases } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const { Worker, workerData } = require('worker_threads');
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const { get: env_get } = require('../../..//utility/environment/environmentManager');
const env = require('../../../utility/environment/environmentManager');

describe('Replication', () => {
	let TestTable;
	const test_tables = [];
	let workers = [];
	let node_count = 2;
	let db_count = 3;
	let database_config;
	setMainIsWorker(true);
	function addWorkerNode(index) {
		let worker = new Worker(__filename.replace(/\.js/, '-thread.js'), {
			workerData: {
				index,
				workerIndex: 0, // just used to indicate that it is below the max ingest thread
				nodeCount: node_count,
				nodeName: 'node-' + (index + 1),
				databasePath: database_config.data.path + '/test-replication-' + index,
				noServerStart: true,
			},
		});
		workers.push(worker);
		worker.on('error', (error) => {
			console.log('error from worker:', error);
		});
		return new Promise((resolve) => {
			worker.on('message', (message) => {
				console.log('message from worker:', message);
				if (message.type === 'replication-started') resolve();
			});
		});
	}
	before(async function () {
		this.timeout(1000009);
		getMockLMDBPath();
		database_config = env_get(CONFIG_PARAMS.DATABASES);
		for (let i = 0; i < db_count; i++) {
			const database_name = 'test-replication-' + i;
			database_config[database_name] = { path: database_config.data.path + '/test-replication-' + i };
			let TestTable = table({
				table: 'TestTable',
				database: database_name,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'name', indexed: true },
				],
			});
			TestTable.databaseName = database_name; // make them all look like the same database so they replicate
			TestTable.getResidency = (record) => {
				return record.locations;
			};
			test_tables.push(TestTable);
		}
		env.setProperty('replication_nodename', 'node-1');
		Object.defineProperty(databases, 'test', { value: databases['test-replication-0'] });
		TestTable = test_tables[0];

		async function createServer(index, node_count) {
			let routes = [];
			for (let i = 0; i < node_count; i++) {
				if (i === index) continue;
				routes.push({
					id: 'route-' + i,
					url: 'ws://localhost:' + (9325 + i),
				});
			}
			TestTable = test_tables[index];
			start({
				port: 9325 + index,
				tables: { TestTable },
				manualAssignment: true,
				nodeName: index + 10,
			});

			setReplicator('test', TestTable, {
				routes,
			});
		}
		await createServer(0, node_count);
		let started = addWorkerNode(1);
		await listenOnPorts();
		await started;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});
	it('A write to one table should replicate', async function () {
		this.timeout(100000);
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
		this.timeout(100000);
		let name = 'name ' + Math.random();
		workers[0].postMessage({
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
	describe('With third node', function () {
		before(async function () {
			this.timeout(1000000);
			await addWorkerNode(2);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			console.log('added worker');
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
		it('A write to the table with sharding defined should replicate to one node', async function () {
			let name = 'name ' + Math.random();
			await test_tables[0].put({
				id: '8',
				name,
				locations: ['node-1', 'node-3'],
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
		it.skip('A write to the table during a broken connection should catch up to both nodes', async function () {
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
		for (const worker of workers) {
			worker.terminate();
		}
	});
});
