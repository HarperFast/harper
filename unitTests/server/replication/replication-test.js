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
			let routes = [];
			for (let i = 0; i < NODE_COUNT; i++) {
				if (i === index) continue;
				routes.push({
					id: 'route-' + i,
					url: 'ws://localhost:' + (9325 + i),
				});
			}
			const database_name = 'test-replication-' + index;
			TestTable = table({
				table: 'TestTable',
				database: database_name,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'name', indexed: true },
				],
			});
			TestTable.databaseName = 'test'; // make them all look like the same database so they replicate
			test_tables.push(TestTable);
			const database_subscriptions = new Map(); // each node gets its own set of subscriptions
			start({
				port: 9325 + index,
				tables: { TestTable },
				databaseSubscriptions: database_subscriptions,
				manualAssignment: true,
				nodeName: index + 10,
			});

			setReplicator('test', TestTable, {
				routes,
				databaseSubscriptions: database_subscriptions,
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
		await new Promise((resolve) => setTimeout(resolve, 1000));
		let result = test_tables[1].get('1');
		assert.equal(result.name, 'name1');
	});
});
