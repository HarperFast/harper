'use strict';

require('../../test_utils');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const set_node = require('../../../server/replication/setNode');
const replicator = require('../../../server/replication/replicator');
const keys = require('../../../security/keys');

describe('Test setNode', () => {
	const sandbox = sinon.createSandbox();
	let send_to_node_stub;

	before(() => {
		send_to_node_stub = sandbox.stub(replicator, 'sendOperationToNode');
		keys.listCertificates();
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test setNode can add a new node', async () => {
		send_to_node_stub.resolves({ certificate: '---BEGIN CERTIFICATE--- fadsfgas' });
		const res = await set_node.setNode({
			operation: 'add_node',
			url: 'wss://123.0.0.1:9925',
			rejectUnauthorized: false,
			authorization: {
				username: 'harper',
				password: 'i-like-sticks',
			},
		});
	});
});
