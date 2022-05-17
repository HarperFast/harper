'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const pm2_utils = require('../../../utility/pm2/utilityFunctions');
const eng_mgr = require('../../../utility/environment/environmentManager');
const hdb_terms = require('../../../utility/hdbTerms');
const getRemoteSourceConfig = require('../../../utility/clustering/getRemoteSourceConfig');

describe('Test getRemoteSourceConfig module', () => {
	const sandbox = sinon.createSandbox();
	const test_clustering_port = 6674;
	const test_op_api_port = 1161;
	let pm2_desc_stub;
	const fake_pm2_desc = [
		{
			pm2_env: {
				pm_uptime: 1652109602215,
			},
		},
	];

	before(() => {
		pm2_desc_stub = sandbox.stub(pm2_utils, 'describe').resolves(fake_pm2_desc);
		eng_mgr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT, test_clustering_port);
		eng_mgr.setProperty(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT, test_op_api_port);
	});

	after(() => {
		sandbox.restore();
	});

	it('Test correct object is returned happy path', async () => {
		const expected_result = {
			status: 'success',
			message: {
				uptime: '1m 47s',
				ports: {
					clustering: 6674,
					operations_api: 1161,
				},
			},
		};
		const fake_timer = sandbox.useFakeTimers({ now: 1652109710196 });
		const result = await getRemoteSourceConfig();
		expect(result).to.eql(expected_result);
		fake_timer.restore();
	});

	it('Test if error object with error is returned', async () => {
		pm2_desc_stub.throws(new Error('Error getting uptime'));
		const result = await getRemoteSourceConfig();
		expect(result).to.eql({
			status: 'error',
			message: 'Error getting uptime',
		});
	});
});
