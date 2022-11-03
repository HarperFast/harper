'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const hdb_utils = require('../../../utility/common_utils');
const schema_mod = require('../../../data_layer/schema');
const test_utils = require('../../test_utils');

const review_subscriptions = rewire('../../../utility/clustering/reviewSubscriptions');

describe('Test reviewSubscriptions module', () => {
	const sandbox = sinon.createSandbox();
	let nats_utils_request_stub;
	let hdb_utils_schema_exists_stub;
	let hdb_utils_table_exists_stub;
	let create_schema_stub;
	let create_table_stub;
	let create_local_table_stream_stub;
	const fake_desc_all = {
		status: 'success',
		message: {
			four: {
				frog: {
					hash_attribute: 'name',
					name: 'frog',
				},
			},
			radio: {
				genre: {
					hash_attribute: 'id',
					name: 'genre',
				},
			},
		},
	};

	const test_subs = [
		{
			schema: 'four',
			table: 'frog',
			publish: true,
			subscribe: false,
		},
		{
			schema: 'radio',
			table: 'genre',
			publish: false,
			subscribe: true,
			start_time: '2022-08-26T18:26:58.514Z',
		},
	];

	before(() => {
		nats_utils_request_stub = sandbox.stub(nats_utils, 'request').resolves(fake_desc_all);
		hdb_utils_schema_exists_stub = sandbox.stub(hdb_utils, 'doesSchemaExist').returns(false);
		hdb_utils_table_exists_stub = sandbox.stub(hdb_utils, 'doesTableExist').returns(false);
		create_schema_stub = sandbox.stub(schema_mod, 'createSchema').resolves();
		create_table_stub = sandbox.stub(schema_mod, 'createTable').resolves();
		create_local_table_stream_stub = sandbox.stub(nats_utils, 'createLocalTableStream').resolves();
	});

	after(() => {
		sandbox.restore();
	});

	it('Test reviewSubscriptions creates schema and tables', async () => {
		const result = await review_subscriptions(test_subs, 'imRemoteNode');
		expect(create_schema_stub.getCall(0).args[0]).to.eql({
			operation: 'create_schema',
			schema: 'four',
		});
		expect(create_schema_stub.getCall(1).args[0]).to.eql({
			operation: 'create_schema',
			schema: 'radio',
		});
		expect(create_table_stub.getCall(0).args[0]).to.eql({
			schema: 'four',
			table: 'frog',
			hash_attribute: 'name',
		});
		expect(create_table_stub.getCall(1).args[0]).to.eql({
			schema: 'radio',
			table: 'genre',
			hash_attribute: 'id',
		});
		expect(create_local_table_stream_stub.getCall(0).args).to.eql(['four', 'frog']);
		expect(create_local_table_stream_stub.getCall(1).args).to.eql(['radio', 'genre']);
		expect(result).to.eql({
			added: [
				{
					schema: 'four',
					table: 'frog',
					publish: true,
					subscribe: false,
					start_time: undefined,
				},
				{
					schema: 'radio',
					table: 'genre',
					publish: false,
					subscribe: true,
					start_time: '2022-08-26T18:26:58.514Z',
				},
			],
			skipped: [],
		});
	});

	it('Test that subscription is skipped if schema/table does not exist', async () => {
		const test_subs_clone = test_utils.deepClone(test_subs);
		test_subs_clone[0].schema = 'chicken';
		test_subs_clone[1].schema = 'mouse';
		hdb_utils_table_exists_stub.returns(false);
		const result = await review_subscriptions(test_subs_clone, 'imRemoteNode');
		expect(result).to.eql({
			added: [],
			skipped: [
				{
					schema: 'chicken',
					table: 'frog',
					publish: true,
					subscribe: false,
				},
				{
					schema: 'mouse',
					table: 'genre',
					publish: false,
					subscribe: true,
					start_time: '2022-08-26T18:26:58.514Z',
				},
			],
		});
	});

	it('Test error from request is handle correctly', async () => {
		nats_utils_request_stub.throws(new Error('Unit test cannot reach instance'));
		let error;
		try {
			await review_subscriptions(test_subs, 'imRemoteNode');
		} catch (err) {
			error = err;
		}

		expect(error.message).to.equal('Unit test cannot reach instance');
	});

	it('Test error status from remote request is caught', async () => {
		const fake_desc_all_clone = test_utils.deepClone(fake_desc_all);
		fake_desc_all_clone.status = 'error';
		fake_desc_all_clone.message = 'Something is broken';
		nats_utils_request_stub.resolves(fake_desc_all_clone);
		let error;
		try {
			await review_subscriptions(test_subs, 'imRemoteNode');
		} catch (err) {
			error = err;
		}

		expect(error.message).to.equal('Error returned from remote node imRemoteNode: Something is broken');
	});
});
