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
const updateNode = rewire('../../../utility/clustering/updateNode');

describe('Test updateNode module', () => {
	const sandbox = sinon.createSandbox();
	let get_node_record_stub;
	let request_stub;
	let upsert_node_record_stub;
	let hdb_log_error_stub;
	let update_work_stream_stub;
	let create_table_streams_stub;
	const test_request = {
		operation: 'update_node',
		node_name: 'remote_node_test',
		subscriptions: [
			{
				schema: 'country',
				table: 'england',
				subscribe: true,
				publish: false,
				start_time: '2022-08-26T18:26:58.514Z',
			},
			{
				schema: 'dog',
				table: 'poodle',
				subscribe: true,
				publish: true,
			},
		],
	};

	const test_existing_record = [
		{
			name: 'remote_node_test',
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
	const test_sys_info = {
		hdb_version: '4.0.0test',
		node_version: '16.15.0',
		platform: 'test platform',
	};
	const fake_reply = new UpdateRemoteResponseObject('success', 'Test node successfully updated', test_sys_info);

	before(() => {
		sandbox.stub(clustering_utils, 'getSystemInfo').resolves(test_sys_info);
		updateNode.__set__('local_node_name', 'local_node');
		delete global.hdb_schema;
		test_utils.setGlobalSchema('name', 'reptile', 'crocodilia', ['name', 'age']);
		test_utils.setGlobalSchema('id', 'country', 'england', ['id', 'county']);
		test_utils.setGlobalSchema('number', 'dog', 'poodle', ['number']);
		get_node_record_stub = sandbox.stub(clustering_utils, 'getNodeRecord').resolves(test_existing_record);
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

	it('Test updateNode calls all the things correctly happy path', async () => {
		const expected_payload = {
			node_name: 'local_node',
			operation: 'update_node',
			subscriptions: [
				{
					hash_attribute: 'id',
					publish: true,
					schema: 'country',
					subscribe: false,
					table: 'england',
					start_time: '2022-08-26T18:26:58.514Z',
				},
				{
					hash_attribute: 'number',
					publish: true,
					schema: 'dog',
					subscribe: true,
					table: 'poodle',
					start_time: undefined,
				},
			],
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		};
		const expected_node_record = {
			name: 'remote_node_test',
			subscriptions: [
				{
					schema: 'country',
					table: 'england',
					subscribe: true,
					publish: false,
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
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		};
		const result = await updateNode(test_request);
		expect(create_table_streams_stub.called).to.be.true;
		expect(request_stub.args[0][0]).to.eql('remote_node_test.__request__');
		expect(request_stub.args[0][1]).to.eql(expected_payload);
		expect(update_work_stream_stub.getCall(0).args[0]).to.eql(test_request.subscriptions[0]);
		expect(update_work_stream_stub.getCall(0).args[1]).to.eql('remote_node_test');
		expect(update_work_stream_stub.getCall(1).args[0]).to.eql(test_request.subscriptions[1]);
		expect(update_work_stream_stub.getCall(1).args[1]).to.eql('remote_node_test');
		expect(update_work_stream_stub.callCount).to.equal(2);
		expect(upsert_node_record_stub.args[0][0]).to.eql(expected_node_record);
		expect(result).to.equal("Successfully updated 'remote_node_test'");
	});

	it('Test error thrown and record not inserted if error reply from remote node', async () => {
		const error_reply = new UpdateRemoteResponseObject('error', 'Error from remote node');
		request_stub.resolves(error_reply);
		await test_utils.assertErrorAsync(
			updateNode,
			[test_request],
			test_utils.generateHDBError('Error returned from remote node remote_node_test: Error from remote node', 500)
		);
		expect(upsert_node_record_stub.called).to.be.false;
		expect(update_work_stream_stub.called).to.be.false;
	});

	it('Test error is handled correctly if no remote nodes listening', async () => {
		const fake_no_response_err = new Error();
		fake_no_response_err.code = '503';
		request_stub.throws(fake_no_response_err);
		await test_utils.assertErrorAsync(
			updateNode,
			[test_request],
			test_utils.generateHDBError("Unable to update_node, node 'remote_node_test' is not listening.", 500)
		);
		expect(upsert_node_record_stub.called).to.be.false;
		expect(update_work_stream_stub.called).to.be.false;
	});

	it('Test error is thrown if the node record does not exist', async () => {
		get_node_record_stub.resolves([]);
		await test_utils.assertErrorAsync(
			updateNode,
			[test_request],
			test_utils.generateHDBError("Node 'remote_node_test' has not been added, perform add_node to proceed.", 400)
		);
	});
});
