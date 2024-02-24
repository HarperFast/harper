try {
require('../../test_utils');
const { start, setReplicator } = require('../../../server/replication/replicator');
const { table } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');
const { workerData, parentPort } = require('worker_threads');
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
	const TestTable = table({
		table: 'TestTable',
		database: database_name,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'name', indexed: true },
		],
	});
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
}catch(e){
	console.error(e)
}
}
createNode(workerData.index, workerData.nodeCount);
}catch(e){
	console.error(e)
}