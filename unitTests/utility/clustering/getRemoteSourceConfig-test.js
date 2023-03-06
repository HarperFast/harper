'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const pm2_utils = require('../../../utility/processManagement/processManagement');
const eng_mgr = require('../../../utility/environment/environmentManager');
const hdb_terms = require('../../../utility/hdbTerms');
const insert = require('../../../dataLayer/insert');
const clustering_utils = require('../../../utility/clustering/clusterUtilities');
const getRemoteSourceConfig = require('../../../utility/clustering/getRemoteSourceConfig');

describe('Test getRemoteSourceConfig module', () => {
	const sandbox = sinon.createSandbox();
	const test_clustering_port = 6674;
	const test_op_api_port = 1161;
	const test_sys_info = {
		hdb_version: '4.0.0test',
		node_version: '16.15.0',
		platform: 'test platform',
	};
	let pm2_desc_stub;
	let update_stub;
	const fake_pm2_desc = [
		{
			pm2_env: {
				pm_uptime: 1652109602215,
			},
		},
	];
	const test_req = {
		node_name: 'get_config_test',
		system_info: test_sys_info,
	};

	before(() => {
		update_stub = sinon.stub(insert, 'update');
		sandbox.stub(clustering_utils, 'getSystemInfo').resolves(test_sys_info);
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
				system_info: test_sys_info,
			},
			system_info: undefined,
		};
		const fake_timer = sandbox.useFakeTimers({ now: 1652109710196 });
		const result = await getRemoteSourceConfig(test_req);
		expect(result).to.eql(expected_result);
		expect(update_stub.args[0][0].records[0]).to.eql({
			name: 'get_config_test',
			system_info: {
				hdb_version: '4.0.0test',
				node_version: '16.15.0',
				platform: 'test platform',
			},
		});
		fake_timer.restore();
	});

	it('Test if error object with error is returned', async () => {
		pm2_desc_stub.throws(new Error('Error getting uptime'));
		const result = await getRemoteSourceConfig(test_req);
		expect(result).to.eql({
			status: 'error',
			message: 'Error getting uptime',
			system_info: undefined,
		});
	});
});
