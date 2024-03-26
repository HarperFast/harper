require('../../test_utils');
const { start, setReplicator } = require('../../../server/replication/replicator');
const { table, databases } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const { workerData, parentPort } = require('worker_threads');
const env = require('../../..//utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');

async function createNode(index, node_count) {
	try {
		let routes = [];
		for (let i = 0; i < node_count; i++) {
			if (i === index) continue;
			routes.push({
				id: 'route-' + i,
				url: 'ws://localhost:' + (9325 + i),
			});
		}
		const database_name = 'test-replication-' + index;
		env.setProperty(CONFIG_PARAMS.DATABASES, { [database_name]: { path: workerData.databasePath }});
		const TestTable = table({
			table: 'TestTable',
			database: database_name,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		Object.defineProperty(databases, 'test', { value: databases[database_name] });
		TestTable.databaseName = 'test'; // make them all look like the same database so they replicate
		setReplicator('test', TestTable, {
			routes,
		});
		start({
			port: 9325 + index,
			tables: { TestTable },
			manualAssignment: true,
			nodeName: index + 10,
		});

		await listenOnPorts();
		//await new Promise((resolve) => setTimeout(resolve, 1000));
		parentPort.postMessage({type: 'replication-started'});
		parentPort.on('message', (message) => {
			if (message.action === 'put') {
				TestTable.put(message.data);
			}
		});
	}catch(e){
		console.error(e)
	}
}
createNode(workerData.index, workerData.nodeCount);
