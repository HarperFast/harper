'use strict';

const test_util = require('../../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const { expect } = chai;
const rewire = require('rewire');
const sinon = require('sinon');
let cluster_utils = rewire('../../../utility/clustering/clusterUtilities');

describe('Test clusterUtilities', () => {
	const sandbox = sinon.createSandbox();
	const test_sys_info = {
		hdb_version: '4.0.0test',
		node_version: '16.15.0',
		platform: 'test platform',
	};
	let reverseSubscription;

	before(() => {
		reverseSubscription = cluster_utils.__get__('reverseSubscription');
		sandbox.stub(cluster_utils, 'getSystemInfo').resolves(test_sys_info);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test getNodeRecord function calls search by hash with correct query', async () => {
		const search_by_hash_stub = sandbox.stub().resolves([{ node_name: 'dev_horse' }]);
		const p_search_by_hash_rw = cluster_utils.__set__('pSearchByHash', search_by_hash_stub);
		await cluster_utils.getNodeRecord('dogs_rule');
		expect(search_by_hash_stub.args[0][0]).to.eql({
			schema: 'system',
			table: 'hdb_nodes',
			hash_values: ['dogs_rule'],
			get_attributes: ['*'],
		});
		p_search_by_hash_rw();
	});

	it('Test upsertNodeRecord calls upsert with correct query', async () => {
		const upsert_stub = sandbox.stub();
		const upsert_rw = cluster_utils.__set__('insert.upsert', upsert_stub);
		await cluster_utils.upsertNodeRecord({ node_name: 'cowabunga' });
		expect(upsert_stub.args[0][0]).to.eql({
			operation: 'upsert',
			schema: 'system',
			table: 'hdb_nodes',
			__origin: undefined,
			records: [
				{
					node_name: 'cowabunga',
				},
			],
		});
		upsert_rw();
	});

	it('Test reverseSubscription subscribe true publish false', () => {
		const sub = {
			schema: 'cat',
			table: 'dog',
			subscribe: true,
			publish: false,
			hash_attribute: 'id',
		};

		const result = reverseSubscription(sub);
		expect(result).to.eql({
			hash_attribute: 'id',
			publish: true,
			schema: 'cat',
			subscribe: false,
			table: 'dog',
		});
	});

	it('Test reverseSubscription subscribe false publish true', () => {
		const sub = {
			schema: 'cat',
			table: 'dog',
			hash_attribute: 'id',
			subscribe: false,
			publish: true,
		};

		const result = reverseSubscription(sub);
		expect(result).to.eql({
			schema: 'cat',
			table: 'dog',
			hash_attribute: 'id',
			subscribe: true,
			publish: false,
		});
	});

	it('Test reverseSubscription subscribe false publish false', () => {
		const sub = {
			schema: 'cat',
			table: 'dog',
			hash_attribute: 'id',
			subscribe: false,
			publish: false,
		};

		const result = reverseSubscription(sub);
		expect(result).to.eql({
			schema: 'cat',
			table: 'dog',
			hash_attribute: 'id',
			subscribe: false,
			publish: false,
		});
	});

	it('Test reverseSubscription subscribe true publish true', () => {
		const sub = {
			schema: 'cat',
			table: 'dog',
			hash_attribute: 'id',
			subscribe: true,
			publish: true,
		};

		const result = reverseSubscription(sub);
		expect(result).to.eql({
			schema: 'cat',
			table: 'dog',
			hash_attribute: 'id',
			subscribe: true,
			publish: true,
		});
	});

	it('Test buildNodePayloads returns record and payload that are correct', () => {
		test_util.setGlobalSchema('name', 'breed', 'beagle', ['name', 'age']);
		test_util.setGlobalSchema('id', 'country', 'england', ['id', 'county']);
		test_util.setGlobalSchema('number', 'dog', 'poodle', ['number']);

		const test_subs = [
			{
				schema: 'breed',
				table: 'beagle',
				publish: true,
				subscribe: true,
				start_time: '2022-08-26T18:26:58.514Z',
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
				start_time: '2022-08-24T18:26:58.514Z',
			},
		];

		const expected_remote_payload = {
			node_name: 'im_the_local_node',
			operation: 'add_node',
			subscriptions: [
				{
					hash_attribute: 'name',
					publish: true,
					schema: 'breed',
					subscribe: true,
					table: 'beagle',
					start_time: '2022-08-26T18:26:58.514Z',
				},
				{
					hash_attribute: 'id',
					publish: true,
					schema: 'country',
					subscribe: false,
					table: 'england',
					start_time: undefined,
				},
				{
					hash_attribute: 'number',
					publish: false,
					schema: 'dog',
					subscribe: true,
					table: 'poodle',
					start_time: '2022-08-24T18:26:58.514Z',
				},
			],
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		};
		const result = cluster_utils.buildNodePayloads(test_subs, 'im_the_local_node', 'add_node', test_sys_info);
		expect(result).to.eql(expected_remote_payload);
	});

	it('Test getSystemInfo gets system info', async () => {
		const result = await cluster_utils.getSystemInfo();
		expect(result).to.haveOwnProperty('hdb_version');
		expect(result).to.haveOwnProperty('node_version');
		expect(result).to.haveOwnProperty('platform');
		expect(result.hdb_version).to.not.be.empty;
		expect(result.node_version).to.not.be.empty;
		expect(result.platform).to.not.be.empty;
	});
});
