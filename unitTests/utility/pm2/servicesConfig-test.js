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
const BYTENODE_MOD_CLI = path.resolve(__dirname, '../../../node_modules/bytenode/lib/cli.js');
const LAUNCH_SCRIPTS_DIR = path.resolve(__dirname, '../../../launchServiceScripts');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../utility/scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdb_terms.HDB_RESTART_SCRIPT);
const NATS_SERVER_BINARY_PATH = path.resolve(__dirname, '../../../dependencies', 'nats-server');

let LOG_PATH;

describe('Test pm2 servicesConfig module', () => {
	const sandbox = sinon.createSandbox();
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

	it('Test result from generateNatsHubServerConfig function is correct', () => {
		const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT);
		const hub_config_path = path.join(hdb_root, 'clustering', 'hub.json');
		const expected_result = {
			name: 'Clustering Hub',
			script: `${NATS_SERVER_BINARY_PATH} -c ${hub_config_path}`,
			exec_mode: 'fork',
			env: {
				PROCESS_NAME: 'Clustering Hub',
			},
			merge_logs: true,
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_HUB),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_HUB),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING_HUB,
		};
		const result = services_config.generateNatsHubServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateNatsLeafServerConfig function is correct', () => {
		const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT);
		const leaf_config_path = path.join(hdb_root, 'clustering', 'leaf.json');
		const expected_result = {
			name: 'Clustering Leaf',
			script: `${NATS_SERVER_BINARY_PATH} -c ${leaf_config_path}`,
			exec_mode: 'fork',
			env: {
				PROCESS_NAME: 'Clustering Leaf',
			},
			merge_logs: true,
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_LEAF),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_LEAF),
			instances: 1,
			cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING_LEAF,
		};
		const result = services_config.generateNatsLeafServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateNatsIngestServiceConfig is correct', () => {
		const expected_result = {
			name: 'Clustering Ingest Service',
			script: path.join(LAUNCH_SCRIPTS_DIR, 'launchNatsIngestService.js'),
			exec_mode: 'cluster',
			env: {
				PROCESS_NAME: 'Clustering Ingest Service',
			},
			merge_logs: true,
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_INGEST_SERVICE),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_INGEST_SERVICE),
			instances: 1,
			cwd: LAUNCH_SCRIPTS_DIR,
		};
		const result = services_config.generateNatsIngestServiceConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateNatsReplyServiceConfig is correct', () => {
		const expected_result = {
			name: 'Clustering Reply Service',
			script: path.join(LAUNCH_SCRIPTS_DIR, 'launchNatsReplyService.js'),
			exec_mode: 'cluster',
			env: {
				PROCESS_NAME: 'Clustering Reply Service',
			},
			merge_logs: true,
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_REPLY_SERVICE),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_REPLY_SERVICE),
			instances: 1,
			cwd: LAUNCH_SCRIPTS_DIR,
		};
		const result = services_config.generateNatsReplyServiceConfig();
		expect(result).to.eql(expected_result);
	});
});
