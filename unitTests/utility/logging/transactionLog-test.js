/*
'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const env_mgr = require('../../../utility/environment/environmentManager');
const test_utils = require('../../test_utils');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const hdb_utils = require('../../../utility/common_utils');
const crypto_hash = require('../../../security/cryptoHash');
const hdb_terms = require('../../../utility/hdbTerms');
const transaction_log = require('../../../utility/logging/transactionLog');

const TEST_SCHEMA = 'unit_test';
const TEST_TABLE = 'panda';
const TEST_STREAM_NAME = crypto_hash.createNatsTableStreamName(TEST_SCHEMA, TEST_TABLE);
const TEST_TIMEOUT = 10000;

/!**
 * Create a test stream and publishes 100 messages to it.
 * @returns {Promise<void>}
 *!/
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

		await nats_utils.publishToStream('unit_test.panda', TEST_STREAM_NAME, undefined, entry);
		// Make sure there is gap to ensure that each entry has a unique timestamp
		await hdb_utils.async_set_timeout(50);
	}

	const del_entry = {
		operation: 'delete',
		schema: TEST_SCHEMA,
		table: TEST_TABLE,
		__origin: {
			timestamp: 1652888897398.283,
			user: 'admin',
			node_name: 'david_local',
		},
		hash_values: [1, 4, 6],
	};

	await nats_utils.publishToStream('unit_test.panda', TEST_STREAM_NAME, undefined, del_entry);
}

/!**
 * Get all the timestamps in the test stream so that they can be used for testing.
 * @type {*[]}
 *!/
let timestamps;
async function getTimeStamps() {
	timestamps = [];
	const transactions = await transaction_log.readTransactionLog({
		operation: 'read_transaction_log',
		schema: TEST_SCHEMA,
		table: TEST_TABLE,
	});

	for await (const tx of transactions) {
		timestamps.push(tx.timestamp);
	}
}

/!**
 * Reset the state of the test stream.
 * @returns {Promise<void>}
 *!/
async function resetStream() {
	const jsm = await nats_utils.getJetStreamManager();
	await jsm.streams.purge(TEST_STREAM_NAME);
	await createTestStream();
	await getTimeStamps();
}

/!**
 * Accumulates transaction log messages into an array
 * @param req
 * @returns {Promise<*[]>}
 *!/
async function transactionLogArray(req) {
	const transactions = await transaction_log.readTransactionLog(req);
	let result = [];
	for await (const tx of transactions) {
		result.push(tx);
	}

	return result;
}

describe('Test transactionLog module', () => {
	const sandbox = sinon.createSandbox();

	// These tests rely on Nats streams, so we spin up a test nats leaf server.
	before(async function () {
		this.timeout(TEST_TIMEOUT);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, true);
		await test_utils.launchTestLeafServer();
		test_utils.setFakeClusterUser();
		await createTestStream();
		test_utils.setGlobalSchema('id', TEST_SCHEMA, TEST_TABLE, ['id']);
		await getTimeStamps();
	});

	after(async function () {
		this.timeout(TEST_TIMEOUT);
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
			const transactions = await transaction_log.readTransactionLog(test_req);

			const result = [];
			let x = 0;
			for await (const tx of transactions) {
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
				x++;
				result.push(tx);
			}

			expect(result.length).to.equal(100);
		}).timeout(TEST_TIMEOUT);

		it('Test limit filter works', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 50,
			};

			const result = await transactionLogArray(test_req);

			expect(result.length).to.equal(50);
			expect(result[0].timestamp).to.equal(timestamps[0]);
			expect(result[25].timestamp).to.equal(timestamps[25]);
			expect(result[49].timestamp).to.equal(timestamps[49]);
		}).timeout(TEST_TIMEOUT);

		it('Test to filter works', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				to: timestamps[20],
			};
			const result = await transactionLogArray(test_req);

			expect(result[result.length - 1].records[0]).to.eql({ record: 20 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[20]);
			expect(result[0].timestamp).to.equal(timestamps[0]);
		}).timeout(TEST_TIMEOUT);

		it('Test from filter works', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				from: timestamps[90],
			};
			const result = await transactionLogArray(test_req);

			expect(result[0].timestamp).to.equal(timestamps[90]);
			expect(result[result.length - 1].timestamp).to.equal(timestamps[99]);
		}).timeout(TEST_TIMEOUT);

		it('Test to and from filters', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				to: timestamps[55],
				from: timestamps[40],
			};
			const result = await transactionLogArray(test_req);

			expect(result[0].timestamp).to.equal(timestamps[40]);
			expect(result[0].records[0]).to.eql({ record: 40 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[55]);
			expect(result[result.length - 1].records[0]).to.eql({ record: 55 });
		}).timeout(TEST_TIMEOUT);

		it('Test limit and from filters', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 20,
				from: timestamps[40],
			};
			const result = await transactionLogArray(test_req);

			expect(result.length).to.equal(20);
			expect(result[0].timestamp).to.equal(timestamps[40]);
			expect(result[0].records[0]).to.eql({ record: 40 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[59]);
			expect(result[result.length - 1].records[0]).to.eql({ record: 59 });
		}).timeout(TEST_TIMEOUT);

		it('Test limit and from filters end of log', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 20,
				from: timestamps[90],
			};
			const result = await transactionLogArray(test_req);

			expect(result.length).to.equal(10);
			expect(result[0].timestamp).to.equal(timestamps[90]);
			expect(result[0].records[0]).to.eql({ record: 90 });
			expect(result[result.length - 1].timestamp).to.equal(timestamps[99]);
			expect(result[result.length - 1].hash_values).to.eql([1, 4, 6]);
		}).timeout(TEST_TIMEOUT);

		it('Test to, from and limit filter', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 13,
				from: timestamps[0],
				to: timestamps[12],
			};
			const result = await transactionLogArray(test_req);

			expect(result[0].records[0]).to.eql({ record: 0 });
			expect(result[0].timestamp).to.equal(timestamps[0]);
			expect(result[result.length - 1].timestamp).to.equal(timestamps[12]);
		}).timeout(TEST_TIMEOUT);

		it('Test to and limit filter', async () => {
			const test_req = {
				operation: 'read_transaction_log',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				limit: 23,
				to: timestamps[50],
			};
			const result = await transactionLogArray(test_req);

			expect(result.length).to.equal(23);
		}).timeout(TEST_TIMEOUT);
	});

	describe('Test deleteTransactionLogsBefore function', () => {
		let reset_stream = false;
		it('Test that no logs are deleted if timestamp less than oldest log', async () => {
			const test_req = {
				operation: 'delete_transaction_logs_before',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				timestamp: timestamps[0],
			};
			const result = await transaction_log.deleteTransactionLogsBefore(test_req);
			const stream = await nats_utils.viewStream(TEST_STREAM_NAME);

			expect(result).to.equal(`No transactions exist before: ${timestamps[0]}`);
			expect(stream.length).to.equal(100);
		}).timeout(TEST_TIMEOUT);

		it('Test all logs are deleted if timestamp greater than most recent logs', async () => {
			reset_stream = true;
			const test_req = {
				operation: 'delete_transaction_logs_before',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				timestamp: timestamps[99] + 1,
			};
			const result = await transaction_log.deleteTransactionLogsBefore(test_req);
			const stream = await nats_utils.viewStream(TEST_STREAM_NAME);

			expect(result).to.equal('All logs successfully deleted from transaction log.');
			expect(stream.length).to.equal(0);
		}).timeout(TEST_TIMEOUT);

		it('Test partial deletion of logs', async () => {
			if (reset_stream) {
				await resetStream();
			}

			const test_req = {
				operation: 'delete_transaction_logs_before',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				timestamp: timestamps[50],
			};

			const result = await transaction_log.deleteTransactionLogsBefore(test_req);
			const stream = await nats_utils.viewStream(TEST_STREAM_NAME);
			reset_stream = true;

			expect(result).to.equal('Logs successfully deleted from transaction log.');
			expect(stream.length).to.equal(50);
		}).timeout(TEST_TIMEOUT);

		it('Two partial deletes of logs', async () => {
			if (reset_stream) {
				await resetStream();
			}

			const test_req = {
				operation: 'delete_transaction_logs_before',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				timestamp: timestamps[25],
			};

			const result = await transaction_log.deleteTransactionLogsBefore(test_req);
			const stream = await nats_utils.viewStream(TEST_STREAM_NAME);

			expect(result).to.equal('Logs successfully deleted from transaction log.');
			expect(stream.length).to.equal(75);

			const test_req_b = {
				operation: 'delete_transaction_logs_before',
				schema: TEST_SCHEMA,
				table: TEST_TABLE,
				timestamp: timestamps[30],
			};

			const result_b = await transaction_log.deleteTransactionLogsBefore(test_req_b);
			const stream_b = await nats_utils.viewStream(TEST_STREAM_NAME);
			reset_stream = true;

			expect(result_b).to.equal('Logs successfully deleted from transaction log.');
			expect(stream_b.length).to.equal(70);
		}).timeout(TEST_TIMEOUT);
	});
});
*/
