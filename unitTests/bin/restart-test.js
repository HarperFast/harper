'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const process_man = require('../../utility/processManagement/processManagement');
const nats_config = require('../../server/nats/utility/natsConfig');
const nats_utils = require('../../server/nats/utility/natsUtils');
const config_utils = require('../../config/configUtils');
const env_mgr = require('../../utility/environment/environmentManager');
const sys_info = require('../../utility/environment/systemInformation');
const restart = rewire('../../bin/restart');

describe('Test restart module', () => {
	const sandbox = sinon.createSandbox();
	let is_service_reg_stub;
	let console_error_stub;
	let process_man_restart_stub;
	let remove_nats_config_stub;
	let restart_workers_stub;
	let get_config_from_file;
	let process_exit_stub;

	before(() => {
		is_service_reg_stub = sandbox.stub(process_man, 'isServiceRegistered');
		console_error_stub = sandbox.stub(console, 'error');
		process_man_restart_stub = sandbox.stub(process_man, 'restart');
		remove_nats_config_stub = sandbox.stub(nats_config, 'removeNatsConfig');
		restart_workers_stub = sandbox.stub();
		restart.__set__('restartWorkers', restart_workers_stub);
		get_config_from_file = sandbox.stub(config_utils, 'getConfigFromFile').resolves(true);
		env_mgr.setProperty('clustering_enabled', true);
		process_exit_stub = sandbox.stub(process, 'exit').withArgs(0);
	});
	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
	});

	describe('Test restart function', () => {
		let restart_clustering_stub = sandbox.stub();

		before(() => {
			restart.__set__('restartClustering', restart_clustering_stub);
		});

		it('Test error logged when calling restart from CLI in no-pm2 mode', async () => {
			is_service_reg_stub.resolves(false);
			await restart.restart({});
			expect(console_error_stub.args[0][0]).to.equal(
				'Restart is not available from the CLI when running in non-pm2 mode. Either call restart from the API or stop and start HarperDB.'
			);
		});

		it('Test in PM2 mode restart PM2 is called', async () => {
			is_service_reg_stub.resolves(true);
			const result = await restart.restart({});
			expect(result).to.equal('Restarting HarperDB. This may take up to 60 seconds.');
			expect(restart_clustering_stub.called).to.be.true;
			expect(process_man_restart_stub.args[0][0]).to.equal('HarperDB');
		});
	});

	describe('Test restartService function', () => {
		let restart_clustering_stub = sandbox.stub();
		let reload_clustering_stub;

		before(() => {
			restart.__set__('restartClustering', restart_clustering_stub);
			reload_clustering_stub = sandbox.stub(process_man, 'reloadClustering');
		});

		it('Test clustering service is restarted', async () => {
			const result = await restart.restartService({ service: 'clustering' });
			expect(result).to.equal('Restarting clustering');
			expect(restart_clustering_stub.called).to.be.true;
		});

		it('Test clustering config service restarted', async () => {
			const result = await restart.restartService({ service: 'clustering_config' });
			expect(result).to.equal('Restarting clustering_config');
			expect(reload_clustering_stub.called).to.be.true;
		});

		it('Test http_workers service is restarted', async () => {
			is_service_reg_stub.resolves(false);
			restart.__set__('calledFromCli', false);
			const result = await restart.restartService({ service: 'http_workers' });
			expect(result).to.equal('Restarting http_workers');
			expect(process_man_restart_stub.called).to.be.false;
		});

		it('Test restarting http_workers from CLI error', async () => {
			is_service_reg_stub.resolves(false);
			restart.__set__('calledFromCli', true);
			const result = await restart.restartService({ service: 'http_workers' });
			expect(result).to.equal(
				'Restart http_workers is not available from the CLI when running in non-pm2 mode. Either call restart http_workers from the API or stop and start HarperDB.'
			);
		});

		it('Test unrecognized service error', async () => {
			is_service_reg_stub.resolves(true);
			const result = await restart.restartService({ service: 'clustering leaf' });
			expect(result).to.equal('Unrecognized service: clustering leaf');
		});

		it('Test service validation error', async () => {
			let error;
			try {
				await restart.restartService({ service: 'server' });
			} catch (err) {
				error = err;
			}
			expect(error.message).to.equal('Invalid service');
		});
	});

	describe('Test restartClustering function', () => {
		const restart_clustering = restart.__get__('restartClustering');
		let generate_nats_config_stub;
		let update_local_stream_stub;
		let close_connection_stub;
		let get_hdb_process_stub;
		let start_clustering_process_stub;
		let start_clustering_threads_stub;

		before(() => {
			generate_nats_config_stub = sandbox.stub(nats_config, 'generateNatsConfig');
			update_local_stream_stub = sandbox.stub(nats_utils, 'updateLocalStreams');
			close_connection_stub = sandbox.stub(nats_utils, 'closeConnection');
			get_hdb_process_stub = sandbox.stub(sys_info, 'getHDBProcessInfo').resolves({ clustering: [{ pid: 12345 }] });
			start_clustering_process_stub = sandbox.stub(process_man, 'startClusteringProcesses');
			start_clustering_threads_stub = sandbox.stub(process_man, 'startClusteringThreads');
		});

		beforeEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			sandbox.restore();
		});

		it('Test clustering restart PM2 mode happy path ', async () => {
			sandbox.resetHistory();
			restart.__set__('pm2Mode', true);
			await restart_clustering();
			expect(generate_nats_config_stub.called).to.be.true;
			expect(process_man_restart_stub.getCall(0).args[0]).to.equal('Clustering Hub');
			expect(process_man_restart_stub.getCall(1).args[0]).to.equal('Clustering Leaf');
			expect(remove_nats_config_stub.getCall(0).args[0]).to.equal('Clustering Hub');
			expect(remove_nats_config_stub.getCall(1).args[0]).to.equal('Clustering Leaf');
			expect(update_local_stream_stub.called).to.be.true;
			expect(restart_workers_stub.called);
		}).timeout(10000);

		it('Test clustering restart non-PM2 mode happy path ', async () => {
			let process_kill_stub = sandbox.stub(process, 'kill');
			sandbox.resetHistory();
			restart.__set__('pm2Mode', false);
			await restart_clustering();
			process_kill_stub.restore();
			expect(generate_nats_config_stub.called).to.be.true;
			expect(process_kill_stub.args[0][0]).to.equal(12345);
			expect(remove_nats_config_stub.getCall(0).args[0]).to.equal('Clustering Hub');
			expect(remove_nats_config_stub.getCall(1).args[0]).to.equal('Clustering Leaf');
			expect(update_local_stream_stub.called).to.be.true;
			expect(restart_workers_stub.called);
		}).timeout(10000);

		it('Test clustering is started if not running', async () => {
			get_hdb_process_stub.resolves({ clustering: [] });
			await restart_clustering();
			expect(start_clustering_process_stub.called).to.be.true;
			expect(start_clustering_threads_stub.called).to.be.true;
		});
	});
});
