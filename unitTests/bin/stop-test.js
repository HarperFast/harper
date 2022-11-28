'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const expect = chai.expect;
const settings_test_file = require('../settingsTestFile');
const logger = require('../../utility/logging/harper_logger');
const pm2_utils = require('../../utility/pm2/utilityFunctions');
const env_manager = require('../../utility/environment/environmentManager');
const hdb_terms = require('../../utility/hdbTerms');
const nats_config = require('../../server/nats/utility/natsConfig');
const rewire = require('rewire');
const config_utils = require('../../config/configUtils');
const nats_utils = require('../../server/nats/utility/natsUtils');

let stop;

chai.use(sinon_chai);

const TEST_ERROR = 'Test error stop tests';

function clearServiceArgs() {
	const service_index = process.argv.indexOf('--service');
	if (service_index > -1) process.argv.splice(service_index, 1);
	const names_index = process.argv.indexOf('not service,harperdb,ipc,custom functions,clustering');
	if (names_index > -1) process.argv.splice(names_index, 1);
}

/**
 * Unit tests for bin/stop.js
 */
describe('Test stop.js', () => {
	let sandbox = sinon.createSandbox();
	let is_service_reg_stub;
	let is_hdb_restart_running_stub;
	let start_clustering_stub;
	let stop_clustering_stub;
	let update_node_name_stub;
	let close_connection_stub;
	let get_config_from_file_stub;
	let create_work_queue_stream_stub;

	afterEach(() => {
		sandbox.resetHistory();
	});

	before(() => {
		settings_test_file.buildFile();
		is_service_reg_stub = sandbox.stub(pm2_utils, 'isServiceRegistered');
		// I had console.log as a stub but it was stopping npm test from running on the command line.
		stop = rewire('../../bin/stop');
		get_config_from_file_stub = sandbox.stub(config_utils, 'getConfigFromFile').returns(true);
		sandbox.stub(nats_config, 'generateNatsConfig');
		is_hdb_restart_running_stub = sandbox.stub(pm2_utils, 'isHdbRestartRunning');
		start_clustering_stub = sandbox.stub(pm2_utils, 'startClustering').resolves();
		stop_clustering_stub = sandbox.stub(pm2_utils, 'stopClustering');
		update_node_name_stub = sandbox.stub(nats_utils, 'updateNodeNameLocalStreams');
		close_connection_stub = sandbox.stub(nats_utils, 'closeConnection');
		create_work_queue_stream_stub = sandbox.stub(nats_utils, 'createWorkQueueStream');
	});

	after(() => {
		settings_test_file.deleteFile();
		rewire('../../bin/stop');
		sandbox.restore();
	});

	/**
	 * Tests for restartProcesses function
	 */
	context('restart processes', () => {
		sandbox = sinon.createSandbox();
		let restart_service_stub = sandbox.stub().resolves();
		let restart_service_rw;
		let restart_all_services_stub;
		let pm2_stop_stub;
		let start_service_stub;
		let log_notify_stub;

		before(() => {
			restart_service_rw = stop.__set__('restartService', restart_service_stub);
			restart_all_services_stub = sandbox.stub(pm2_utils, 'restartAllServices').resolves();
			pm2_stop_stub = sandbox.stub(pm2_utils, 'stop').resolves();
			start_service_stub = sandbox.stub(pm2_utils, 'startService').resolves();
			log_notify_stub = sandbox.stub(logger, 'notify');
		});

		beforeEach(() => {
			is_hdb_restart_running_stub.resolves(false);
		});

		after(() => {
			restart_service_rw();
			clearServiceArgs();
			start_service_stub.restore();
			pm2_stop_stub.restore();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test restart all services is called if no service args passed', async () => {
			const response = await stop.restartProcesses();
			expect(response).to.equal('Restarting HarperDB. This may take up to 60 seconds.');
			expect(restart_all_services_stub.called).to.be.true;
		});

		it('Test restart all services custom functions started', async () => {
			is_service_reg_stub.withArgs('Custom Functions').resolves(false);
			const response = await stop.restartProcesses();

			expect(response).to.equal('Restarting HarperDB. This may take up to 60 seconds.');
			expect(restart_all_services_stub.called).to.be.true;
			expect(start_service_stub.getCall(4).args[0]).to.equal('Custom Functions');
		});

		it('Test restart all services custom functions stopped', async () => {
			get_config_from_file_stub.returns(false);
			is_service_reg_stub.withArgs('Custom Functions').resolves(true);
			const response = await stop.restartProcesses();

			expect(response).to.equal('Restarting HarperDB. This may take up to 60 seconds.');
			expect(restart_all_services_stub.called).to.be.true;
			expect(pm2_stop_stub.getCall(0).args[0]).to.equal('Custom Functions');
		});

		it('Test restart service is called for each service if args are passed', async () => {
			get_config_from_file_stub.returns(true);
			is_service_reg_stub.withArgs('HarperDB').resolves(true);
			is_service_reg_stub.withArgs('IPC').resolves(true);
			is_service_reg_stub.withArgs('Custom Functions').resolves(true);
			let test_args = ['--service', 'not service,harperdb,ipc,custom functions,clustering'];
			process.argv.push(...test_args);
			await stop.restartProcesses();

			expect(restart_service_stub.getCall(0).args[0].service).to.equal('HarperDB');
			expect(restart_service_stub.getCall(1).args[0].service).to.equal('IPC');
			expect(restart_service_stub.getCall(2).args[0].service).to.equal('Custom Functions');
		});

		it('Test restart service is called for each service if args are passed service started', async () => {
			clearServiceArgs();
			get_config_from_file_stub.returns(true);
			is_service_reg_stub.withArgs('HarperDB').resolves(true);
			is_service_reg_stub.withArgs('IPC').resolves(true);
			is_service_reg_stub.withArgs('Custom Functions').resolves(false);
			is_service_reg_stub.withArgs('Clustering Hub').resolves(false);
			is_service_reg_stub.withArgs('Clustering Leaf').resolves(false);
			let test_args = ['--service', 'not service,harperdb,ipc,custom functions,clustering hub,clustering leaf'];
			process.argv.push(...test_args);
			await stop.restartProcesses();

			expect(restart_service_stub.getCall(0).args[0].service).to.equal('HarperDB');
			expect(restart_service_stub.getCall(1).args[0].service).to.equal('IPC');
			expect(start_service_stub.getCall(1).args[0]).to.equal('Clustering Hub');
			expect(start_service_stub.getCall(2).args[0]).to.equal('Clustering Leaf');
			expect(start_service_stub.getCall(0).args[0]).to.equal('Custom Functions');
		});

		it('Test restart service is called for each service if args are passed service stopped', async () => {
			clearServiceArgs();
			env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, false);
			get_config_from_file_stub.returns(false);
			is_service_reg_stub.withArgs('HarperDB').resolves(false);
			is_service_reg_stub.withArgs('IPC').resolves(true);
			is_service_reg_stub.withArgs('Custom Functions').resolves(true);
			is_service_reg_stub.withArgs('Clustering Hub').resolves(true);
			is_service_reg_stub.withArgs('Clustering Leaf').resolves(true);
			let test_args = ['--service', 'not service,harperdb,ipc,custom functions,clustering hub,clustering leaf'];
			process.argv.push(...test_args);
			await stop.restartProcesses();

			expect(start_service_stub.getCall(0).args[0]).to.equal('HarperDB');
			expect(restart_service_stub.getCall(1).args[0].service).to.equal('IPC');
			expect(pm2_stop_stub.getCall(1).args[0]).to.equal('Clustering Hub');
			expect(pm2_stop_stub.getCall(2).args[0]).to.equal('Clustering Leaf');
			expect(pm2_stop_stub.getCall(0).args[0]).to.equal('Custom Functions');
		});

		it('Test restart is aborted if arg passed to restart', async () => {
			clearServiceArgs();
			is_hdb_restart_running_stub.resolves(true);
			let test_args = ['--service', 'harperdb'];
			process.argv.push(...test_args);
			await stop.restartProcesses();
			expect(log_notify_stub.args[0][0]).to.equal(
				'HarperDB is currently restarting and must complete before another HarperDB restart can be initialized.'
			);
		});

		it('Test restart is aborted if restart all', async () => {
			clearServiceArgs();
			is_hdb_restart_running_stub.resolves(true);
			const result = await stop.restartProcesses();
			expect(log_notify_stub.args[0][0]).to.equal(
				'HarperDB is currently restarting and must complete before another HarperDB restart can be initialized.'
			);

			expect(result).to.equal(
				'HarperDB is currently restarting and must complete before another HarperDB restart can be initialized.'
			);
		});

		it('Test error message is returned', async () => {
			clearServiceArgs();
			let test_args = ['--service', 'harperdb'];
			process.argv.push(...test_args);
			restart_service_stub.throws(TEST_ERROR);
			const is_reg_rw = stop.__set__('pm2_utils.isServiceRegistered', sandbox.stub().resolves(true));
			const response = await stop.restartProcesses();
			expect(response).to.equal('There was an error restarting HarperDB. Test error stop tests');
			is_reg_rw();
		});
	});

	describe('Test restartService function', () => {
		sandbox = sinon.createSandbox();
		let reload_stub;
		let restart_stub;
		let start_service_stub;
		let pm2_stop_stub;

		before(() => {
			reload_stub = sandbox.stub(pm2_utils, 'reloadStopStart');
			restart_stub = sandbox.stub(pm2_utils, 'restart');
			start_service_stub = sandbox.stub(pm2_utils, 'startService').resolves();
			pm2_stop_stub = sandbox.stub(pm2_utils, 'stop').resolves();
		});

		beforeEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			pm2_stop_stub.restore();
		});

		it('Test missing service error thrown', async () => {
			const expected_err = test_util.generateHDBError("'service' is required", 400);
			await test_util.assertErrorAsync(stop.restartService, [{ operation: 'restart_service' }], expected_err);
		});

		it('Test invalid service error thrown', async () => {
			const expected_err = test_util.generateHDBError('Invalid service', 400);
			await test_util.assertErrorAsync(
				stop.restartService,
				[{ operation: 'restart_service', service: 'no_service' }],
				expected_err
			);
		});

		it('Test reload restart is called happy path', async () => {
			const result = await stop.restartService({ service: 'harperdb' });
			expect(result).to.equal('Restarting HarperDB');
			expect(reload_stub.called).to.be.true;
			expect(restart_stub.called).to.be.false;
		});

		it('Test restart restart is called happy path', async () => {
			const result = await stop.restartService({ service: 'ipc' });
			expect(result).to.equal('Restarting IPC');
			expect(reload_stub.called).to.be.false;
			expect(restart_stub.called).to.be.true;
		});

		it('Test custom functions is started if not registered', async () => {
			get_config_from_file_stub.returns(true);
			is_service_reg_stub.withArgs('Custom Functions').resolves(false);
			const result = await stop.restartService({ service: 'Custom Functions' });
			expect(start_service_stub.called).to.be.true;
			expect(result).to.equal('Restarting Custom Functions');
		});

		it('Test custom functions is stopped if registered', async () => {
			get_config_from_file_stub.returns(false);
			is_service_reg_stub.withArgs('Custom Functions').resolves(true);
			const result = await stop.restartService({ service: 'Custom Functions' });
			expect(pm2_stop_stub.called).to.be.true;
			expect(result).to.equal('Restarting Custom Functions');
		});

		it('Test custom functions is reloaded if registered', async () => {
			get_config_from_file_stub.returns(true);
			is_service_reg_stub.withArgs('Custom Functions').resolves(true);
			const result = await stop.restartService({ service: 'Custom Functions' });
			expect(reload_stub.called).to.be.true;
			expect(result).to.equal('Restarting Custom Functions');
		});

		// TODO: These should be addressed as part of CORE-1493
		/*		it('Test clustering is started if not registered', async () => {
			check_env_setting_stub.returns({ clustering_enabled: true, custom_func_enabled: true });
			is_service_reg_stub.withArgs('Clustering').resolves(false);
			const result = await stop.restartService({ service: 'Clustering' });
			expect(start_service_stub.called).to.be.true;
			expect(result).to.equal('Restarting Clustering');
		});

		it('Test clustering is stopped if registered', async () => {
			check_env_setting_stub.returns({ clustering_enabled: false, custom_func_enabled: false });
			is_service_reg_stub.withArgs('Clustering').resolves(true);
			const result = await stop.restartService({ service: 'Clustering' });
			expect(pm2_stop_stub.called).to.be.true;
			expect(result).to.equal('Restarting Clustering');
		});

		it('Test clustering is reloaded if registered', async () => {
			check_env_setting_stub.returns({ clustering_enabled: true, custom_func_enabled: false });
			is_service_reg_stub.withArgs('Clustering').resolves(true);
			const result = await stop.restartService({ service: 'Clustering' });
			expect(restart_stub.called).to.be.true;
			expect(result).to.equal('Restarting Clustering');
		});*/

		it('Test HarperDB is not restarted if restart script is running', async () => {
			is_hdb_restart_running_stub.resolves(true);
			const result = await stop.restartService({ service: 'HarperDB' });
			expect(result).to.equal(
				'HarperDB is currently restarting and must complete before another HarperDB restart can be initialized.'
			);
		});
	});

	describe('Test stop function', () => {
		sandbox = sinon.createSandbox();
		let stop_all_services_stub;
		let stop_stub;

		before(() => {
			stop_all_services_stub = sandbox.stub(pm2_utils, 'stopAllServices');
			stop_stub = sandbox.stub(pm2_utils, 'stop');
		});

		beforeEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			const service_index = process.argv.indexOf('--service');
			if (service_index > -1) process.argv.splice(service_index, 1);
			const names_index = process.argv.indexOf('not service,harperdb,ipc,custom functions');
			if (names_index > -1) process.argv.splice(names_index, 1);
		});

		it('Test stop all services is called if no service args passed', async () => {
			await stop.stop();
			expect(stop_all_services_stub.called).to.be.true;
		});

		it('Test stop is called for each service if args are passed', async () => {
			let test_args = ['--service', 'not service,harperdb,ipc,custom functions'];
			process.argv.push(...test_args);
			await stop.stop();
			expect(stop_stub.getCall(0).args[0]).to.equal('HarperDB');
			expect(stop_stub.getCall(1).args[0]).to.equal('IPC');
			expect(stop_stub.getCall(2).args[0]).to.equal('Custom Functions');
		});
	});

	describe('Test restartClustering function', () => {
		const is_clustering_running_stub = sandbox.stub();
		const stop_clustering_stub = sandbox.stub();
		const reload_clustering_stub = sandbox.stub();
		let restartClustering;

		before(() => {
			restartClustering = stop.__get__('restartClustering');
			stop.__set__('pm2_utils.isClusteringRunning', is_clustering_running_stub);
			stop.__set__('pm2_utils.stopClustering', stop_clustering_stub);
			stop.__set__('pm2_utils.reloadClustering', reload_clustering_stub);
		});

		after(() => {
			rewire('../../bin/stop');
		});

		it('Test clustering stopped if running but not enabled', async () => {
			is_clustering_running_stub.resolves(true);
			get_config_from_file_stub.returns(false);
			await restartClustering('clustering');
			expect(stop_clustering_stub.called).to.be.true;
		});

		it('Test clustering started if not running but enabled', async () => {
			is_clustering_running_stub.resolves(false);
			get_config_from_file_stub.returns(true);
			await restartClustering('clustering');
			expect(start_clustering_stub.called).to.be.true;
		});

		it('Test clustering config reloads clustering', async () => {
			is_clustering_running_stub.resolves(true);
			await restartClustering('clustering config');
			expect(reload_clustering_stub.called).to.be.true;
		});
	});
});
