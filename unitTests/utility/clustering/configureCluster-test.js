'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const env_mgr = require('../../../utility/environment/environmentManager');
const test_utils = require('../../test_utils');
const cluster_utils = require('../../../utility/clustering/clusterUtilities');
const configure_cluster = rewire('../../../utility/clustering/configureCluster');

describe('Test configureCluster module', () => {
	const sandbox = sinon.createSandbox();
	const remove_node_stub = sandbox.stub().resolves('Successfully removed node');
	const add_node_stub = sandbox.stub().resolves('Successfully added node');
	const validate_stub = sandbox.stub().returns(undefined);
	const fake_node_records = [
		{
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
			],
		},
		{
			name: 'even_remoter_node_test',
			subscriptions: [
				{
					schema: 'country',
					table: 'england',
					subscribe: true,
					publish: true,
				},
				{
					schema: 'chicken',
					table: 'food',
					subscribe: false,
					publish: true,
				},
			],
		},
	];
	let search_stub;
	const test_req = {
		operation: 'configure_cluster',
		connections: [
			{
				node_name: 'remote_node_test',
				subscriptions: [
					{
						schema: 'dev',
						table: 'cow',
						subscribe: true,
						publish: false,
					},
				],
			},
			{
				node_name: 'mr_node',
				subscriptions: [
					{
						schema: 'dev',
						table: 'cow',
						subscribe: true,
						publish: true,
					},
				],
			},
		],
	};

	before(() => {
		env_mgr.setProperty('clustering_enabled', true);
		configure_cluster.__set__('removeNode', remove_node_stub);
		configure_cluster.__set__('addNode', add_node_stub);
		configure_cluster.__set__('configClusterValidator', validate_stub);
		search_stub = sandbox.stub(cluster_utils, 'getAllNodeRecords').resolves(fake_node_records);
	});

	after(() => {
		sandbox.restore();
		rewire('../../../utility/clustering/configureCluster');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test configureCluster calls remove node for all nodes and then add node', async () => {
		const result = await configure_cluster(test_req);
		expect(remove_node_stub.callCount).to.equal(2);
		expect(remove_node_stub.getCall(0).args[0]).to.eql({
			operation: 'remove_node',
			node_name: 'remote_node_test',
		});
		expect(remove_node_stub.getCall(1).args[0]).to.eql({
			operation: 'remove_node',
			node_name: 'even_remoter_node_test',
		});
		expect(add_node_stub.callCount).to.equal(2);
		expect(add_node_stub.getCall(0).args[0]).to.eql(test_req.connections[0]);
		expect(add_node_stub.getCall(1).args[0]).to.eql(test_req.connections[1]);
		expect(result).to.eql({
			connections: [
				{
					node_name: 'remote_node_test',
					response: 'Successfully added node',
				},
				{
					node_name: 'mr_node',
					response: 'Successfully added node',
				},
			],
			message: 'Configure cluster complete.',
		});
	});

	it('Test error from both calls to add node is returned in result', async () => {
		add_node_stub.rejects(new Error('Error adding node'));
		const result = await configure_cluster(test_req);
		expect(result).to.eql({
			connections: [],
			failed_nodes: ['remote_node_test', 'mr_node'],
			message:
				'Configure cluster was partially successful. Errors occurred when attempting to configure the following nodes. Check the logs for more details.',
		});

		add_node_stub.resolves();
	});

	it('Test one error from remove node is returned in result', async () => {
		remove_node_stub.onCall(1).rejects(new Error('Error removing node'));
		const result = await configure_cluster(test_req);
		expect(result).to.eql({
			connections: [
				{
					node_name: 'remote_node_test',
					response: undefined,
				},
				{
					node_name: 'mr_node',
					response: undefined,
				},
			],
			failed_nodes: ['even_remoter_node_test'],
			message:
				'Configure cluster was partially successful. Errors occurred when attempting to configure the following nodes. Check the logs for more details.',
		});
	});

	it('Test if all calls error, error is returned', async () => {
		remove_node_stub.throws();
		add_node_stub.throws();
		await test_utils.assertErrorAsync(
			configure_cluster,
			[test_req],
			test_utils.generateHDBError('Failed to configure the cluster. Check the logs for more details.', 500)
		);
	});
});
