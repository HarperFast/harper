'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const env_mgr = require('../../../utility/environment/environmentManager');
const test_utils = require('../../test_utils');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const crypto_hash = require('../../../security/cryptoHash');
const hdb_terms = require('../../../utility/hdbTerms');
const transaction_log = require('../../../utility/logging/transactionLog');

const TEST_SCHEMA = 'unit_test';
const TEST_TABLE = 'panda';
const TEST_STREAM_NAME = crypto_hash.createNatsTableStreamName(TEST_SCHEMA, TEST_TABLE);

async function closeDeleteNatsCon() {
	await global.NATSConnection.close();
	delete global.NATSConnection;
}

async function createTestStream() {
	await nats_utils.createLocalStream(TEST_STREAM_NAME, [`unit_test.panda.testLeafServer-leaf`]);
	for (let x = 0; x < 99; x++) {
		const entry = [
			{
				operation: 'insert',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				__origin: {
					timestamp: 1652888897398.283,
					user: 'admin',
					node_name: 'david_local',
				},
				records: [
					{
						record: x,
					},
				],
			},
		];

		await nats_utils.publishToStream('unit_test.panda', TEST_STREAM_NAME, entry);
	}

	const del_entry = [
		{
			operation: 'delete',
			schema: TEST_SCHEMA,
			table: TEST_TABLE,
			__origin: {
				timestamp: 1652888897398.283,
				user: 'admin',
				node_name: 'david_local',
			},
			hash_values: [1, 4, 6],
		},
	];

	await nats_utils.publishToStream('unit_test.panda', TEST_STREAM_NAME, del_entry);
}
let timestamps = [];
async function getTimeStamps() {
	const result = await transaction_log.readTransactionLog({
		operation: 'read_transaction_log',
		schema: TEST_SCHEMA,
		table: TEST_TABLE,
	});

	result.forEach((tx) => {
		timestamps.push(tx.timestamp);
	});
}

describe('Test transactionLog module', () => {
	const sandbox = sinon.createSandbox();

	// These tests rely on Nats streams, so we spin up a test nats leaf server.
	before(async function () {
		this.timeout(10000);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, true);
		await test_utils.launchTestLeafServer();
		test_utils.setFakeClusterUser();
		await createTestStream();
		test_utils.setGlobalSchema('id', TEST_SCHEMA, TEST_TABLE, ['id']);
		await getTimeStamps();
	});

	after(async function () {
		this.timeout(10000);
		await nats_utils.deleteLocalStream(TEST_STREAM_NAME);
		test_utils.unsetFakeClusterUser();
		await test_utils.stopTestLeafServer();
		sandbox.restore();
	});

	describe('Test readTransactionLog function', () => {
		it('Test that all transaction logs are returned', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
			};
			const result = await transaction_log.readTransactionLog(test_req);

			expect(result.length).to.equal(100);
			for (let x = 0; x < result.length; x++) {
				const tx = result[x];
				if (x < 99) {
					expect(tx.operation).to.equal('insert');
					expect(tx.user).to.equal('admin');
					expect(tx).to.haveOwnProperty('timestamp');
					expect(tx.records[0].record).to.equal(x);
				} else {
					expect(tx.operation).to.equal('delete');
					expect(tx.user).to.equal('admin');
					expect(tx).to.haveOwnProperty('timestamp');
					expect(tx.hash_values).to.eql([1, 4, 6]);
				}
			}
		}).timeout(10000);

		it('Test limit filter works', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 50,
			};
			const result = await transaction_log.readTransactionLog(test_req);

			expect(result.length).to.equal(50);
			expect(result[0].timestamp).to.equal(timestamps[0]);
			expect(result[25].timestamp).to.equal(timestamps[25]);
			expect(result[49].timestamp).to.equal(timestamps[49]);
		}).timeout(10000);

		it('Test to filter works', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				to: timestamps[20],
			};
			const result = await transaction_log.readTransactionLog(test_req);

			expect(result[result.length - 1].records[0]).to.eql({ record: 20 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[20]);
			expect(result[0].timestamp).to.equal(timestamps[0]);
		});

		it('Test from filter works', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				from: timestamps[90],
			};
			const result = await transaction_log.readTransactionLog(test_req);

			expect(result[0].timestamp).to.equal(timestamps[90]);
			expect(result[result.length - 1].timestamp).to.equal(timestamps[99]);
		});

		it('Test to and from filters', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				to: timestamps[55],
				from: timestamps[40],
			};
			const result = await transaction_log.readTransactionLog(test_req);

			expect(result[0].timestamp).to.equal(timestamps[40]);
			expect(result[0].records[0]).to.eql({ record: 40 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[55]);
			expect(result[result.length - 1].records[0]).to.eql({ record: 55 });
		});

		it('Test limit and from filters', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 20,
				from: timestamps[40],
			};
			const result = await transaction_log.readTransactionLog(test_req);

			expect(result.length).to.equal(20);
			expect(result[0].timestamp).to.equal(timestamps[40]);
			expect(result[0].records[0]).to.eql({ record: 40 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[59]);
			expect(result[result.length - 1].records[0]).to.eql({ record: 59 });
		});

		it('Test limit and from filters end of log', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 20,
				from: timestamps[90],
			};
			const result = await transaction_log.readTransactionLog(test_req);

			expect(result.length).to.equal(10);
			expect(result[0].timestamp).to.equal(timestamps[90]);
			expect(result[0].records[0]).to.eql({ record: 90 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[99]);
			expect(result[result.length - 1].hash_values).to.eql([1, 4, 6]);
		});

		it('Test to, from and limit filter', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 13,
				from: timestamps[0],
				to: timestamps[12],
			};
			const result = await transaction_log.readTransactionLog(test_req);
			expect(result[0].records[0]).to.eql({ record: 0 });
			expect(result[0].timestamp).to.equal(timestamps[0]);
			expect(result[result.length - 1].timestamp).to.equal(timestamps[12]);
		});

		it('Test to and limit filter', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 23,
				to: timestamps[50],
			};
			const result = await transaction_log.readTransactionLog(test_req);
			expect(result.length).to.equal(23);
		});
	});
});
