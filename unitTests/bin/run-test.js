'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
chai.use(require('chai-integer'));
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
const test_util = require('../test_utils');
const env_mangr = require('../../utility/environment/environmentManager');
const hdb_terms = require('../../utility/hdbTerms');
const pm2_utils = require('../../utility/processManagement/processManagement');
const nats_config = require('../../server/nats/utility/natsConfig');
const child_process = require('child_process');
const settings_test_file = require('../settingsTestFile');
const { Worker } = require('node:worker_threads');
let hdbInfoController;
let schema_describe;
let upgrade;
let stop;
let run_rw;

describe('Test run module', () => {
	const sandbox = sinon.createSandbox();
	const TEST_ERROR = 'I am a unit test error test';
	const log_notify_stub = sandbox.stub().callsFake(() => {});
	const log_error_stub = sandbox.stub().callsFake(() => {});
	const log_info_stub = sandbox.stub().callsFake(() => {});
	const log_fatal_stub = sandbox.stub().callsFake(() => {});
	const log_trace_stub = sandbox.stub().callsFake(() => {});
	const logger_fake = {
		notify: log_notify_stub,
		error: log_error_stub,
		info: log_info_stub,
		fatal: log_fatal_stub,
		trace: log_trace_stub,
	};
	let log_rw;
	let console_log_stub;
	let console_error_stub;
	let process_exit_stub;
	let start_all_services_stub;
	let start_service_stub;
	let spawn_stub;
	let get_prob_stub;
	let start_clustering_stub;
	let fake_spawn = {
		on: () => {},
		stdout: {
			on: () => {},
		},
		stderr: {
			on: () => {},
		},
		pid: 1234789,
	};

	before(() => {
		settings_test_file.buildFile();
		// These are here because having them in the usual spot was causing errors in other tests. I dont know why exactly... but this helps.
		hdbInfoController = require('../../dataLayer/hdbInfoController');
		schema_describe = require('../../dataLayer/schemaDescribe');
		upgrade = require('../../bin/upgrade');
		stop = require('../../bin/stop');

		get_prob_stub = sandbox.stub(env_mangr, 'get');
		get_prob_stub.withArgs('rootPath').returns('unit-test');
		spawn_stub = sandbox.stub(child_process, 'spawn').returns(fake_spawn);
		start_all_services_stub = sandbox.stub(pm2_utils, 'startAllServices').resolves();
		start_service_stub = sandbox.stub(pm2_utils, 'startService').resolves();
		start_clustering_stub = sandbox.stub(pm2_utils, 'startClusteringProcesses').resolves();
		process_exit_stub = sandbox.stub(process, 'exit');
		console_log_stub = sandbox.stub(console, 'log');
		console_error_stub = sandbox.stub(console, 'error');
		sandbox.stub(fs, 'writeFile');
		test_util.preTestPrep();
		run_rw = rewire('../../bin/run');
		log_rw = run_rw.__set__('hdbLogger', logger_fake);
		sandbox.stub(nats_config, 'generateNatsConfig');
		env_mangr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_ENABLED, false);
	});

	after(() => {
		settings_test_file.deleteFile();
		sandbox.resetHistory();
		sandbox.restore();
		log_rw();
		rewire('../../bin/run');
	});

	describe('Test run function', () => {
		const is_hdb_installed_stub = sandbox.stub();
		const create_log_file_stub = sandbox.stub();
		const check_jwt_tokens_stub = sandbox.stub();
		const install_stub = sandbox.stub();
		let is_hdb_installed_rw;
		let check_audit_log_env_exists_rw;
		let install_rw;
		let get_ver_update_info_stub;
		let upgrade_stub;
		let run;

		before(() => {
			run_rw.__set__('checkJwtTokens', check_jwt_tokens_stub);
			run_rw.__set__('hdbLogger.createLogFile', create_log_file_stub);
			is_hdb_installed_rw = run_rw.__set__('isHdbInstalled', is_hdb_installed_stub);
			install_rw = run_rw.__set__('install', install_stub);
			get_ver_update_info_stub = sandbox.stub(hdbInfoController, 'getVersionUpdateInfo');
			upgrade_stub = sandbox.stub(upgrade, 'upgrade');
			run = run_rw.__get__('launch');
		});

		beforeEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			is_hdb_installed_rw();
			install_rw();
			const service_index = process.argv.indexOf('--service');
			if (service_index > -1) process.argv.splice(service_index, 1);
			const names_index = process.argv.indexOf('not service,harperdb,itc,custom functions');
			if (names_index > -1) process.argv.splice(names_index, 1);
		});

		it('Test run happy path all services started, all functions are called as expected', async () => {
			get_prob_stub.withArgs('CLUSTERING').returns(true);
			get_prob_stub.withArgs('CUSTOM_FUNCTIONS').returns(true);
			is_hdb_installed_stub.resolves(true);
			get_ver_update_info_stub.resolves(undefined);
			await run();
		});

		it('Test upgrade is called if upgrade version permits', async () => {
			env_mangr.setProperty(hdb_terms.CONFIG_PARAMS.ROOTPATH, 'unit-test');
			is_hdb_installed_stub.resolves(true);
			get_ver_update_info_stub.resolves({ upgrade_version: '9.9.9' });
			await run();

			expect(upgrade_stub).to.have.been.calledWith({ upgrade_version: '9.9.9' });
			expect(console_log_stub).to.have.been.calledWith('Upgrade complete.  Starting HarperDB.');
		});

		it('Test upgrade error with version is handled correctly', async () => {
			is_hdb_installed_stub.resolves(true);
			get_ver_update_info_stub.resolves({ upgrade_version: '9.9.9' });
			upgrade_stub.throws(TEST_ERROR);
			await run();

			expect(console_error_stub.getCall(0).firstArg).to.equal(
				'Got an error while trying to upgrade your HarperDB instance to version 9.9.9.  Exiting HarperDB.'
			);
			expect(log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
			expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
		});

		it('Test upgrade error without version is handled correctly', async () => {
			is_hdb_installed_stub.resolves(true);
			get_ver_update_info_stub.throws(TEST_ERROR);
			await run();

			expect(console_error_stub.getCall(0).firstArg).to.equal(
				'Got an error while trying to upgrade your HarperDB instance.  Exiting HarperDB.'
			);
			expect(log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
			expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
			get_ver_update_info_stub.resolves();
		});

		it('Test install is called if HDB not installed', async () => {
			is_hdb_installed_stub.resolves(false);
			await run();
			expect(install_stub).to.have.been.called;
		});

		it('Test error from install is handled as expected', async () => {
			is_hdb_installed_stub.resolves(false);
			install_stub.throws(TEST_ERROR);
			await run();

			expect(console_error_stub.getCall(0).firstArg).to.equal(
				'There was an error during install, check install_log.log for more details.  Exiting.'
			);
			expect(log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
			expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
		});

		it('Test error from isHdbInstalled is handled as expected', async () => {
			is_hdb_installed_stub.throws(TEST_ERROR);
			await run();
			expect(console_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
			expect(log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
			expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
			is_hdb_installed_stub.resolves(true);
		});
		it('Test that a user thread can access harperdb as a module', async () => {
			// Unfortunately this test is probably only get to test source version, but problems have occurred built version
			const worker = new Worker(__dirname + '/user-thread.js');
			return new Promise((resolve) => {
				worker.on('message', (message) => {
					expect(message.hasResource).to.be.true;
					expect(message.hasServer).to.be.true;
					resolve();
				});
			});
		});
	});

	describe('Test writeLicenseFromVars function', () => {
		let fs_mkdirpSync_spy;
		let fs_writeFileSync_spy;
		let rw_writeLicenseFromVars;
		let assign_CMD_ENV_variables_rw;
		const LICENSE_PATH = path.join(test_util.getMockTestPath(), 'keys/.license');
		const REG_PATH = path.join(LICENSE_PATH, '060493.ks');
		const LIC_PATH = path.join(LICENSE_PATH, '.license');
		let assignCMDENVVariables_stub = sandbox.stub();

		before(() => {
			sandbox.resetHistory();
			fs.removeSync(LICENSE_PATH);
			fs_mkdirpSync_spy = sandbox.spy(fs, 'mkdirpSync');
			fs_writeFileSync_spy = sandbox.spy(fs, 'writeFileSync');
			rw_writeLicenseFromVars = run_rw.__get__('writeLicenseFromVars');
			assign_CMD_ENV_variables_rw = run_rw.__set__('assignCMDENVVariables', assignCMDENVVariables_stub);
		});

		afterEach(() => {
			fs.removeSync(LICENSE_PATH);
			sandbox.resetHistory();
		});

		it('test happy path', () => {
			assignCMDENVVariables_stub.returns({
				HARPERDB_FINGERPRINT: 'the fingerprint',
				HARPERDB_LICENSE: 'the best license ever',
			});

			rw_writeLicenseFromVars();
			expect(console_error_stub.callCount).to.equal(0);
			expect(log_error_stub.callCount).to.equal(0);

			expect(assignCMDENVVariables_stub.callCount).to.eq(1);
			expect(assignCMDENVVariables_stub.firstCall.args[0]).to.have.members([
				'HARPERDB_FINGERPRINT',
				'HARPERDB_LICENSE',
			]);
			expect(assignCMDENVVariables_stub.firstCall.exception).to.eq(undefined);
			expect(assignCMDENVVariables_stub.firstCall.returnValue).to.eql({
				HARPERDB_FINGERPRINT: 'the fingerprint',
				HARPERDB_LICENSE: 'the best license ever',
			});

			expect(fs_mkdirpSync_spy.callCount).to.eql(1);
			expect(fs_writeFileSync_spy.callCount).to.eql(2);
			expect(fs_writeFileSync_spy.firstCall.exception).to.eql(undefined);
			expect(fs_writeFileSync_spy.firstCall.args[0]).to.include('.license/060493.ks');
			expect(fs_writeFileSync_spy.firstCall.args[1]).to.equal('the fingerprint');
			expect(fs_writeFileSync_spy.secondCall.exception).to.eql(undefined);
			expect(fs_writeFileSync_spy.secondCall.args[0]).to.include('.license');
			expect(fs_writeFileSync_spy.secondCall.args[1]).to.equal('the best license ever');
		});

		it('test no license', () => {
			assignCMDENVVariables_stub.returns({
				HARPERDB_FINGERPRINT: 'the fingerprint',
			});

			rw_writeLicenseFromVars();
			expect(console_error_stub.callCount).to.equal(0);
			expect(log_error_stub.callCount).to.equal(0);

			expect(assignCMDENVVariables_stub.callCount).to.eq(1);
			expect(assignCMDENVVariables_stub.firstCall.args[0]).to.have.members([
				'HARPERDB_FINGERPRINT',
				'HARPERDB_LICENSE',
			]);
			expect(assignCMDENVVariables_stub.firstCall.exception).to.eq(undefined);
			expect(assignCMDENVVariables_stub.firstCall.returnValue).to.eql({ HARPERDB_FINGERPRINT: 'the fingerprint' });

			expect(fs_mkdirpSync_spy.callCount).to.eql(0);
			expect(fs_writeFileSync_spy.callCount).to.eql(0);
		});

		it('test no fingerprint', () => {
			assignCMDENVVariables_stub.returns({
				HARPERDB_LICENSE: 'the license',
			});

			rw_writeLicenseFromVars();
			expect(console_error_stub.callCount).to.equal(0);
			expect(log_error_stub.callCount).to.equal(0);

			expect(assignCMDENVVariables_stub.callCount).to.eq(1);
			expect(assignCMDENVVariables_stub.firstCall.args[0]).to.have.members([
				'HARPERDB_FINGERPRINT',
				'HARPERDB_LICENSE',
			]);
			expect(assignCMDENVVariables_stub.firstCall.exception).to.eq(undefined);
			expect(assignCMDENVVariables_stub.firstCall.returnValue).to.eql({ HARPERDB_LICENSE: 'the license' });

			expect(fs_mkdirpSync_spy.callCount).to.eql(0);
			expect(fs_writeFileSync_spy.callCount).to.eql(0);
		});

		it('test writefile errors', () => {
			assignCMDENVVariables_stub.returns({
				HARPERDB_FINGERPRINT: 'the fingerprint',
				HARPERDB_LICENSE: 'the license',
			});

			fs_writeFileSync_spy.restore();
			let fs_writeFileSync_stub = sandbox.stub(fs, 'writeFileSync').throws('fail!');

			rw_writeLicenseFromVars();
			expect(console_error_stub.callCount).to.equal(1);
			expect(log_error_stub.callCount).to.equal(1);

			expect(assignCMDENVVariables_stub.callCount).to.eq(1);
			expect(assignCMDENVVariables_stub.firstCall.args[0]).to.have.members([
				'HARPERDB_FINGERPRINT',
				'HARPERDB_LICENSE',
			]);
			expect(assignCMDENVVariables_stub.firstCall.exception).to.eq(undefined);
			expect(assignCMDENVVariables_stub.firstCall.returnValue).to.eql({
				HARPERDB_LICENSE: 'the license',
				HARPERDB_FINGERPRINT: 'the fingerprint',
			});

			expect(fs_mkdirpSync_spy.callCount).to.eql(1);
			expect(fs_writeFileSync_stub.callCount).to.eql(1);
			expect(fs_writeFileSync_stub.firstCall.exception.name).to.eql('fail!');
		});
	});

	/*	describe('Test checkAuditLogEnvironmentsExist function', async () => {
		const open_create_trans_env_stub = sandbox.stub();
		const describe_results_test = {
			northnwd: {
				customers: {},
			},
		};
		let open_create_audit_env_rw;
		let checkAuditLogEnvironmentsExist;

		before(() => {
			sandbox.stub(schema_describe, 'describeAll').resolves(describe_results_test);
			open_create_audit_env_rw = run_rw.__set__('openCreateAuditEnvironment', open_create_trans_env_stub);
			checkAuditLogEnvironmentsExist = run_rw.__get__('checkAuditLogEnvironmentsExist');
		});

		after(() => {
			open_create_audit_env_rw();
		});

		it('Test checkAuditLogEnvironmentsExist happy path', async () => {
			await checkAuditLogEnvironmentsExist();
			expect(open_create_trans_env_stub.getCall(0).args).to.eql(['system', 'hdb_table']);
			expect(open_create_trans_env_stub.getCall(1).args).to.eql(['system', 'hdb_attribute']);
			expect(open_create_trans_env_stub.getCall(2).args).to.eql(['system', 'hdb_schema']);
			expect(open_create_trans_env_stub.getCall(3).args).to.eql(['system', 'hdb_user']);
			expect(open_create_trans_env_stub.getCall(4).args).to.eql(['system', 'hdb_role']);
			expect(open_create_trans_env_stub.getCall(5).args).to.eql(['system', 'hdb_job']);
			expect(open_create_trans_env_stub.getCall(6).args).to.eql(['system', 'hdb_license']);
			expect(open_create_trans_env_stub.getCall(7).args).to.eql(['system', 'hdb_info']);
			expect(open_create_trans_env_stub.getCall(8).args).to.eql(['system', 'hdb_nodes']);
			expect(open_create_trans_env_stub.getCall(9).args).to.eql(['system', 'hdb_analytics']);
			expect(open_create_trans_env_stub.getCall(10).args).to.eql(['system', 'hdb_raw_analytics']);
			expect(open_create_trans_env_stub.getCall(11).args).to.eql(['system', 'hdb_temp']);
			expect(open_create_trans_env_stub.getCall(12).args).to.eql(['system', 'hdb_durable_session']);
			expect(open_create_trans_env_stub.getCall(13).args).to.eql(['system', 'hdb_session_will']);
			expect(open_create_trans_env_stub.getCall(14).args).to.eql(['northnwd', 'customers']);
			expect(log_info_stub.getCall(0).firstArg).to.equal('Checking Transaction Audit Environments exist');
			expect(log_info_stub.getCall(1).firstArg).to.equal('Finished checking Transaction Audit Environments exist');
		});
	});*/

	describe('Test openCreateAuditEnvironment function', () => {
		let lmdb_create_txn_env_stub = sandbox.stub();
		let openCreateAuditEnvironment;

		before(() => {
			run_rw.__set__('lmdbCreateTxnEnvironment', lmdb_create_txn_env_stub);
			openCreateAuditEnvironment = run_rw.__get__('openCreateAuditEnvironment');
		});

		beforeEach(() => {
			sandbox.resetHistory();
		});

		it('Test openCreateAuditEnvironment happy path', async () => {
			const expected_obj = {
				schema: 'unit_tests',
				table: 'are_amazing',
				hash_attribute: undefined,
			};
			await openCreateAuditEnvironment('unit_tests', 'are_amazing');

			expect(lmdb_create_txn_env_stub).to.have.been.calledWith(sandbox.match(expected_obj));
		});

		it('Test openCreateAuditEnvironment sad path', async () => {
			lmdb_create_txn_env_stub.throws(new Error(TEST_ERROR));
			await openCreateAuditEnvironment('unit_tests', 'are_amazing');

			expect(console_error_stub.getCall(0).firstArg).to.equal(
				'Unable to create the transaction audit environment for unit_tests.are_amazing, due to: I am a unit test error test'
			);
			expect(log_error_stub.getCall(0).firstArg).to.equal(
				'Unable to create the transaction audit environment for unit_tests.are_amazing, due to: I am a unit test error test'
			);
		});
	});

	describe('Test isHdbInstalled function', () => {
		let isHdbInstalled;
		let fs_stat_stub;

		before(() => {
			get_prob_stub.restore();
			fs_stat_stub = sandbox.stub(fs, 'stat');
			isHdbInstalled = run_rw.__get__('isHdbInstalled');
		});

		beforeEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			fs_stat_stub.restore();
		});

		it('Test two calls to fs stat with the correct arguments happy path', async () => {
			const result = await isHdbInstalled();

			expect(result).to.be.true;
			expect(fs_stat_stub.getCall(1).args[0]).to.include(`harperdb${path.sep}unitTests${path.sep}settings.test`);
		});

		it('Test ENOENT err code returns false', async () => {
			let err = new Error(TEST_ERROR);
			err.code = 'ENOENT';
			fs_stat_stub.throws(err);
			const result = await isHdbInstalled();

			expect(result).to.be.false;
		});

		it('Test non ENOENT error is handled as expected', async () => {
			fs_stat_stub.throws(new Error(TEST_ERROR));
			await test_util.assertErrorAsync(isHdbInstalled, [], new Error(TEST_ERROR));
			expect(log_error_stub.getCall(0).firstArg).to.equal(
				'Error checking for HDB install - Error: I am a unit test error test'
			);
		});
	});

	it('Test startupLog', () => {
		sandbox.resetHistory();
		run_rw.startupLog(new Map());
		const test_values = [
			'Worker Threads',
			'Root Path',
			'Debugging',
			'Logging',
			'Default',
			'Operations API',
			'MQTT',
			'Replication',
		];
		test_values.forEach((value) => expect(console_log_stub.args[0][0]).to.include(value));
	});
});
