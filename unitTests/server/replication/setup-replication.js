console.error('starintg setup-replication.js', process.pid);
require('../../test_utils');
const { start, setReplicator, startOnMainThread } = require('../../../server/replication/replicator');
const { table, databases } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const env = require('../../..//utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const { get: env_get } = require('../../../utility/environment/environmentManager');
const { clusterStatus } = require('../../../utility/clustering/clusterStatus');

exports.createTestTable = async function createTestTable(index, database_path) {
	const database_name = 'test-replication-' + index;
	let database_config = env_get(CONFIG_PARAMS.DATABASES);
	if (!database_config) {
		env.setProperty(CONFIG_PARAMS.DATABASES, (database_config = {}));
	}
	database_config[database_name] = { path: database_path };
	databases[database_name] = undefined; // ensure that there is no old database from the wrong path
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
	Object.defineProperty(databases, 'test', { value: databases[database_name], configurable: true });
	TestTable.databaseName = 'test'; // make them all look like the same database so they replicate
	TestTable.getResidency = (record) => {
		return record.locations;
	};
	return TestTable;
};
exports.createNode = async function createNode(index, database_path, node_count) {
	const database_name = 'test-replication-' + index;
	const node_name = 'node-' + (1 + index);
	env.setProperty('replication_nodename', node_name);
	let routes = [];
	for (let i = 0; i < node_count; i++) {
		if (i === index) continue;
		routes.push({
			name: 'node-' + (i + 1),
			url: 'ws://localhost:' + (9325 + i),
		});
	}
	const options = {
		port: 9325 + index,
		url: 'ws://localhost:' + (9325 + index),
		routes,
		databases: {
			test: databases[database_name],
		},
	};
	server.http((request, next_handler) => {
		request.user = { subscribe: true, publish: true }; // the authorization
		return next_handler(request);
	}, options);
	setMainIsWorker(true);
	startOnMainThread(options);
	start(options);
	await listenOnPorts();
	if (!server.operation) {
		server.operation = (request) => {
			if (request.operation === 'cluster_status') {
				return clusterStatus();
			} else throw new Error('not available');
		};
	}
};
