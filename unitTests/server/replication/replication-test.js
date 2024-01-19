require('../../test_utils');
const assert = require('assert');
const sinon = require('sinon');
const { start, setReplicator } = require('../../../server/replication/replicator');
const { table } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const { listenOnPorts } = require('../../../server/threads/threadServer');

describe('Replication', () => {
	let TestTable;
	const test_tables = [];
	setMainIsWorker(true);
	before(async () => {
		const NODE_COUNT = 2;
		async function createNode(index) {
			let nodes = []
			for (let i = 0; i < NODE_COUNT; i++) {
				if (i === index) continue;
				nodes.push({
					id: 'node-' + i,
					url: 'ws://localhost:' + (9325 + i),
				});
			}
			TestTable = table({
				table: 'TestTable',
				database: 'test-replication-' + index,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'name', indexed: true },
				],
			});
			TestTable.databaseName = 'test'; // make them all look like the same database so they replicate
			test_tables.push(TestTable);

			start({
				port: 9325 + index,
				databases: {
					test: { TestTable },
				},
				manualAssignment: true,
				nodeId: index + 10,
			});

			setReplicator('test', 'TestTable', TestTable, {
				nodes,
			});
		}
		for (let i = 0; i < NODE_COUNT; i++) await createNode(i);
		await listenOnPorts();
		await new Promise((resolve) => setTimeout(resolve, 1000));
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});

	it('A write to one table should replicate', async () => {
		await test_tables[0].put({
			id: '1',
			name: 'name1',
		});
		await new Promise((resolve) => setTimeout(resolve, 10000));
		test_tables[1].get('1');
	});
});
