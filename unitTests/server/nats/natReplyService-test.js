'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const env_manager = require('../../../utility/environment/environmentManager');
const hdb_terms = require('../../../utility/hdbTerms');
const natsReplyService = rewire('../../../server/nats/natsReplyService');

describe('Test natsReplyService Module', () => {
	const sandbox = sinon.createSandbox();
	const fake_respond = sandbox.stub().callsFake(() => {});
	const fake_msg = { operation: 'add_node' };
	const fake_subscribe = sandbox.stub().callsFake(() => {
		return [{ data: { operation: 'add_node' }, respond: fake_respond }];
	});
	let fake_connection = {
		subscribe: fake_subscribe,
	};

	const fake_response = {
		status: 'success',
		message: "Node 'test_node' successfully updated remote source",
	};
	const update_remote_source_stub = sandbox.stub().resolves(fake_response);

	before(() => {
		natsReplyService.__set__('decode', sandbox.stub().returns(fake_msg));
		natsReplyService.__set__('updateRemoteSource', update_remote_source_stub);
		sandbox.stub(nats_utils, 'getConnection').resolves(fake_connection);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME, 'test_node');
	});

	after(() => {
		sandbox.restore();
		rewire('../../../server/nats/natsReplyService');
	});

	it('Test initialize calls all the things that are required to initialize reply service', async () => {
		natsReplyService.__set__('node_name', 'test_node');
		await natsReplyService();
		expect(fake_subscribe.args[0][0]).to.equal('test_node.__request__');
		expect(fake_subscribe.args[0][1]).to.eql({
			queue: 'test_node',
		});
		expect(update_remote_source_stub.args[0][0]).to.eql({
			operation: 'add_node',
		});
	});
});
