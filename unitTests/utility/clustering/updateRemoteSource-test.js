'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const test_utils = require('../../test_utils');
const cluster_utils = require('../../../utility/clustering/clusterUtilities');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const hdb_utils = require('../../../utility/common_utils');
const hdb_logger = require('../../../utility/logging/harper_logger');
const env_manager = require('../../../utility/environment/environmentManager');
const hdb_terms = require('../../../utility/hdbTerms');
const { getDatabases } = require('../../../resources/databases');
const updateRemoteSource = rewire('../../../utility/clustering/updateRemoteSource');

describe('Test updateRemoteSource module', () => {
	const sandbox = sinon.createSandbox();
	let create_schema_stub;
	let create_table_stub;
	let upsert_node_record_stub;
	let get_node_record_stub;
	let get_table_hash_stub;
	let log_error_stub;
	let update_remote_consumer_stub;
	let update_consumer_iterator_stub;
	let create_local_table_streams_stub;
	const test_node_name = 'unit_test_node';
	const test_sys_info = {
		hdb_version: '4.0.0test',
		node_version: '16.15.0',
		platform: 'test platform',
	};
	const test_payload = {
		operation: 'update_node',
		node_name: 'cowabunga',
		subscriptions: [
			{
				schema: 'breed',
				table: 'beagle',
				hash_attribute: 'name',
				publish: true,
				subscribe: true,
			},
			{
				schema: 'country',
				table: 'england',
				hash_attribute: 'id',
				publish: true,
				subscribe: false,
			},
			{
				schema: 'dog',
				table: 'poodle',
				hash_attribute: 'number',
				publish: false,
				subscribe: true,
			},
		],
		system_info: test_sys_info,
	};

	before(() => {
		delete global.hdb_schema;
		sandbox.stub(cluster_utils, 'getSystemInfo').resolves(test_sys_info);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME, test_node_name);
		create_local_table_streams_stub = sandbox.stub(nats_utils, 'createLocalTableStream').resolves();
		create_table_stub = sandbox.stub();
		updateRemoteSource.__set__('schemaMod.createTable', create_table_stub);
		upsert_node_record_stub = sandbox.stub(cluster_utils, 'upsertNodeRecord');
		get_node_record_stub = sandbox.stub(cluster_utils, 'getNodeRecord').resolves([]);
		get_table_hash_stub = sandbox.stub(hdb_utils, 'getTableHashAttribute');
		log_error_stub = sandbox.stub(hdb_logger, 'error');
		update_remote_consumer_stub = sandbox.stub(nats_utils, 'updateRemoteConsumer');
		update_consumer_iterator_stub = sandbox.stub(nats_utils, 'updateConsumerIterator');
		get_table_hash_stub.onCall(0).returns('name');
		get_table_hash_stub.onCall(1).returns('id');
		get_table_hash_stub.onCall(2).returns('number');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		delete global.hdb_schema;
		sandbox.restore();
		rewire('../../../utility/clustering/updateRemoteSource');
	});

	it('Test updateRemoteSource correctly calls all the things required for a happy path', async () => {
		create_schema_stub = sandbox.stub();
		const create_schema_rw = updateRemoteSource.__set__('schemaMod.createSchema', create_schema_stub);
		test_utils.setGlobalSchema('number', 'dog', 'poodle', ['number']);
		delete getDatabases().breed;
		delete getDatabases().country;
		const expected_node_record = [
			{
				name: 'cowabunga',
				subscriptions: [
					{
						publish: true,
						schema: 'breed',
						subscribe: true,
						table: 'beagle',
					},
					{
						publish: true,
						schema: 'country',
						subscribe: false,
						table: 'england',
					},
					{
						publish: false,
						schema: 'dog',
						subscribe: true,
						table: 'poodle',
					},
				],
				system_info: {
					hdb_version: '4.0.0test',
					node_version: '16.15.0',
					platform: 'test platform',
				},
			},
		];
		const result = await updateRemoteSource(test_payload);

		expect(create_schema_stub.callCount).to.equal(2);
		expect(create_schema_stub.getCall(0).args[0].schema).to.equal('breed');
		expect(create_schema_stub.getCall(1).args[0].schema).to.equal('country');
		expect(create_table_stub.callCount).to.equal(2);
		expect(create_table_stub.getCall(0).args[0].schema).to.equal('breed');
		expect(create_table_stub.getCall(0).args[0].table).to.equal('beagle');
		expect(create_table_stub.getCall(1).args[0].schema).to.equal('country');
		expect(create_table_stub.getCall(1).args[0].table).to.equal('england');
		expect(create_local_table_streams_stub.getCall(0).args).to.eql(['breed', 'beagle']);
		expect(create_local_table_streams_stub.getCall(1).args).to.eql(['country', 'england']);
		expect(upsert_node_record_stub.args[0]).to.eql(expected_node_record);
		expect(update_remote_consumer_stub.callCount).to.equal(3);
		expect(update_remote_consumer_stub.args).to.eql([
			[
				{
					schema: 'breed',
					table: 'beagle',
					hash_attribute: 'name',
					publish: true,
					subscribe: true,
				},
				'cowabunga',
			],
			[
				{
					schema: 'country',
					table: 'england',
					hash_attribute: 'id',
					publish: true,
					subscribe: false,
				},
				'cowabunga',
			],
			[
				{
					schema: 'dog',
					table: 'poodle',
					hash_attribute: 'number',
					publish: false,
					subscribe: true,
				},
				'cowabunga',
			],
		]);
		expect(update_consumer_iterator_stub.callCount).to.eql(3);
		expect(update_consumer_iterator_stub.args).to.eql([
			['breed', 'beagle', 'cowabunga', 'start'],
			['country', 'england', 'cowabunga', 'stop'],
			['dog', 'poodle', 'cowabunga', 'start'],
		]);

		expect(result).to.eql({
			message: 'Node unit_test_node successfully updated remote source',
			status: 'success',
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		});

		create_schema_rw();
	});

	it('Test happy path when existing node record present', async () => {
		create_schema_stub = sandbox.stub();
		const create_schema_rw = updateRemoteSource.__set__('schemaMod.createSchema', create_schema_stub);
		const expected_node_record = {
			name: 'cowabunga',
			subscriptions: [
				{
					schema: 'breed',
					table: 'beagle',
					publish: true,
					subscribe: true,
				},
				{
					schema: 'dog',
					table: 'poodle',
					publish: false,
					subscribe: true,
				},
				{
					schema: 'ninjas',
					table: 'turtles',
					publish: false,
					subscribe: false,
				},
				{
					schema: 'country',
					table: 'england',
					publish: true,
					subscribe: false,
				},
			],
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		};
		test_utils.setGlobalSchema('name', 'breed', 'beagle', ['breed', 'color']);
		test_utils.setGlobalSchema('number', 'dog', 'poodle', ['number']);
		test_utils.setGlobalSchema('name', 'ninjas', 'turtles', ['names', 'skills']);
		get_node_record_stub.resolves([
			{
				name: 'cowabunga',
				subscriptions: [
					{
						schema: 'breed',
						table: 'beagle',
						publish: false,
						subscribe: true,
					},
					{
						schema: 'dog',
						table: 'poodle',
						publish: true,
						subscribe: false,
					},
					{
						schema: 'ninjas',
						table: 'turtles',
						publish: false,
						subscribe: false,
					},
				],
			},
		]);
		const result = await updateRemoteSource(test_payload);
		expect(create_schema_stub.callCount).to.equal(1);
		expect(upsert_node_record_stub.args[0][0]).to.eql(expected_node_record);
		expect(upsert_node_record_stub.callCount).to.equal(1);
		expect(update_remote_consumer_stub.callCount).to.equal(3);
		expect(update_remote_consumer_stub.callCount).to.equal(3);
		expect(update_remote_consumer_stub.args).to.eql([
			[
				{
					schema: 'breed',
					table: 'beagle',
					hash_attribute: 'name',
					publish: true,
					subscribe: true,
				},
				'cowabunga',
			],
			[
				{
					schema: 'country',
					table: 'england',
					hash_attribute: 'id',
					publish: true,
					subscribe: false,
				},
				'cowabunga',
			],
			[
				{
					schema: 'dog',
					table: 'poodle',
					hash_attribute: 'number',
					publish: false,
					subscribe: true,
				},
				'cowabunga',
			],
		]);
		expect(update_consumer_iterator_stub.callCount).to.eql(5);
		expect(update_consumer_iterator_stub.args).to.eql([
			['breed', 'beagle', 'cowabunga', 'stop'],
			['breed', 'beagle', 'cowabunga', 'start'],
			['country', 'england', 'cowabunga', 'stop'],
			['dog', 'poodle', 'cowabunga', 'stop'],
			['dog', 'poodle', 'cowabunga', 'start'],
		]);
		expect(result).to.eql({
			message: 'Node unit_test_node successfully updated remote source',
			status: 'success',
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		});

		create_schema_rw();
	});

	it('Test error from getNodeRecord is called and returned', async () => {
		get_node_record_stub.throws(new Error('Error getting node record'));
		const result = await updateRemoteSource(test_payload);
		expect(result).to.eql({
			status: 'error',
			message: 'Error getting node record',
			system_info: undefined,
		});
	});

	it('Test validation error is returned', async () => {
		delete test_payload.node_name;
		const result = await updateRemoteSource(test_payload);
		expect(result).to.eql({
			status: 'error',
			message: "'node_name' is required",
			system_info: undefined,
		});
	});
});
