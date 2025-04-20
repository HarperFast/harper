'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const clustering_utils = require('../../../utility/clustering/clusterUtilities');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const purge_stream = rewire('../../../utility/clustering/purgeStream');

describe('Test purgeStream module', () => {
	const sandbox = sinon.createSandbox();
	const test_req = {
		schema: 'dev',
		table: 'chicken',
	};
	let check_clustering_enabled_stub;
	let purge_table_stream_stub;
	let purge_stream_val_stub = sandbox.stub().returns(undefined);

	before(() => {
		check_clustering_enabled_stub = sandbox.stub(clustering_utils, 'checkClusteringEnabled').resolves();
		purge_table_stream_stub = sandbox.stub(nats_utils, 'purgeTableStream').resolves();
		purge_stream.__set__('purgeStreamValidator', purge_stream_val_stub);
	});

	after(() => {
		sandbox.restore();
	});

	it('Test everything is called as expected', async () => {
		const result = await purge_stream(test_req);
		expect(check_clustering_enabled_stub.called).to.be.true;
		expect(purge_table_stream_stub.args[0]).to.eql(['dev', 'chicken', undefined]);
		expect(result).to.equal("Successfully purged table 'dev.chicken'");
	});

	it('Test validation error is handled correctly', async () => {
		purge_stream_val_stub.returns({ message: 'Table does not not exist' });
		let error;
		try {
			await purge_stream(test_req);
		} catch (err) {
			error = err;
		}

		expect(error.message).to.equal('Table does not not exist');
	});
});
