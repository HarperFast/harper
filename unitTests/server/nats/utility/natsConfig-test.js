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
const config_utils = require('../../../../config/configUtils');
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
const FAKE_ROUTES = {
	hub_routes: [
		{
			host: '3.3.3.3',
			port: 7716,
		},
		{
			host: '4.4.4.4',
			port: 7717,
		},
	],
	leaf_routes: [],
};
const FAKE_CERT_PATH = path.join(TEMP_TEST_ROOT_DIR, 'keys', 'certificate.pem');
const FAKE_CA_PATH = path.join(TEMP_TEST_ROOT_DIR, 'keys', 'ca.pem');
const FAKE_PRIVATE_KEY_PATH = path.join(TEMP_TEST_ROOT_DIR, 'keys', 'privateKey.pem');

describe.skip('Test natsConfig module', () => {
	const sandbox = sinon.createSandbox();
	const init_sync_stub = sandbox.stub();
	let list_users_stub;
	let port_taken_stub;
	let create_connection_stub;
	let get_clustering_routes_stub;
	let get_config_from_file_stub;

	before(() => {
		fs.mkdirpSync(TEMP_TEST_ROOT_DIR);
		fs.mkdirpSync(TEMP_TEST_CLUSTERING_DIR);
		natsConfig.__set__('envManager.initSync', init_sync_stub);
		list_users_stub = sandbox.stub(user, 'listUsers').resolves(FAKE_USER_LIST);
		port_taken_stub = sandbox.stub(hdb_utils, 'isPortTaken').resolves(false);
		get_clustering_routes_stub = sandbox.stub(config_utils, 'getClusteringRoutes').returns(FAKE_ROUTES);
		sandbox.stub(user, 'getClusterUser').resolves(fake_cluster_user);
		sandbox.stub(nats_utils, 'checkNATSServerInstalled').resolves(true);
		sandbox.stub(nats_utils, 'getServerConfig').returns(FAKE_SERVER_CONFIG);
		get_config_from_file_stub = sandbox.stub(config_utils, 'getConfigFromFile');
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_USER).returns(FAKE_CLUSTER_USER1);
		create_connection_stub = sandbox.stub(nats_utils, 'createConnection').onCall(0).throws('Connection error');
		create_connection_stub.onCall(1).resolves(FAKE_CONNECTION_RESPONSE);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.ROOTPATH, TEMP_TEST_ROOT_DIR);
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT).returns(7711);
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME).returns('unitTestNodeName');
		get_config_from_file_stub
			.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT)
			.returns(7712);
		get_config_from_file_stub
			.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME)
			.returns('harperdb_unit_test');
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT).returns(7713);
		get_config_from_file_stub
			.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT)
			.returns(7714);
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT).returns(7715);
		get_config_from_file_stub
			.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES)
			.returns(FAKE_ROUTES);
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH).returns(FAKE_CA_PATH);
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE).returns(FAKE_CERT_PATH);
		get_config_from_file_stub
			.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY)
			.returns(FAKE_PRIVATE_KEY_PATH);
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_INSECURE).returns(true);
		get_config_from_file_stub
			.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_PATH)
			.returns(path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf'));
		get_config_from_file_stub.withArgs(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_VERIFY).returns(true);
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
		const test_cert_file_path = path.join(TEMP_TEST_ROOT_DIR, 'keys', 'certificate.pem');
		const test_ca_file_path = path.join(TEMP_TEST_ROOT_DIR, 'keys', 'ca.pem');
		const test_key_file_path = path.join(TEMP_TEST_ROOT_DIR, 'keys', 'privateKey.pem');

		const expected_hub_json = {
			port: 7711,
			server_name: 'unitTestNodeName-hub',
			pid_file: path.join(TEMP_TEST_CLUSTERING_DIR, 'hub.pid'),
			max_payload: 10000000,
			jetstream: {
				enabled: false,
			},
			tls: {
				cert_file: test_cert_file_path,
				key_file: test_key_file_path,
				ca_file: test_ca_file_path,
				insecure: true,
				verify: true,
			},
			leafnodes: {
				port: 7714,
				tls: {
					cert_file: test_cert_file_path,
					key_file: test_key_file_path,
					ca_file: test_ca_file_path,
					insecure: true,
				},
			},
			cluster: {
				name: 'harperdb_unit_test',
				port: 7713,
				routes: [
					'tls://name%25day-2123ncv%234-admin:how%25day-2123ncv%234@3.3.3.3:7716',
					'tls://name%25day-2123ncv%234-admin:how%25day-2123ncv%234@4.4.4.4:7717',
				],
				tls: {
					cert_file: test_cert_file_path,
					key_file: test_key_file_path,
					ca_file: test_ca_file_path,
					insecure: true,
					verify: true,
				},
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
				},
			},
			system_account: 'SYS',
		};

		const expected_leaf_json = {
			port: 7715,
			server_name: 'unitTestNodeName-leaf',
			pid_file: path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf.pid'),
			max_payload: 10000000,
			jetstream: {
				enabled: true,
				store_dir: path.join(TEMP_TEST_CLUSTERING_DIR, 'leaf'),
				domain: 'unitTestNodeName-leaf',
			},
			tls: {
				cert_file: test_cert_file_path,
				key_file: test_key_file_path,
				ca_file: test_ca_file_path,
				insecure: true,
			},
			leafnodes: {
				remotes: [
					{
						tls: {
							ca_file: test_ca_file_path,
							insecure: true,
						},
						urls: ['tls://name%25day-2123ncv%234-admin:how%25day-2123ncv%234@0.0.0.0:7714'],
						account: 'SYS',
					},
					{
						tls: {
							ca_file: test_ca_file_path,
							insecure: true,
						},
						urls: ['tls://name%25day-2123ncv%234:how%25day-2123ncv%234@0.0.0.0:7714'],
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
