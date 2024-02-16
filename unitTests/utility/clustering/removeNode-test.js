'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const test_utils = require('../../test_utils');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const clustering_utils = require('../../../utility/clustering/clusterUtilities');
const env_mgr = require('../../../utility/environment/environmentManager');
const UpdateRemoteResponseObject = require('../../../utility/clustering/UpdateRemoteResponseObject');
const _delete = require('../../../dataLayer/delete');
const remove_node = rewire('../../../utility/clustering/removeNode');

describe('Test removeNode module', () => {
	const sandbox = sinon.createSandbox();
	let get_node_record_stub;
	let request_stub;
	let delete_stub;
	let update_remote_consumer_stub;
	let update_consumer_iterator_stub;
	const test_request = {
		operation: 'remove_node',
		node_name: 'node1_test',
	};

	const fake_record = [
		{
			name: 'node1_test',
			subscriptions: [
				{
					schema: 'country',
					table: 'england',
					subscribe: false,
					publish: true,
				},
				{
					schema: 'dog',
					table: 'poodle',
					subscribe: true,
					publish: true,
				},
				{
					schema: 'reptile',
					table: 'crocodilia',
					subscribe: true,
					publish: false,
				},
			],
		},
	];

	const fake_reply = new UpdateRemoteResponseObject('success', 'Test node successfully removed');

	before(() => {
		remove_node.__set__('node_name', 'node1_test');
		get_node_record_stub = sandbox.stub(clustering_utils, 'getNodeRecord').resolves(fake_record);
		request_stub = sandbox.stub(nats_utils, 'request').resolves(fake_reply);
		delete_stub = sandbox.stub(_delete, 'deleteRecord').resolves();
		update_remote_consumer_stub = sandbox.stub(nats_utils, 'updateRemoteConsumer');
		update_consumer_iterator_stub = sandbox.stub(nats_utils, 'updateConsumerIterator');
		env_mgr.setProperty('clustering_enabled', true);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test all the things are called as expected happy path', async () => {
		const expected_payload = {
			operation: 'remove_node',
			node_name: 'node1_test',
			subscriptions: [],
			system_info: undefined,
		};
		const result = await remove_node(test_request);
		expect(request_stub.args[0][0]).to.eql('node1_test.__request__');
		expect(request_stub.args[0][1]).to.eql(expected_payload);
		expect(delete_stub.args[0][0]).to.eql({
			operation: 'delete',
			schema: 'system',
			table: 'hdb_nodes',
			hash_values: ['node1_test'],
			__origin: undefined,
		});
		expect(update_consumer_iterator_stub.callCount).to.equal(2);
		expect(update_consumer_iterator_stub.args).to.eql([
			['dog', 'poodle', 'node1_test', 'stop'],
			['reptile', 'crocodilia', 'node1_test', 'stop'],
		]);
		expect(update_remote_consumer_stub.callCount).to.equal(3);
		expect(update_remote_consumer_stub.args).to.eql([
			[
				{
					schema: 'country',
					table: 'england',
					publish: false,
					subscribe: false,
				},
				'node1_test',
			],
			[
				{
					schema: 'dog',
					table: 'poodle',
					publish: false,
					subscribe: false,
				},
				'node1_test',
			],
			[
				{
					schema: 'reptile',
					table: 'crocodilia',
					publish: false,
					subscribe: false,
				},
				'node1_test',
			],
		]);
	});

	it('Test error from request to remote node doesnt stop remove node', async () => {
		const error_reply = new UpdateRemoteResponseObject('error', 'Error from remote node');
		request_stub.resolves(error_reply);
		await remove_node(test_request);
		expect(delete_stub.called).to.be.true;
		expect(update_consumer_iterator_stub.callCount).to.equal(2);
		expect(update_consumer_iterator_stub.args).to.eql([
			['dog', 'poodle', 'node1_test', 'stop'],
			['reptile', 'crocodilia', 'node1_test', 'stop'],
		]);
		expect(update_remote_consumer_stub.callCount).to.equal(3);
		expect(update_remote_consumer_stub.args).to.eql([
			[
				{
					schema: 'country',
					table: 'england',
					publish: false,
					subscribe: false,
				},
				'node1_test',
			],
			[
				{
					schema: 'dog',
					table: 'poodle',
					publish: false,
					subscribe: false,
				},
				'node1_test',
			],
			[
				{
					schema: 'reptile',
					table: 'crocodilia',
					publish: false,
					subscribe: false,
				},
				'node1_test',
			],
		]);
	});

	it('Test if no remote nodes listening local node proceeds with removal', async () => {
		const fake_no_response_err = new Error();
		fake_no_response_err.code = '503';
		request_stub.throws(fake_no_response_err);
		await remove_node(test_request);
		expect(delete_stub.called).to.be.true;
		expect(update_consumer_iterator_stub.callCount).to.equal(2);
		expect(update_remote_consumer_stub.callCount).to.equal(3);
	});

	it('Test error is thrown if the node record does not exist', async () => {
		get_node_record_stub.resolves([]);
		await test_utils.assertErrorAsync(
			remove_node,
			[test_request],
			test_utils.generateHDBError("Node 'node1_test' was not found.", 400)
		);
	});
});
