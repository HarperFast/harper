'use strict';

const chai = require('chai');
const rewire = require('rewire');
const { expect } = chai;
const pm2 = require('pm2');
const sinon = require('sinon');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const test_utils = require('../../test_utils');
const env_mngr = require('../../../utility/environment/environmentManager');
const services_config = require('../../../utility/pm2/servicesConfig');
const hdb_terms = require('../../../utility/hdbTerms');
const hdb_logger = require('../../../utility/logging/harper_logger');
const nats_config = require('../../../server/nats/utility/natsConfig');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const clustering_utils = require('../../../utility/clustering/clusterUtilities');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const user = require('../../../security/user');
const crypto_hash = require('../../../security/cryptoHash');
const utility_functions = rewire('../../../utility/pm2/utilityFunctions');

const PM2_LOGROTATE = 'pm2-logrotate';
const PM2_MODULE_LOCATION = path.resolve(__dirname, '../../../node_modules/pm2/bin/pm2');
const LOG_ROTATE_UNINSTALLED = 'Log rotate uninstalled.';
const LOG_ROTATE_UNINSTALL_ERR = 'Error uninstalling log rotate.';
const FAKE_LOCATION_ERROR_MSG = '/fakelocation: No such file or directory';
const FAKE_LOCATION_ERROR_MSG2 = '/fakelocation: not found\n';
const FAKE_CLUSTER_USER1 = 'clusterUser1';
const FAKE_USER_LIST = new Map([
	[
		FAKE_CLUSTER_USER1,
		{
			active: true,
			hash: crypto_hash.encrypt('blahbblah'),
			password: 'somepass',
			role: {
				id: '58aa0e11-b761-4ade-8a7d-e9111',
				permission: {
					cluster_user: true,
				},
				role: 'cluster_user',
			},
			username: FAKE_CLUSTER_USER1,
		},
	],
]);

const fake_cluster_user = FAKE_USER_LIST.get(FAKE_CLUSTER_USER1);
fake_cluster_user.decrypt_hash = 'blahbblah';
fake_cluster_user.uri_encoded_d_hash = 'how%25day-2123ncv%234';
fake_cluster_user.uri_encoded_name = 'name%25day-2123ncv%234';
fake_cluster_user.sys_name = fake_cluster_user.username + '-admin';
fake_cluster_user.sys_name_encoded = fake_cluster_user.uri_encoded_name + '-admin';

/**
 * Uninstalls pm2's logrotate module.
 * @returns {Promise<void>}
 */
async function uninstallLogRotate() {
	const { stdout, stderr } = await exec(
		`${process.platform === 'win32' ? 'node' : ''} ${PM2_MODULE_LOCATION} uninstall pm2-logrotate`
	);
	hdb_logger.debug(`loadLogRotate stdout: ${stdout}`);

	if (stderr) {
		hdb_logger.error(LOG_ROTATE_UNINSTALL_ERR);
		throw stderr;
	}

	hdb_logger.info(LOG_ROTATE_UNINSTALLED);
}
/**
 * Deletes a process from pm2
 * @param proc
 * @returns {Promise<unknown>}
 */
function pm2Delete(proc) {
	return new Promise(async (resolve, reject) => {
		await utility_functions.connect();
		pm2.delete(proc, (err, res) => {
			if (err) {
				reject(err);
			}

			pm2.disconnect();
			resolve(res);
		});
	});
}

/**
 * Stops a process then deletes it from pm2.
 * @param service_name
 * @returns {Promise<void>}
 */
async function stopDeleteProcess(service_name) {
	try {
		await utility_functions.stop(service_name);
		await pm2Delete(service_name);
	} catch (err) {}
}

/**
 * Calls stop/delete for all services
 * @returns {Promise<void>}
 */
async function stopDeleteAllServices() {
	await stopDeleteProcess('HarperDB');
	await stopDeleteProcess('IPC');
	await stopDeleteProcess('Custom Functions');
	await stopDeleteProcess('Clustering Hub');
	await stopDeleteProcess('Clustering Leaf');
	await stopDeleteProcess('Clustering Ingest Service');
	await stopDeleteProcess('Clustering Reply Service');
	await stopDeleteProcess('pm2-logrotate');
}

describe('Test pm2 utilityFunctions module', () => {
	const sandbox = sinon.createSandbox();
	const test_err = 'Utility functions test error';
	let os_cpus_stub;
	let create_work_stream_stub;
	let remove_nats_config_stub;
	let get_all_node_records_stub;
	let update_node_name_stub;

	before(() => {
		fs.mkdirpSync(path.resolve(__dirname, '../../envDir/clustering'));
		os_cpus_stub = sandbox.stub(os, 'cpus').returns([1, 2, 3, 4, 5, 6]);
		create_work_stream_stub = sandbox.stub(nats_utils, 'createWorkQueueStream').resolves();
		env_mngr.initTestEnvironment();
		sandbox.stub(user, 'listUsers').resolves(FAKE_USER_LIST);
		sandbox.stub(user, 'getClusterUser').resolves(fake_cluster_user);
		remove_nats_config_stub = sandbox.stub(nats_config, 'removeNatsConfig');
		get_all_node_records_stub = sandbox.stub(clustering_utils, 'getAllNodeRecords').resolves([]);
		update_node_name_stub = sandbox.stub(nats_utils, 'updateNodeNameLocalStreams');
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_USER, FAKE_CLUSTER_USER1);
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT, 7711);
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME, 'unitTestNodeName');
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT, 7712);
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME, 'harperdb_unit_test');
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT, 7713);
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT, 7714);
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT, 7715);
		env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES, [
			{
				ip: '3.3.3.3',
				port: 7716,
			},
			{
				ip: '4.4.4.4',
				port: 7717,
			},
		]);
	});

	beforeEach(async () => {
		await stopDeleteAllServices();
	});

	after(() => {
		sandbox.restore();
	});

	describe('Test start function', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test the IPC server is started on one process', async () => {
			await utility_functions.start(services_config.generateIPCServerConfig());
			const process_meta = await utility_functions.describe('IPC');
			expect(process_meta.length).to.equal(1);
			expect(process_meta[0].name).to.equal('IPC');
			expect(process_meta[0].pm2_env.status).to.equal('online');
			expect(process_meta[0].pm2_env.exec_mode).to.equal('fork_mode');
		}).timeout(10000);

		it('Test the HarperDB server is started on multiple processes', async () => {
			await utility_functions.start(services_config.generateMainServerConfig());
			const process_meta = await utility_functions.describe('HarperDB');
			expect(process_meta.length).to.equal(1);
			expect(process_meta[0].name).to.equal('HarperDB');
			expect(process_meta[0].pm2_env.status).to.equal('online');
			expect(process_meta[0].pm2_env.exec_mode).to.equal('fork_mode');
			expect(process_meta[0].pm2_env.node_args[0]).includes('--max-old-space-size=');
		}).timeout(10000);

		it('Test error is handled as expected', async () => {
			const test_script_path = path.join(__dirname, 'imnothere.js');
			let test_options = {
				name: 'unit test',
				script: test_script_path,
				out_file: '/dev/null',
				error_file: '/dev/null',
				instances: 1,
			};

			let error;
			try {
				await utility_functions.start(test_options);
			} catch (err) {
				error = err;
			}

			expect(error[0].message).to.equal(`Script not found: ${test_script_path}`);
		}).timeout(10000);

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.start, [], new Error(test_err));
			connect_rw();
		}).timeout(10000);
	}).timeout(10000);

	describe('Test stop function', () => {
		it('Test that a single online process is stopped', async () => {
			await utility_functions.start(services_config.generateIPCServerConfig());
			await utility_functions.stop('IPC');
			const process_meta = await utility_functions.list('IPC');
			expect(process_meta.length).to.equal(0);
		}).timeout(20000);

		it('Test that multiple processes are stopped', async () => {
			await utility_functions.start(services_config.generateMainServerConfig());
			await utility_functions.stop('HarperDB');
			const process_meta = await utility_functions.list('HarperDB');
			expect(process_meta.length).to.equal(0);
		}).timeout(20000);

		it('Test error is handled as expected', async () => {
			await test_utils.assertErrorAsync(
				utility_functions.stop,
				['HarperACDC'],
				new Error('process or namespace not found')
			);
		}).timeout(20000);

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.stop, ['test'], new Error(test_err));
			connect_rw();
		});
	});

	describe('Test reload function', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test clustered processes are reloaded', async () => {
			await utility_functions.start(services_config.generateMainServerConfig());
			await utility_functions.reload('HarperDB');
			const process_meta = await utility_functions.describe('HarperDB');
			expect(process_meta[0].name).to.equal('HarperDB');
			expect(process_meta[0].pm2_env.status).to.equal('online');
		}).timeout(30000);

		it('Test error is handled as expected', async () => {
			await test_utils.assertErrorAsync(
				utility_functions.reload,
				['HarperACDC'],
				new Error('process or namespace not found')
			);
		});

		it('Test error from connect causes promise to reject', async () => {
			await utility_functions.start(services_config.generateMainServerConfig());
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.reload, ['Test'], new Error(test_err));
			connect_rw();
		});
	});

	describe('Test restart function', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test clustered processes are restarted', async () => {
			await utility_functions.start(services_config.generateMainServerConfig());
			await utility_functions.restart('HarperDB');
			const process_meta = await utility_functions.describe('HarperDB');
			expect(process_meta[0].name).to.equal('HarperDB');
			expect(process_meta[0].pm2_env.status).to.equal('online');
		}).timeout(30000);

		it('Test error is handled as expected', async () => {
			await test_utils.assertErrorAsync(
				utility_functions.restart,
				['HarperACDC'],
				new Error('process or namespace not found')
			);
		});

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.restart, ['test'], new Error(test_err));
			connect_rw();
		});
	});

	describe('Test list function', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test all pm2 managed processes are listed', async () => {
			await utility_functions.start(services_config.generateMainServerConfig());
			await utility_functions.start(services_config.generateIPCServerConfig());
			const list = await utility_functions.list();
			let hdb_name_found = false;
			let ipc_name_found = false;
			list.forEach((proc) => {
				if (proc.name === 'HarperDB') hdb_name_found = true;
				if (proc.name === 'IPC') ipc_name_found = true;
			});

			expect(list.length).to.equal(2);
			expect(hdb_name_found).to.be.true;
			expect(ipc_name_found).to.be.true;
		});

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.list, [], new Error(test_err));
			connect_rw();
		});
	});

	describe('Test describe function', () => {
		afterEach(async () => {
			await stopDeleteAllServices();
		});

		it('Test process meta details are returned', async () => {
			await utility_functions.start(services_config.generateIPCServerConfig());
			const process_meta = await utility_functions.describe('IPC');
			expect(process_meta.length).to.equal(1);
			expect(process_meta[0].name).to.equal('IPC');
			expect(process_meta[0].pm2_env.status).to.equal('online');
			expect(process_meta[0].pm2_env.exec_mode).to.equal('fork_mode');
		});

		it('Test empty array returned if service does not exist', async () => {
			const result = await utility_functions.describe('HarperACDC');
			expect(result).to.eql([]);
		});

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.describe, ['test'], new Error(test_err));
			connect_rw();
		});
	});

	describe('Test start all services function', () => {
		// This afterEach is like this because it was the only way to get the timeout increase working.
		// The stopDeleteAllServices was taking longer than 2 sec.
		afterEach(async function () {
			this.timeout(20000);
			await stopDeleteAllServices();
		});

		it('Test all services are started', async () => {
			await nats_config.generateNatsConfig();
			await utility_functions.startAllServices();
			const list = await utility_functions.list();
			let hdb_name_found = false;
			let hub_name_found = false;
			let leaf_name_found = false;
			list.forEach((proc) => {
				if (proc.name === 'HarperDB') hdb_name_found = true;
				if (proc.name === 'Clustering Hub') hub_name_found = true;
				if (proc.name === 'Clustering Leaf') leaf_name_found = true;
			});

			expect(list.length).to.equal(3);
			expect(hdb_name_found).to.be.true;
			expect(hub_name_found).to.be.true;
			expect(leaf_name_found).to.be.true;
		}).timeout(20000);
	});

	describe('Test startService function', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test starts IPC service', async () => {
			await utility_functions.startService('IpC');
			const process_meta = await utility_functions.describe('IPC');
			expect(process_meta.length).to.equal(1);
			expect(process_meta[0].name).to.equal('IPC');
			expect(process_meta[0].pm2_env.status).to.equal('online');
		}).timeout(60000);

		it('Test starts reply service', async () => {
			await utility_functions.startService('Clustering Reply Service');
			const process_meta = await utility_functions.describe('Clustering Reply Service');
			expect(process_meta.length).to.equal(1);
			expect(process_meta[0].name).to.equal('Clustering Reply Service');
			expect(process_meta[0].pm2_env.status).to.equal('online');
		}).timeout(20000);

		it('Test starts HarperDB service', async () => {
			afterEach(async () => {
				await stopDeleteAllServices();
			});

			await utility_functions.startService('harperdb');
			const process_meta = await utility_functions.describe('HarperDB');
			expect(process_meta.length).to.equal(1);
			expect(process_meta[0].name).to.equal('HarperDB');
			expect(process_meta[0].pm2_env.status).to.equal('online');
		}).timeout(20000);

		it('Test starts custom function service', async () => {
			await utility_functions.startService('custom FUNCTIONS');
			const process_meta = await utility_functions.describe('Custom Functions');
			expect(process_meta.length).to.equal(4);
			expect(process_meta[0].name).to.equal('Custom Functions');
			expect(process_meta[1].name).to.equal('Custom Functions');
			expect(process_meta[0].pm2_env.status).to.equal('online');
			expect(process_meta[1].pm2_env.status).to.equal('online');
		}).timeout(20000);

		it('Test starts clustering upgrade', async () => {
			const start_stub = sandbox.stub();
			const start_rw = utility_functions.__set__('start', start_stub);
			await utility_functions.startService('Upgrade-4-0-0');
			expect(start_stub.args[0][0].name).to.equal('Upgrade-4-0-0');
			start_rw();
		});

		it('Test error handled as expected', async () => {
			await test_utils.assertErrorAsync(
				utility_functions.startService,
				['DarperDB'],
				new Error('Start service called with unknown service config: darperdb')
			);
		}).timeout(20000);
	});

	describe('Test getUniqueServicesList function', () => {
		// This afterEach is like this because it was the only way to get the timeout increase working.
		// The stopDeleteAllServices was taking longer than 2 sec.
		afterEach(async function () {
			this.timeout(20000);
			await stopDeleteAllServices();
		});

		it('Test a unique set of services is returned', async () => {
			const expected_obj = {
				'Clustering Hub': {
					exec_mode: 'fork_mode',
					name: 'Clustering Hub',
				},
				'Clustering Leaf': {
					exec_mode: 'fork_mode',
					name: 'Clustering Leaf',
				},
				'HarperDB': {
					name: 'HarperDB',
					exec_mode: 'fork_mode',
				},
			};
			await nats_config.generateNatsConfig();
			await utility_functions.startAllServices();
			const list = await utility_functions.getUniqueServicesList();
			expect(list).to.eql(expected_obj);
		}).timeout(20000);
	});

	describe('Test stopAllServices function', () => {
		let read_file_stub;
		let process_kill_stub;

		before(() => {
			read_file_stub = sandbox.stub(fs, 'readFile').resolves(12345678);
			process_kill_stub = sandbox.stub(process, 'kill');
			env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_FOREGROUND, true);
		});

		after(() => {
			process_kill_stub.restore();
		});

		afterEach(async () => {
			await stopDeleteAllServices();
		});

		it('Test all services are stopped', async () => {
			await nats_config.generateNatsConfig();
			await utility_functions.startAllServices();
			await utility_functions.stopAllServices();
			const list = await utility_functions.list();
			let service_still_online = false;
			list.forEach((proc) => {
				if (proc.pm2_env.status === 'online') service_still_online = true;
			});

			expect(service_still_online).to.be.false;
		}).timeout(30000);
	});

	describe('Test isServiceRegistered', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test false is returned if service no registered to pm2', async () => {
			const result = await utility_functions.isServiceRegistered('harperdb');
			expect(result).to.be.false;
		});

		it('Test true is returned if service is registered to pm2', async () => {
			await utility_functions.startService('harperdb');
			const result = await utility_functions.isServiceRegistered('harperdb');
			expect(result).to.be.false;
		});
	});

	describe('Test restartAllServices function', () => {
		let reload_stub = sandbox.stub();
		let restart_stub = sandbox.stub();
		let reload_rw;
		let restart_rw;

		before(() => {
			reload_rw = utility_functions.__set__('reloadStopStart', reload_stub);
			restart_rw = utility_functions.__set__('restart', restart_stub);
		});

		after(() => {
			reload_rw();
			restart_rw();
			sandbox.restore();
		});

		// This afterEach is like this because it was the only way to get the timeout increase working.
		// The stopDeleteAllServices was taking longer than 2 sec.
		afterEach(async function () {
			this.timeout(20000);
			await stopDeleteAllServices();
			sandbox.resetHistory();
		});

		it('Test all services are restarted', async () => {
			await nats_config.generateNatsConfig();
			await utility_functions.startAllServices();
			await utility_functions.restartAllServices();
			const reload_calls = [
				...reload_stub.args[0],
			];
			const restart_calls = [...restart_stub.args[0], ...restart_stub.args[1]];
			expect(reload_calls).to.include('HarperDB');
			expect(reload_calls.length).to.equal(1);
			expect(restart_calls).to.include('Clustering Hub');
			expect(restart_calls).to.include('Clustering Leaf');
			expect(restart_calls.length).to.equal(2);
		}).timeout(20000);
	});

	describe('Test reloadStopStart function', () => {
		let reload_stub = sandbox.stub();
		let stop_stub = sandbox.stub();
		let start_service_stub = sandbox.stub();
		let describe_stub = sandbox.stub();
		let restart_hdb_stub = sandbox.stub();
		let describe_rw;
		let reload_rw;
		let stop_rw;
		let start_service_rw;
		let restart_hdb_rw;

		before(() => {
			reload_rw = utility_functions.__set__('reload', reload_stub);
			stop_rw = utility_functions.__set__('stop', stop_stub);
			start_service_rw = utility_functions.__set__('startService', start_service_stub);
			describe_rw = utility_functions.__set__('describe', describe_stub);
			restart_hdb_rw = utility_functions.__set__('restartHdb', restart_hdb_stub);
		});

		after(() => {
			reload_rw();
			stop_rw();
			start_service_rw();
			restart_hdb_rw();
			describe_rw();
		});

		it('Test service is stopped and started if there is a change in max process setting', async () => {
			const env_stub = sandbox.stub();
			const env_rw = utility_functions.__set__('env_mangr.initSync', env_stub);
			env_mngr.setProperty('HTTP_THREADS', 2);
			await utility_functions.reloadStopStart('Custom Functions');
			env_rw();
			env_mngr.initTestEnvironment();
			expect(stop_stub.getCall(0).args[0]).to.equal('Custom Functions');
			expect(start_service_stub.getCall(0).args[0]).to.equal('Custom Functions');
		});

		it('Test service is reloaded if no change in process setting', async () => {
			const env_stub = sandbox.stub();
			const env_rw = utility_functions.__set__('env_mangr.initSync', env_stub);
			describe_stub.resolves([1, 2]);
			env_mngr.setProperty('HTTP_THREADS', 2);
			await utility_functions.reloadStopStart('Custom Functions');
			env_rw();
			env_mngr.initTestEnvironment();
			expect(reload_stub.getCall(0).args[0]).to.equal('Custom Functions');
		});

		it('Test restartHdb is called if service is HarperDB', async () => {
			const env_stub = sandbox.stub();
			const env_rw = utility_functions.__set__('env_mangr.initSync', env_stub);
			describe_stub.resolves([1, 2]);
			env_mngr.setProperty('HTTP_THREADS', 2);
			await utility_functions.reloadStopStart('HarperDB');
			env_rw();
			env_mngr.initTestEnvironment();
			expect(restart_hdb_rw.called);
		});
	});

	describe('Test kill function', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test pm2 is killed', async () => {
			await utility_functions.startService('HarperDB');
			await utility_functions.stop('HarperDB');
			await utility_functions.kill();
			const result = await utility_functions.list();
			expect(result).to.eql([]);
		}).timeout(60000);

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.kill, [], new Error(test_err));
			connect_rw();
		}).timeout(60000);
	});

	describe('Test restartHdb function', () => {
		it('Test start is called with restart config', async () => {
			const expected_result = {
				name: 'Restart HDB',
				exec_mode: 'fork',
				out_file: path.resolve(__dirname, '../../envDir/log/pm2.log'),
				error_file: path.resolve(__dirname, '../../envDir/log/pm2.log'),
				instances: 1,
				autorestart: false,
				cwd: path.resolve(__dirname, '../../../utility/scripts'),
				script: path.join(__dirname, '../../../utility/scripts', hdb_terms.HDB_RESTART_SCRIPT),
				env: {
					PROCESS_NAME: 'Restart HDB',
				},
				merge_logs: true,
			};
			const start_stub = sandbox.stub().resolves();
			const start_rw = utility_functions.__set__('start', start_stub);
			await utility_functions.restartHdb();
			expect(start_stub.getCall(0).args[0]).to.eql(expected_result);
			start_rw();
		});
	});

	describe('Test deleteProcess function', () => {
		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test process is deleted', async () => {
			await utility_functions.startService('IPC');
			await utility_functions.deleteProcess('IPC');
			const process_meta = await utility_functions.describe('IPC');
			expect(process_meta.length).to.equal(0);
		});

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.deleteProcess, ['IPC'], new Error(test_err));
			connect_rw();
		});

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(utility_functions.deleteProcess, ['IPC'], new Error(test_err));
			connect_rw();
		});
	});

	describe('Test stopLogrotate function', () => {
		let stop_logrotate;
		let install_log_rotate;

		before(() => {
			stop_logrotate = utility_functions.__get__('stopLogrotate');
			install_log_rotate = utility_functions.__get__('installLogRotate');
		});

		after(async () => {
			try {
				await uninstallLogRotate();
			} catch (error) {
				// swallow the error to allow test to run
			}
		});

		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test pm2-logrotate module is stopped', async () => {
			try {
				await install_log_rotate();
			} catch (error) {
				// swallow the error to allow test to run
			}

			await stop_logrotate();
			const process_meta = await utility_functions.list(PM2_LOGROTATE);
			expect(process_meta[0].name).to.equal(PM2_LOGROTATE);
			expect(process_meta[0].pm2_env.status).to.equal('stopped');
		}).timeout(60000);

		it('Test error from connect causes promise to reject', async () => {
			const connect_rw = utility_functions.__set__('connect', sandbox.stub().throws(new Error(test_err)));
			await test_utils.assertErrorAsync(stop_logrotate, [], new Error(test_err));
			connect_rw();
		});
	});

	describe('Test installLogRotate function', () => {
		let install_log_rotate;
		let module_location_rw;

		before(() => {
			install_log_rotate = utility_functions.__get__('installLogRotate');
		});

		after(async () => {
			try {
				await uninstallLogRotate();
			} catch (error) {
				// swallow the error to allow test to run
			}
		});

		afterEach(async function () {
			this.timeout(10000);
			await stopDeleteAllServices();
		});

		it('Test pm2-logrotate module is installed', async () => {
			try {
				await install_log_rotate();
			} catch (error) {
				// in some cases, logrotate is already installed and stderr is logged; swallow the error to allow test to run
			}

			const process_meta = await utility_functions.list(PM2_LOGROTATE);
			expect(process_meta[0].name).to.equal(PM2_LOGROTATE);
			expect(process_meta[0].pm2_env.status).to.equal('online');
		}).timeout(60000);

		it('Test logger throws error', async () => {
			module_location_rw = utility_functions.__set__('PM2_MODULE_LOCATION', '/fakelocation');

			let error;
			try {
				await install_log_rotate();
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceof(Error);
			if (process.platform !== 'win32') {
				expect(error.message).to.contain.oneOf([FAKE_LOCATION_ERROR_MSG, FAKE_LOCATION_ERROR_MSG2]);
			}
			module_location_rw();
		}).timeout(60000);
	});

	describe('Test updateLogRotateConfig function', () => {
		let install_log_rotate;
		let update_log_rotate_config;

		before(() => {
			install_log_rotate = utility_functions.__get__('installLogRotate');
			update_log_rotate_config = utility_functions.__get__('updateLogRotateConfig');
		});

		after(async () => {
			try {
				await uninstallLogRotate();
			} catch (error) {
				// swallow the error to allow test to run
			}
		});

		afterEach(async () => {
			await stopDeleteProcess(PM2_LOGROTATE);
		});

		it('Test confirm  rotate config settings are updated', async () => {
			try {
				await install_log_rotate();
			} catch (error) {
				// in some cases, logrotate is already installed and stderr is logged; swallow the error to allow test to run
			}

			env_mngr.setProperty('LOG_ROTATE_MAX_SIZE', '5M');
			env_mngr.setProperty('LOG_ROTATE_RETAIN', 20);
			env_mngr.setProperty('LOG_ROTATE_COMPRESS', true);
			env_mngr.setProperty('LOG_ROTATE_DATE_FORMAT', 'YYYY-MM-DD');
			env_mngr.setProperty('LOG_ROTATE_ROTATE_MODULE', false);
			env_mngr.setProperty('LOG_ROTATE_WORKER_INTERVAL', 15);
			env_mngr.setProperty('LOG_ROTATE_ROTATE_INTERVAL', 2);
			env_mngr.setProperty('LOG_ROTATE_TIMEZONE', 'CST');

			try {
				await update_log_rotate_config();
			} catch (error) {
				// swallow error so test will run
			}

			const process_meta = await utility_functions.list(PM2_LOGROTATE);
			expect(process_meta[0].pm2_env.max_size).to.equal('5M');
			expect(process_meta[0].pm2_env.retain).to.equal('20');
			expect(process_meta[0].pm2_env.compress).to.equal('true');
			expect(process_meta[0].pm2_env.dateFormat).to.equal('YYYY-MM-DD');
			expect(process_meta[0].pm2_env.workerInterval).to.equal('15');
			expect(process_meta[0].pm2_env.rotateInterval).to.equal('2');
			expect(process_meta[0].pm2_env.rotateModule).to.equal('false');
			expect(process_meta[0].pm2_env.TZ).to.equal('CST');
		}).timeout(100000);
	});

	describe('Test configureLogRotate function', () => {
		let install_log_rotate;
		let update_log_rotate_config;
		let stop_log_rotate;
		let install_log_rotate_stub;
		let update_log_rotate_config_stub;
		let start_stub;
		let stop_log_rotate_stub;
		let install_log_rotate_rw;
		let update_log_rotate_config_rw;
		let start_rw;
		let stop_log_rotate_rw;
		let env_init_stub;
		let env_rw;

		before(async () => {
			try {
				await uninstallLogRotate();
			} catch (error) {
				// swallow the error to allow test to run
			}
			install_log_rotate = utility_functions.__get__('installLogRotate');
			update_log_rotate_config = utility_functions.__get__('updateLogRotateConfig');
			stop_log_rotate = utility_functions.__get__('stopLogrotate');
			install_log_rotate_stub = sandbox.stub().resolves();
			update_log_rotate_config_stub = sandbox.stub().resolves();
			start_stub = sandbox.stub().resolves();
			stop_log_rotate_stub = sandbox.stub().resolves();
			install_log_rotate_rw = utility_functions.__set__('installLogRotate', install_log_rotate_stub);
			update_log_rotate_config_rw = utility_functions.__set__('updateLogRotateConfig', update_log_rotate_config_stub);
			start_rw = utility_functions.__set__('start', start_stub);
			stop_log_rotate_rw = utility_functions.__set__('stopLogrotate', stop_log_rotate_stub);
			env_init_stub = sandbox.stub();
		});

		afterEach(async () => {
			sandbox.resetHistory();
			await stopDeleteProcess(PM2_LOGROTATE);
			try {
				await uninstallLogRotate();
			} catch (error) {
				// swallow the error to allow test to run
			}
		});

		after(() => {
			update_log_rotate_config_rw();
			install_log_rotate_rw();
			stop_log_rotate_rw();
			start_rw();
		});

		it('Test that it installs pm2-logrotate if log rotate set to true AND NOT already installed', async () => {
			env_rw = utility_functions.__set__('env_mangr', {
				initSync: env_init_stub,
				get: (arg) => {
					return true;
				},
			});

			try {
				await utility_functions.configureLogRotate();
			} catch (error) {
				// swallow the error to allow test to run
			}

			expect(install_log_rotate_stub.called, 'expected install_log_rotate_stub to be called ').to.be.true;
			expect(update_log_rotate_config_stub.called, 'expected update_log_rotate_config_stub to be called ').to.be.true;

			env_rw();
		}).timeout(60000);

		it('Test that it starts pm2-logrotate if log rotate set to true AND already installed', async () => {
			env_rw = utility_functions.__set__('env_mangr', {
				initSync: env_init_stub,
				get: (arg) => {
					return true;
				},
			});

			try {
				await install_log_rotate();
			} catch (error) {
				// in some cases, logrotate is already installed and stderr is logged; swallow the error to allow test to run
			}

			await utility_functions.configureLogRotate();

			expect(start_stub.called, 'expected start_stub to be called ').to.be.true;
			expect(start_stub.firstCall.args[0]).to.equal(PM2_LOGROTATE);
			expect(update_log_rotate_config_stub.called).to.be.true;

			env_rw();
		}).timeout(120000);

		it('Test that it stops pm2-logrotate if LOG_ROTATE is false, and logrotate is online', async () => {
			env_rw = utility_functions.__set__('env_mangr', {
				initSync: env_init_stub,
				get: (arg) => {
					return false;
				},
			});

			try {
				await install_log_rotate();
			} catch (error) {
				// in some cases, logrotate is already installed and stderr is logged; swallow the error to allow test to run
			}

			await utility_functions.configureLogRotate();
			expect(stop_log_rotate_stub.called).to.be.true;

			env_rw();
		}).timeout(120000);
	});

	it('Test startClustering functions calls startService for all the clustering services', async () => {
		const start_service_stub = sandbox.stub();
		const start_worker_stub = sandbox.stub();
		const create_queue_stub = sandbox.stub();
		const start_service_rw = utility_functions.__set__('startService', start_service_stub);
		const start_worker_rw = utility_functions.__set__('startWorker', start_worker_stub);
		const create_queue_rw = utility_functions.__set__('nats_utils.createWorkQueueStream', create_queue_stub);
		get_all_node_records_stub.resolves([{ system_info: { hdb_version: '3.x.x' } }]);
		await utility_functions.startClustering();
		expect(start_service_stub.getCall(0).args[0]).to.equal('Clustering Hub');
		expect(start_service_stub.getCall(1).args[0]).to.equal('Clustering Leaf');
		expect(start_worker_stub.getCall(0).args[1].name).to.equal('Clustering Ingest Service');
		expect(start_worker_stub.getCall(1).args[1].name).to.equal('Clustering Reply Service');
		expect(start_worker_stub.getCall(2).args[1].name).to.equal('Upgrade-4-0-0');
		expect(create_queue_stub.args[0][0]).to.eql({
			stream_name: '__HARPERDB_WORK_QUEUE__',
			durable_name: 'HDB_WORK_QUEUE',
			deliver_group: 'HDB',
			deliver_subject: '__HDB__.WORKQUEUE',
		});
		start_service_rw();
		create_queue_rw();
		get_all_node_records_stub.resolves([]);
	});

	describe('Test isHdbRestartRunning function', () => {
		it('Test true is returned if hdb restart running', async () => {
			const fake_list = [{ name: 'IPC' }, { name: 'Custom Functions' }, { name: 'Restart HDB' }];
			const list_rw = utility_functions.__set__('list', sandbox.stub().resolves(fake_list));
			const result = await utility_functions.isHdbRestartRunning();
			expect(result).to.be.true;
			list_rw();
		});

		it('Test false is returned if hdb restart not running', async () => {
			const fake_list = [{ name: 'IPC' }, { name: 'Custom Functions' }, { name: 'HarperDB' }];
			const list_rw = utility_functions.__set__('list', sandbox.stub().resolves(fake_list));
			const result = await utility_functions.isHdbRestartRunning();
			expect(result).to.be.false;
			list_rw();
		});
	});

	it('Test stopClustering calls stop for all the clustering processes', async () => {
		const stop_stub = sandbox.stub();
		const stop_rw = utility_functions.__set__('stop', stop_stub);
		await utility_functions.stopClustering();
		expect(stop_stub.getCall(0).args[0]).to.equal('Clustering Hub');
		expect(stop_stub.getCall(1).args[0]).to.equal('Clustering Leaf');
		expect(stop_stub.getCall(2).args[0]).to.equal('Clustering Ingest Service');
		expect(stop_stub.getCall(3).args[0]).to.equal('Clustering Reply Service');
		stop_rw();
	});

	it('Test isClusteringRunning returns true if all clustering services running', async () => {
		const is_reg_stub = sandbox.stub().resolves(true);
		const is_reg_rw = utility_functions.__set__('isServiceRegistered', is_reg_stub);
		const result = await utility_functions.isClusteringRunning();
		expect(result).to.be.true;
		is_reg_rw();
	});

	it('Test isClusteringRunning returns false if all clustering services not running', async () => {
		const is_reg_stub = sandbox.stub().resolves(false);
		const is_reg_rw = utility_functions.__set__('isServiceRegistered', is_reg_stub);
		const result = await utility_functions.isClusteringRunning();
		expect(result).to.be.false;
		is_reg_rw();
	});

	it('Test reloadClustering calls all the functions needed to run happy path', async () => {
		const generate_nats_config_stub = sandbox.stub(nats_config, 'generateNatsConfig');
		const reload_nats_hub_stub = sandbox.stub(nats_utils, 'reloadNATSHub');
		const reload_nats_leaf_stub = sandbox.stub(nats_utils, 'reloadNATSLeaf');
		await utility_functions.reloadClustering();

		expect(generate_nats_config_stub.args[0][0]).to.equal(true);
		expect(reload_nats_hub_stub.called).to.be.true;
		expect(reload_nats_leaf_stub.called).to.be.true;
		expect(remove_nats_config_stub.getCall(0).args[0]).to.equal('clustering hub');
		expect(remove_nats_config_stub.getCall(1).args[0]).to.equal('clustering leaf');
	});
}).timeout(10000);
