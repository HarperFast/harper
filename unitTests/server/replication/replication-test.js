import whyIsNodeStillRunning from 'why-is-node-still-running';
import { assert, expect } from 'chai';
import axios from 'axios';
import { start, setReplicator } from '../../ts-build/server/replication/replication.js';
import { getVariables } from './utility.js';
import { setupTestApp } from './setupTestApp.mjs';
const { authorization, url } = getVariables();

describe('Replication', () => {
	let TestTable;
	before(async () => {
		await setupTestApp();
		const NODE_COUNT = 2;
		const test_tables = [];
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

	it('do get with JSON', async () => {
		test_tables[0].put({
			id: '1',
			name: 'name1',
		});
		await new Promise((resolve) => setTimeout(resolve, 1000));
		test_tables[1].get('1');
	});
});
