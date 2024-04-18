require('../../test_utils');
const { start, setReplicator, startOnMainThread } = require('../../../server/replication/replicator');
const { table, databases } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const env = require('../../..//utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');

async function createNode(index, database_path, node_count) {
	try {
		let routes = [];
		for (let i = 0; i < node_count; i++) {
			if (i === index) continue;
			routes.push({
				name: 'node-' + (i + 1),
				url: 'ws://localhost:' + (9325 + i),
			});
		}
		const database_name = 'test-replication-' + index;
		env.setProperty(CONFIG_PARAMS.DATABASES, { [database_name]: { path: database_path } });
		env.setProperty('replication_nodename', 'node-' + (1 + index));
		const TestTable = table({
			table: 'TestTable',
			database: database_name,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		// wait for the database to be resynced
		await new Promise((resolve) => setTimeout(resolve, 10));
		Object.defineProperty(databases, 'test', { value: databases[database_name] });
		TestTable.databaseName = 'test'; // make them all look like the same database so they replicate
		TestTable.getResidency = (record) => {
			return record.locations;
		};
		const options = {
			port: 9325 + index,
			url: 'ws://localhost:' + (9325 + index),
			routes,
			databases: {
				test: databases[database_name],
			},
		};
		startOnMainThread(options);
		start(options);

		await listenOnPorts();
		//await new Promise((resolve) => setTimeout(resolve, 1000));
		process.send({ type: 'replication-started' });
		process.on('message', (message) => {
			if (message.action === 'put') {
				TestTable.put(message.data);
			}
		});
	} catch (e) {
		console.error(e);
	}
}
createNode(+process.argv[2], process.argv[3], 3);
