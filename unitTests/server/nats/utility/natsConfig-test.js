'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const fs = require('fs-extra');
const path = require('path');
const rewire = require('rewire');
const user = require('../../../../security/user');
const env_manager = require('../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const nats_utils = require('../../../../server/nats/utility/natsUtils');
const crypto_hash = require('../../../../security/cryptoHash');
const natsConfig = rewire('../../../../server/nats/utility/natsConfig');

const TEMP_TEST_ROOT_DIR = path.join(__dirname, 'natsConfigTest');
const TEMP_TEST_CLUSTERING_DIR = path.join(TEMP_TEST_ROOT_DIR, 'clustering');
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
	[
		'clusterUser2',
		{
			active: true,
			hash: crypto_hash.encrypt('blahash2'),
			password: 'somepass',
			role: {
				id: '58aa0e11-b761-4ade-8a7d-e9123',
				permission: {
					cluster_user: true,
				},
				role: 'cluster_user',
			},
			username: 'clusterUser2',
		},
	],
	[
		'su_1',
		{
			active: true,
			password: 'somepass',
			role: {
				id: '08fec166-bbfb-4822-ab3d-9cb4baeff86f',
				permission: {
					super_user: true,
				},
				role: 'super_user',
			},
			username: 'su_1',
		},
	],
	[
		'nonsu_1',
		{
			active: true,
			password: 'somepass',
			role: {
				id: '123a0e11-b761-4ade-8a7d-e90f1d99d246',
				permission: {
					super_user: false,
				},
				role: 'nonsu_role',
			},
			username: 'nonsu_1',
		},
	],
]);

const fake_cluster_user = FAKE_USER_LIST.get(FAKE_CLUSTER_USER1);
fake_cluster_user.decrypt_hash = 'blahbblah';
fake_cluster_user.uri_encoded_d_hash = 'how%25day-2123ncv%234';
fake_cluster_user.uri_encoded_name = 'name%25day-2123ncv%234';
fake_cluster_user.sys_name = fake_cluster_user.username + '-admin';
fake_cluster_user.sys_name_encoded = fake_cluster_user.uri_encoded_name + '-admin';

const FAKE_SERVER_CONFIG = {
	port: 7712,
	config_file: 'leaf.json',
};

const FAKE_CONNECTION_RESPONSE = { protocol: { connected: true }, close: () => {} };

describe('Test natsConfig module', () => {
	const sandbox = sinon.createSandbox();
	const init_sync_stub = sandbox.stub();
	let list_users_stub;
	let port_taken_stub;
	let create_connection_stub;

	before(() => {
		fs.mkdirpSync(TEMP_TEST_ROOT_DIR);
		fs.mkdirpSync(TEMP_TEST_CLUSTERING_DIR);
		natsConfig.__set__('env_manager.initSync', init_sync_stub);
		list_users_stub = sandbox.stub(user, 'listUsers').resolves(FAKE_USER_LIST);
		port_taken_stub = sandbox.stub(hdb_utils, 'isPortTaken').resolves(false);
		sandbox.stub(user, 'getClusterUser').resolves(fake_cluster_user);
		sandbox.stub(nats_utils, 'checkNATSServerInstalled').resolves(true);
		sandbox.stub(nats_utils, 'getServerConfig').returns(FAKE_SERVER_CONFIG);
		create_connection_stub = sandbox.stub(nats_utils, 'createConnection').onCall(0).throws('Connection error');
		create_connection_stub.onCall(1).resolves(FAKE_CONNECTION_RESPONSE);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT, TEMP_TEST_ROOT_DIR);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_USER, FAKE_CLUSTER_USER1);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT, 7711);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME, 'unitTestNodeName');
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT, 7712);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME, 'harperdb_unit_test');
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT, 7713);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT, 7714);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT, 7715);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES, [
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

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		fs.removeSync(TEMP_TEST_ROOT_DIR);
		sandbox.restore();
		rewire('../../../../server/nats/utility/natsConfig');
	});

	it('Test valid hub.json and leaf.json config files are created', async () => {
		await natsConfig.generateNatsConfig();

		const expected_hub_json = {
			accounts: {
				HDB: {
					users: [
						{
							password: 'blahbblah',
							user: 'clusterUser1',
						},
						{
							password: 'blahash2',
							user: 'clusterUser2',
						},
					],
				},
				SYS: {
					users: [
						{
							password: 'blahbblah',
							user: 'clusterUser1-admin',
						},
						{
							password: 'blahash2',
							user: 'clusterUser2-admin',
						},
					],
				},
			},
			cluster: {
				name: 'harperdb_unit_test',
				port: 7713,
				routes: [
					'nats-route://name%25day-2123ncv%234-admin:how%25day-2123ncv%234@3.3.3.3:7716',
					'nats-route://name%25day-2123ncv%234-admin:how%25day-2123ncv%234@4.4.4.4:7717',
				],
			},
			jetstream: {
				enabled: false,
			},
			leafnodes: {
				port: 7714,
			},
			pid_file: path.join(TEMP_TEST_CLUSTERING_DIR, 'hub.pid'),
			port: 7711,
			server_name: 'unitTestNodeName-hub',
			system_account: 'SYS',
		};

		const expected_leaf_json = {
			port: 7715,
			server_name: 'unitTestNodeName-leaf',
			pid_file: path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf.pid'),
			jetstream: {
				enabled: true,
				store_dir: path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf'),
				domain: 'unitTestNodeName-leaf',
			},
			leafnodes: {
				remotes: [
					{
						urls: ['nats-leaf://name%25day-2123ncv%234-admin:how%25day-2123ncv%234@0.0.0.0:7714'],
						account: 'SYS',
					},
					{
						urls: ['nats-leaf://name%25day-2123ncv%234:how%25day-2123ncv%234@0.0.0.0:7714'],
						account: 'HDB',
					},
				],
			},
			accounts: {
				SYS: {
					users: [
						{
							user: 'clusterUser1-admin',
							password: 'blahbblah',
						},
						{
							user: 'clusterUser2-admin',
							password: 'blahash2',
						},
					],
				},
				HDB: {
					users: [
						{
							user: 'clusterUser1',
							password: 'blahbblah',
						},
						{
							user: 'clusterUser2',
							password: 'blahash2',
						},
					],
					jetstream: 'enabled',
				},
			},
			system_account: 'SYS',
		};

		const hub_config = await fs.readJson(path.join(TEMP_TEST_CLUSTERING_DIR, 'hub.json'));
		expect(hub_config).to.eql(expected_hub_json, 'Generated Nats HUB config does not match the expected value');

		const leaf_config = await fs.readJson(path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf.json'));
		expect(leaf_config).to.eql(expected_leaf_json, 'Generated Nats LEAF config does not match the expected value');
	});

	it('Test removeNatsConfig removes the nats config once the connection is connected', async () => {
		const fs_extra_sandbox = sinon.createSandbox();
		const write_file_stub = fs_extra_sandbox.stub(fs, 'writeFile');
		const remove_stub = fs_extra_sandbox.stub(fs, 'remove');
		await natsConfig.removeNatsConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
		fs_extra_sandbox.restore();

		expect(create_connection_stub.calledTwice).to.be.true;
		expect(create_connection_stub.args[0]).to.eql([7712, 'clusterUser1', 'blahbblah', false]);
		expect(create_connection_stub.args[1]).to.eql([7712, 'clusterUser1', 'blahbblah', false]);
		expect(write_file_stub.args[0]).to.eql([path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf.json'), '0'.repeat(10000)]);
		expect(remove_stub.args[0]).to.eql([path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf.json')]);
	}).timeout(20000);
});
