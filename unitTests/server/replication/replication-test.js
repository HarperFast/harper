require('../../test_utils');
const assert = require('assert');
const sinon = require('sinon');
const { start, setReplicator } = require('../../../server/replication/replicator');
const { table } = require('../../../resources/databases');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
require('../../../server/threads/threadServer');

describe('Replication', () => {
	let TestTable;
	const test_tables = [];
	setMainIsWorker(true);
	before(async () => {
		const NODE_COUNT = 2;
		function createNode(index) {
			let nodes = table({
				table: 'hdb_nodes',
				database: 'test-replication-' + index,
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			for (let i = 0; i < NODE_COUNT; i++) {
				if (i === index) continue;
				nodes.put({
					name: 'node-' + i,
					subscriptions: [{ schema: 'test', table: 'TestTable', publish: true, subscribe: true }],
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
			test_tables.push(TestTable);

			start({
				port: 19925 + index,
				databases: {
					test: { TestTable },
				},
			});

			setReplicator('test', 'TestTable', TestTable, {
				nodes,
			});
		}
		for (let i = 0; i < NODE_COUNT; i++) createNode(i);
	});
	beforeEach(async () => {
		//await removeAllSchemas();
	});

	it('A write to one table should replicate', async () => {
		test_tables[0].put({
			id: '1',
			name: 'name1',
		});
		await new Promise((resolve) => setTimeout(resolve, 1000));
		test_tables[1].get('1');
	});
});
