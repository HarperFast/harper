'use strict';

const chai = require('chai');
const sinon = require('sinon');
const path = require('path');
const os = require('os');
const rewire = require('rewire');
const { expect } = chai;
const hdb_license = require('../../../utility/registration/hdb_license');
const env_mangr = require('../../../utility/environment/environmentManager');
const services_config = rewire('../../../utility/pm2/servicesConfig');
const hdb_terms = require('../../../utility/hdbTerms');
const env = require('../../../utility/environment/environmentManager');
const BYTENODE_MOD_CLI = path.resolve(__dirname, '../../../node_modules/bytenode/cli.js');
const LAUNCH_SCRIPTS_DIR = path.resolve(__dirname, '../../../launchServiceScripts');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../utility/scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdb_terms.HDB_RESTART_SCRIPT);

let LOG_PATH;

describe('Test pm2 servicesConfig module', () => {
	const sandbox = sinon.createSandbox();
	// const getInstanceCount = services_config.__get__('getInstanceCount');
	let os_cpus_stub;

	before(() => {
		os_cpus_stub = sandbox.stub(os, 'cpus').returns([1, 2, 3, 4, 5, 6]);
		sandbox.stub(hdb_license, 'licenseSearch').returns({ ram_allocation: 512 });
		env_mangr.initTestEnvironment();
		LOG_PATH = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	});

	after(() => {
		sandbox.restore();
		process.env.HDB_COMPILED = 'false';
	});

	it('Test result from generateIPCServerConfig function is correct for non compiled', () => {
		process.env.HDB_COMPILED = 'false';
		const expected_result = {
			name: 'IPC',
			script: hdb_terms.SERVICE_SERVERS.IPC,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.IPC),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.IPC),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.IPC,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.IPC,
			},
		};
		const result = services_config.generateIPCServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateIPCServerConfig function is correct for compiled', () => {
		process.env.HDB_COMPILED = 'true';
		const expected_result = {
			name: 'IPC',
			script: BYTENODE_MOD_CLI,
			args: hdb_terms.SERVICE_SERVERS.IPC,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.IPC),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.IPC),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.IPC,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.IPC,
			},
		};
		const result = services_config.generateIPCServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateClusteringConnectorConfig function is correct non compiled', () => {
		process.env.HDB_COMPILED = 'false';
		const expected_result = {
			name: 'Clustering Connector',
			script: hdb_terms.SERVICE_SERVERS.CLUSTERING_CONNECTOR,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_CONNECTOR),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_CONNECTOR),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_CONNECTOR,
			},
		};
		const result = services_config.generateClusteringConnectorConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateClusteringConnectorConfig function is correct compiled', () => {
		process.env.HDB_COMPILED = 'true';
		const expected_result = {
			name: 'Clustering Connector',
			script: BYTENODE_MOD_CLI,
			args: hdb_terms.SERVICE_SERVERS.CLUSTERING_CONNECTOR,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_CONNECTOR),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_CONNECTOR),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_CONNECTOR,
			},
		};
		const result = services_config.generateClusteringConnectorConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateClusteringServerConfig function is correct non compiled', () => {
		process.env.HDB_COMPILED = 'false';
		const expected_result = {
			name: 'Clustering',
			script: hdb_terms.SERVICE_SERVERS.CLUSTERING,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING,
			},
		};
		const result = services_config.generateClusteringServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateClusteringServerConfig function is correct compiled', () => {
		process.env.HDB_COMPILED = 'true';
		const expected_result = {
			name: 'Clustering',
			script: BYTENODE_MOD_CLI,
			args: hdb_terms.SERVICE_SERVERS.CLUSTERING,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING,
			},
		};
		const result = services_config.generateClusteringServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateHDBServerConfig function is correct non compiled', () => {
		process.env.HDB_COMPILED = 'false';
		const expected_result = {
			exec_mode: 'cluster',
			instances: 4,
			name: 'HarperDB',
			node_args: '--max-old-space-size=512',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.HDB),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.HDB),
			script: path.join(LAUNCH_SCRIPTS_DIR, 'launchHarperDB.js'),
			cwd: LAUNCH_SCRIPTS_DIR,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.HDB,
			},
		};
		const result = services_config.generateHDBServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateCFServerConfig function is correct non compiled', () => {
		process.env.HDB_COMPILED = 'false';
		const expected_result = {
			exec_mode: 'cluster',
			instances: 2,
			name: 'Custom Functions',
			node_args: '--max-old-space-size=512',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CUSTOM_FUNCTIONS),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CUSTOM_FUNCTIONS),
			script: path.join(LAUNCH_SCRIPTS_DIR, 'launchCustomFunctions.js'),
			cwd: LAUNCH_SCRIPTS_DIR,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS,
			},
		};
		const result = services_config.generateCFServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateRestart function is correct non compiled', () => {
		process.env.HDB_COMPILED = 'false';
		const expected_result = {
			name: 'Restart HDB',
			script: RESTART_SCRIPT,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.PM2),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.PM2),
			instances: 1,
			cwd: SCRIPTS_DIR,
			autorestart: false,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB,
			},
		};
		const result = services_config.generateRestart();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateRestart function is correct compiled', () => {
		process.env.HDB_COMPILED = 'true';
		const expected_result = {
			name: 'Restart HDB',
			script: BYTENODE_MOD_CLI,
			args: RESTART_SCRIPT,
			exec_mode: 'fork',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.PM2),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.PM2),
			instances: 1,
			cwd: SCRIPTS_DIR,
			autorestart: false,
			merge_logs: true,
			env: {
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB,
			},
		};
		const result = services_config.generateRestart();
		expect(result).to.eql(expected_result);
	});
});
