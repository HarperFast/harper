require('../../test_utils');
const assert = require('assert');
const sinon = require('sinon');
const { start, setReplicator } = require('../../../server/replication/replicator');
const { table } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const { Worker } = require('worker_threads');
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const { get: env_get } = require('../../..//utility/environment/environmentManager');

describe('Replication', () => {
	let TestTable;
	const test_tables = [];
	let workers = [];
	setMainIsWorker(true);
	before(async function () {
		this.timeout(1000009);
		const NODE_COUNT = 2;
		const database_config = env_get(CONFIG_PARAMS.DATABASES);
		for (let i = 0; i < NODE_COUNT; i++) {
			const database_name = i == 0 ? 'test' : 'test-replication-' + i;
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
			test_tables.push(TestTable);
		}
		TestTable = test_tables[0];

		async function createNode(index, node_count) {
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
		await createNode(0, NODE_COUNT);
		let worker = new Worker(__filename.replace(/\.js/, '-thread.js'), {
			workerData: {
				index: 1,
				workerIndex: 1,
				nodeCount: NODE_COUNT,
				databasePath: database_config.data.path + '/test-replication-' + 1,
				noServerStart: true,
			},
		});
		workers.push(worker);
		let started = new Promise((resolve) => {
			worker.on('message', (message) => {
				console.log('message from worker:', message);
				if (message.type === 'replication-started') resolve();
			});
		});
		worker.on('error', (error) => {
			console.log('error from worker:', error);
		});
		await listenOnPorts();
		await started;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});
	it('A write to one table should replicate', async function () {
		this.timeout(100000);
		await test_tables[0].put({
			id: '1',
			name: 'name1',
		});
		await test_tables[0].put({
			id: '2',
			name: 'name2',
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		let result = await test_tables[1].get('1');
		assert.equal(result.name, 'name1');
		result = await test_tables[1].get('2');
		assert.equal(result.name, 'name2');
	});
	after(() => {
		for (const worker of workers) {
			worker.terminate();
		}
	});
});
