require('../../test_utils');
const { start, setReplicator, startOnMainThread } = require('../../../server/replication/replicator');
const { table, databases } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const env = require('../../..//utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');
const { get: env_get } = require('../../../utility/environment/environmentManager');
const { clusterStatus } = require('../../../utility/clustering/clusterStatus');
const logger = require('../../../utility/logging/harper_logger');

const DATABASE_NAME = 'test';

exports.createTestTable = async function createTestTable(database_path, table_name = 'TestTable') {
	let database_config = env_get(CONFIG_PARAMS.DATABASES);
	if (!database_config) {
		env.setProperty(CONFIG_PARAMS.DATABASES, (database_config = {}));
	}
	database_config[DATABASE_NAME] = { path: database_path };
	databases[DATABASE_NAME] = undefined; // ensure that there is no old database from the wrong path
	const TestTable = table({
		table: table_name,
		database: DATABASE_NAME,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'name', indexed: true },
		],
	});
	// wait for the database to be resynced
	logger.info('Created TestTable', TestTable.databaseName, TestTable.databasePath, Object.keys(databases));
	await new Promise((resolve) => setTimeout(resolve, 10));
	let originalGetResidency = TestTable.getResidency;
	TestTable.setResidency((record, context) => {
		return record.locations ?? originalGetResidency(record, context);
	});
	return TestTable;
};
exports.createNode = async function createNode(index, database_path, node_count) {
	const node_name = 'node-' + (1 + index);
	env.setProperty('replication_hostname', node_name);
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
		shard: index + 1,
		databases: ['test'],
	};
	server.http((request, next_handler) => {
		request.user = { replicates: true }; // the authorization
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
