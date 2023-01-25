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
const { PACKAGE_ROOT } = require('../../../utility/hdbTerms');
const LAUNCH_SCRIPTS_DIR = path.resolve(__dirname, '../../../launchServiceScripts');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../utility/scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdb_terms.HDB_RESTART_SCRIPT);
const platform_arch = `${process.platform}-${process.arch}`;
const binary_name = process.platform === 'win32' ? 'nats-server.exe' : 'nats-server';
const NATS_SERVER_BINARY_PATH = path.resolve(__dirname, '../../../dependencies', platform_arch, binary_name);

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
	});

	it('Test result from generateMainServerConfig function is correct non compiled', () => {
		const expected_result = {
			exec_mode: 'fork',
			name: 'HarperDB',
			node_args: '--max-old-space-size=512',
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.HDB),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.HDB),
			script: 'bin/harperdb.js',
			cwd: PACKAGE_ROOT,
			merge_logs: true,
			env: {
				IS_SCRIPTED_SERVICE: true,
				PROCESS_NAME: hdb_terms.PROCESS_DESCRIPTORS.HDB,
			},
		};
		const result = services_config.generateMainServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateRestart function is correct non compiled', () => {
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

	it('Test result from generateNatsHubServerConfig function is correct', () => {
		const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
		const hub_config_path = path.join(hdb_root, 'clustering', 'hub.json');
		const expected_result = {
			name: 'Clustering Hub',
			script: NATS_SERVER_BINARY_PATH,
			args: `-c ${hub_config_path}`,
			exec_mode: 'fork',
			env: {
				PROCESS_NAME: 'Clustering Hub',
			},
			merge_logs: true,
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_HUB),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_HUB),
			instances: 1,
		};
		const result = services_config.generateNatsHubServerConfig();
		expect(result).to.eql(expected_result);
	});

	it('Test result from generateNatsLeafServerConfig function is correct', () => {
		const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
		const leaf_config_path = path.join(hdb_root, 'clustering', 'leaf.json');
		const expected_result = {
			name: 'Clustering Leaf-9991',
			script: NATS_SERVER_BINARY_PATH,
			args: `-c ${leaf_config_path}`,
			exec_mode: 'fork',
			env: {
				PROCESS_NAME: 'Clustering Leaf',
			},
			merge_logs: true,
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_LEAF),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_LEAF),
			instances: 1,
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

	it('Test result from generateClusteringUpgradeV4ServiceConfig is correct', () => {
		const expected_result = {
			name: 'Upgrade-4-0-0',
			script: path.join(LAUNCH_SCRIPTS_DIR, 'launchUpdateNodes4-0-0.js'),
			exec_mode: 'fork',
			env: {
				PROCESS_NAME: 'Upgrade-4-0-0',
			},
			merge_logs: true,
			out_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_UPGRADE),
			error_file: path.join(LOG_PATH, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_UPGRADE),
			instances: 1,
			cwd: LAUNCH_SCRIPTS_DIR,
			autorestart: false,
		};
		const result = services_config.generateClusteringUpgradeV4ServiceConfig();
		expect(result).to.eql(expected_result);
	});
});
