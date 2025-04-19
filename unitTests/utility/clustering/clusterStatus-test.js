'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const clustering_utils = require('../../../utility/clustering/clusterUtilities');
const hdb_logger = require('../../../utility/logging/harper_logger');
const cluster_status = rewire('../../../utility/clustering/clusterStatus');

describe('Test clusterStatus module', () => {
	const sandbox = sinon.createSandbox();
	let get_all_node_records_stub;
	let request_stub;
	let log_error_stub;
	let upsert_node_record_stub;
	const test_sys_info = {
		hdb_version: '4.0.0test',
		node_version: '16.15.0',
		platform: 'test platform',
	};
	const test_existing_record = [
		{
			name: 'nodeA',
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
			],
		},
		{
			name: 'nodeB',
			subscriptions: [
				{
					schema: 'country',
					table: 'england',
					subscribe: false,
					publish: false,
				},
			],
		},
	];

	const test_reply_node_a = {
		status: 'success',
		message: {
			uptime: '30s',
			ports: {
				clustering: 2456,
				operations_api: 9990,
			},
			system_info: test_sys_info,
		},
	};

	const test_reply_node_b = {
		status: 'success',
		message: {
			uptime: '5s',
			ports: {
				clustering: 2456,
				operations_api: 3345,
			},
			system_info: test_sys_info,
		},
	};

	before(() => {
		upsert_node_record_stub = sandbox.stub(clustering_utils, 'upsertNodeRecord');
		sandbox.stub(clustering_utils, 'getSystemInfo').resolves(test_sys_info);
		cluster_status.__set__('clusteringEnabled', true);
		cluster_status.__set__('thisNodeName', 'localTestNode');
		get_all_node_records_stub = sandbox.stub(clustering_utils, 'getAllNodeRecords').resolves(test_existing_record);
		request_stub = sandbox.stub(nats_utils, 'request');
		log_error_stub = sandbox.stub(hdb_logger, 'error');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
	});

	it('Test cluster status returns error status if request throws error', async () => {
		const expected_result = {
			node_name: 'localTestNode',
			is_enabled: true,
			connections: [
				{
					node_name: 'nodeA',
					status: 'NoResponders',
					ports: {
						clustering: undefined,
						operations_api: undefined,
					},
					latency_ms: undefined,
					uptime: undefined,
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
					],
					system_info: undefined,
				},
				{
					node_name: 'nodeB',
					status: 'NoResponders',
					ports: {
						clustering: undefined,
						operations_api: undefined,
					},
					latency_ms: undefined,
					uptime: undefined,
					subscriptions: [
						{
							schema: 'country',
							table: 'england',
							subscribe: false,
							publish: false,
						},
					],
					system_info: undefined,
				},
			],
		};
		const test_error = new Error();
		test_error.code = '503';
		request_stub.throws(test_error);
		const result = await cluster_status.clusterStatus();
		expect(result).to.eql(expected_result);
	});

	it('Test cluster status returns two nodes with open status', async () => {
		const expected_result = {
			node_name: 'localTestNode',
			is_enabled: true,
			connections: [
				{
					node_name: 'nodeA',
					status: 'open',
					ports: {
						clustering: 2456,
						operations_api: 9990,
					},
					uptime: '30s',
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
					],
					system_info: {
						hdb_version: '4.0.0test',
						node_version: '16.15.0',
						platform: 'test platform',
					},
				},
				{
					node_name: 'nodeB',
					status: 'open',
					ports: {
						clustering: 2456,
						operations_api: 3345,
					},
					uptime: '5s',
					subscriptions: [
						{
							schema: 'country',
							table: 'england',
							subscribe: false,
							publish: false,
						},
					],
					system_info: {
						hdb_version: '4.0.0test',
						node_version: '16.15.0',
						platform: 'test platform',
					},
				},
			],
		};
		request_stub.onCall(0).resolves(test_reply_node_a);
		request_stub.onCall(1).resolves(test_reply_node_b);
		const result = await cluster_status.clusterStatus();
		expect(result.connections[0]).to.haveOwnProperty('latency_ms');
		expect(result.connections[1]).to.haveOwnProperty('latency_ms');
		// Cant guarantee latency value will be the same when testing so we test for it above then delete when doing a result comparison test
		delete result.connections[0].latency_ms;
		delete result.connections[1].latency_ms;
		expect(result).to.eql(expected_result);
		expect(upsert_node_record_stub.getCall(0).args[0]).to.eql({
			name: 'nodeA',
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		});
		expect(upsert_node_record_stub.getCall(1).args[0]).to.eql({
			name: 'nodeB',
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		});
	});

	it('Test cluster status returns two nodes, one with open status the other closed due to error', async () => {
		const expected_result = {
			node_name: 'localTestNode',
			is_enabled: true,
			connections: [
				{
					node_name: 'nodeA',
					status: 'open',
					ports: {
						clustering: 2456,
						operations_api: 9990,
					},
					uptime: '30s',
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
					],
					system_info: {
						hdb_version: '4.0.0test',
						node_version: '16.15.0',
						platform: 'test platform',
					},
				},
				{
					node_name: 'nodeB',
					status: 'closed',
					ports: {
						clustering: undefined,
						operations_api: undefined,
					},
					uptime: undefined,
					subscriptions: [
						{
							schema: 'country',
							table: 'england',
							subscribe: false,
							publish: false,
						},
					],
					system_info: undefined,
				},
			],
		};
		const error_test_reply_node_b = {
			status: 'error',
			message: 'Unable to access instance config',
		};
		request_stub.onCall(0).resolves(test_reply_node_a);
		request_stub.onCall(1).resolves(error_test_reply_node_b);
		const result = await cluster_status.clusterStatus();
		expect(result.connections[0]).to.haveOwnProperty('latency_ms');
		expect(result.connections[1]).to.haveOwnProperty('latency_ms');
		// Cant guarantee latency value will be the same when testing so we test for it above then delete when doing a result comparison test
		delete result.connections[0].latency_ms;
		delete result.connections[1].latency_ms;
		expect(result).to.eql(expected_result);
	});

	it('Test empty connections returned if no node records in table', async () => {
		get_all_node_records_stub.resolves([]);
		const result = await cluster_status.clusterStatus();
		expect(result).to.eql({
			connections: [],
			is_enabled: true,
			node_name: 'localTestNode',
		});
	});

	it('Test empty connections returned if clustering not enabled', async () => {
		cluster_status.__set__('clusteringEnabled', false);
		const result = await cluster_status.clusterStatus();
		expect(result).to.eql({
			connections: [],
			is_enabled: false,
			node_name: 'localTestNode',
		});
	});
});
