'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const test_utils = require('../../test_utils');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const clustering_utils = require('../../../utility/clustering/clusterUtilities');
const UpdateRemoteResponseObject = require('../../../utility/clustering/UpdateRemoteResponseObject');
const hdb_logger = require('../../../utility/logging/harper_logger');
const env_mgr = require('../../../utility/environment/environmentManager');
const rewire = require('rewire');
const addNode = rewire('../../../utility/clustering/addNode');

describe('Test addNode module', () => {
	const sandbox = sinon.createSandbox();
	let get_node_record_stub;
	let request_stub;
	let upsert_node_record_stub;
	let hdb_log_error_stub;
	let update_work_stream_stub;
	let create_table_streams_stub;
	const test_request = {
		operation: 'add_node',
		node_name: 'remote_node',
		subscriptions: [
			{
				schema: 'breed',
				table: 'beagle',
				subscribe: true,
				publish: true,
			},
			{
				schema: 'country',
				table: 'england',
				subscribe: true,
				publish: false,
			},
			{
				schema: 'dog',
				table: 'poodle',
				subscribe: false,
				publish: true,
			},
		],
	};
	const fake_reply = new UpdateRemoteResponseObject('success', 'Test node successfully added');

	before(() => {
		addNode.__set__('local_node_name', 'local_node');
		test_utils.setGlobalSchema('name', 'breed', 'beagle', ['name', 'age']);
		test_utils.setGlobalSchema('id', 'country', 'england', ['id', 'county']);
		test_utils.setGlobalSchema('number', 'dog', 'poodle', ['number']);
		get_node_record_stub = sandbox.stub(clustering_utils, 'getNodeRecord').resolves([]);
		request_stub = sandbox.stub(nats_utils, 'request').resolves(fake_reply);
		upsert_node_record_stub = sandbox.stub(clustering_utils, 'upsertNodeRecord').resolves();
		hdb_log_error_stub = sandbox.stub(hdb_logger, 'error');
		update_work_stream_stub = sandbox.stub(nats_utils, 'updateWorkStream');
		create_table_streams_stub = sandbox.stub(nats_utils, 'createTableStreams');
		env_mgr.setProperty('clustering_enabled', true);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test addNode happy path', async () => {
		const expected_payload = {
			node_name: 'local_node',
			operation: 'add_node',
			subscriptions: [
				{
					hash_attribute: 'name',
					publish: true,
					schema: 'breed',
					subscribe: true,
					table: 'beagle',
				},
				{
					hash_attribute: 'id',
					publish: true,
					schema: 'country',
					subscribe: false,
					table: 'england',
				},
				{
					hash_attribute: 'number',
					publish: false,
					schema: 'dog',
					subscribe: true,
					table: 'poodle',
				},
			],
		};

		const expected_node_record = {
			name: 'remote_node',
			subscriptions: [
				{
					schema: 'breed',
					table: 'beagle',
					publish: true,
					subscribe: true,
				},
				{
					schema: 'country',
					table: 'england',
					publish: false,
					subscribe: true,
				},
				{
					schema: 'dog',
					table: 'poodle',
					publish: true,
					subscribe: false,
				},
			],
		};
		const result = await addNode(test_request);
		expect(create_table_streams_stub.called).to.be.true;
		expect(request_stub.args[0][0]).to.eql('remote_node.__request__');
		expect(request_stub.args[0][1]).to.eql(expected_payload);
		expect(update_work_stream_stub.getCall(0).args[0]).to.eql(expected_node_record.subscriptions[0]);
		expect(update_work_stream_stub.getCall(0).args[1]).to.eql('remote_node');
		expect(update_work_stream_stub.getCall(1).args[0]).to.eql(expected_node_record.subscriptions[1]);
		expect(update_work_stream_stub.getCall(1).args[1]).to.eql('remote_node');
		expect(update_work_stream_stub.getCall(2).args[0]).to.eql(expected_node_record.subscriptions[2]);
		expect(update_work_stream_stub.getCall(2).args[1]).to.eql('remote_node');
		expect(upsert_node_record_stub.args[0][0]).to.eql(expected_node_record);
		expect(result).to.equal("Successfully added 'remote_node' to manifest");
	});

	it('Test error thrown and record not inserted if error reply from remote node', async () => {
		const error_reply = new UpdateRemoteResponseObject('error', 'Error from remote node');
		request_stub.resolves(error_reply);
		await test_utils.assertErrorAsync(
			addNode,
			[test_request],
			test_utils.generateHDBError('Error returned from remote node remote_node: Error from remote node', 500)
		);
		expect(upsert_node_record_stub.called).to.be.false;
		expect(update_work_stream_stub.called).to.be.false;
	});

	it('Test error is handled correctly if request times out', async () => {
		const fake_timeout_err = new Error();
		fake_timeout_err.code = 'TIMEOUT';
		request_stub.throws(fake_timeout_err);
		await test_utils.assertErrorAsync(
			addNode,
			[test_request],
			test_utils.generateHDBError("Unable to add_node, node 'remote_node' is listening but did not respond.", 500)
		);
		expect(upsert_node_record_stub.called).to.be.false;
		expect(update_work_stream_stub.called).to.be.false;
	});

	it('Test error is thrown if the node record already exists', async () => {
		get_node_record_stub.resolves([{ node_name: 'remote_node' }]);
		await test_utils.assertErrorAsync(
			addNode,
			[test_request],
			test_utils.generateHDBError("Node 'remote_node' has already been added, perform update_node to proceed.", 400)
		);
	});
});
