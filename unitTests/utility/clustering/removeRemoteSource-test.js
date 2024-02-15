'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const clustering_utils = require('../../../utility/clustering/clusterUtilities');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const _delete = require('../../../dataLayer/delete');
const removeRemoteSource = rewire('../../../utility/clustering/removeRemoteSource');

describe('Test removeRemoteSource module', () => {
	const sandbox = sinon.createSandbox();
	let get_node_record_stub;
	let delete_stub;
	const test_node_name = 'nodeAbc-test';
	const test_payload = {
		operation: 'remove_node',
		node_name: test_node_name,
		subscriptions: [],
	};

	const fake_record = [
		{
			name: test_node_name,
			subscriptions: [
				{
					schema: 'country',
					table: 'england',
					subscribe: false,
					publish: true,
				},
				{
					schema: 'sheep',
					table: 'name',
					subscribe: true,
					publish: true,
				},
			],
		},
	];
	let update_remote_consumer_stub;
	let update_consumer_iterator_stub;

	before(() => {
		removeRemoteSource.__set__('node_name', 'local_test_node');
		get_node_record_stub = sandbox.stub(clustering_utils, 'getNodeRecord').resolves(fake_record);
		delete_stub = sandbox.stub(_delete, 'deleteRecord').resolves();
		update_remote_consumer_stub = sandbox.stub(nats_utils, 'updateRemoteConsumer');
		update_consumer_iterator_stub = sandbox.stub(nats_utils, 'updateConsumerIterator');
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test removeRemoteSource function call all the things successfully for happy path', async () => {
		const result = await removeRemoteSource(test_payload);
		expect(get_node_record_stub.args[0][0]).to.equal(test_node_name);
		expect(delete_stub.args[0][0]).to.eql({
			operation: 'delete',
			schema: 'system',
			table: 'hdb_nodes',
			hash_values: [test_node_name],
			__origin: undefined,
		});
		expect(result).to.eql({
			message: "Node local_test_node successfully removed node 'nodeAbc-test'.",
			status: 'success',
			system_info: undefined,
		});
		expect(update_remote_consumer_stub.callCount).to.equal(2);
		expect(update_remote_consumer_stub.args).to.eql([
			[
				{
					schema: 'country',
					table: 'england',
					publish: false,
					subscribe: false,
				},
				'nodeAbc-test',
			],
			[
				{
					schema: 'sheep',
					table: 'name',
					publish: false,
					subscribe: false,
				},
				'nodeAbc-test',
			],
		]);
		expect(update_consumer_iterator_stub.callCount).to.equal(2);
		expect(update_consumer_iterator_stub.args).to.eql([
			['country', 'england', 'nodeAbc-test', 'stop'],
			['sheep', 'name', 'nodeAbc-test', 'stop'],
		]);
	});

	it('Test record not found error returned if no record found', async () => {
		get_node_record_stub.resolves([]);
		const result = await removeRemoteSource(test_payload);
		expect(result).to.eql({
			message: "No record found for node 'nodeAbc-test'",
			status: 'error',
			system_info: undefined,
		});
	});

	it('It test error thrown from get record is handled correctly', async () => {
		get_node_record_stub.throws(new Error('Error in HDB'));
		const result = await removeRemoteSource(test_payload);
		expect(result).to.eql({
			message: 'Error in HDB',
			status: 'error',
			system_info: undefined,
		});
	});
});
