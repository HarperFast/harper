'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const fs = require('fs-extra');
const env_mgr = require('../../utility/environment/environmentManager');
const sys_info = require('../../utility/environment/systemInformation');
const hdb_terms = require('../../utility/hdbTerms');
const nats_utils = require('../../server/nats/utility/natsUtils');
const user = require('../../security/user');
const cluster_status = require('../../utility/clustering/clusterStatus');
const run = require('../../bin/run');
const status = rewire('../../bin/status');

describe('Test status module', () => {
	const sandbox = sinon.createSandbox();
	let console_log_stub;
	let read_file_stub;
	let get_hdb_process_info_stub;
	let get_server_config_stub;
	const fake_network = {
		nodes: [
			{
				name: 'local',
				response_time: 8,
				connected_nodes: ['ec2-3-14-144-240'],
				routes: [
					{
						host: '3.14.144.240',
						port: 12345,
					},
				],
			},
			{
				name: 'ec2-3-14-144-240',
				response_time: 43,
				connected_nodes: ['local', 'ec2-18-216-178-34', 'ec2-3-133-121-113'],
				routes: [],
			},
		],
	};

	const fake_cluster_status = {
		node_name: 'local',
		is_enabled: true,
		connections: [
			{
				node_name: 'ec2-18-216-178-34',
				status: 'NoResponders',
				ports: {},
				subscriptions: [
					{
						schema: 'four',
						table: 'frog',
						publish: true,
						subscribe: true,
					},
				],
			},
			{
				node_name: 'ec2-3-14-144-240',
				status: 'open',
				ports: {
					clustering: 12345,
					operations_api: 9925,
				},
				latency_ms: 108,
				uptime: '18h 18m 3s',
				subscriptions: [
					{
						schema: 'four',
						table: 'frog',
						publish: true,
						subscribe: true,
					},
					{
						schema: 'four',
						table: 'bird',
						publish: true,
						subscribe: true,
					},
				],
				system_info: {
					hdb_version: '4.1.1',
					node_version: '18.15.0',
					platform: 'linux',
				},
			},
		],
	};
	const fake_hdb_process_info = {
		core: [
			{
				pid: 62076,
			},
			{
				pid: 55297,
			},
		],
		clustering: [
			{
				pid: 55319,
			},
			{
				pid: 55318,
			},
		],
	};
	const network_stub = sandbox.stub().resolves(fake_network);

	const fake_nats_connection = {
		close: () => {},
	};

	before(() => {
		console_log_stub = sandbox.stub(console, 'log');
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.ROOTPATH, 'unit-test');
		read_file_stub = sandbox.stub(fs, 'readFile').resolves('62076');
		get_hdb_process_info_stub = sandbox.stub(sys_info, 'getHDBProcessInfo').resolves(fake_hdb_process_info);
		get_server_config_stub = sandbox.stub(nats_utils, 'getServerConfig').returns({ port: 1234 });
		sandbox.stub(user, 'getClusterUser').resolves({ username: 'unit-t-user', decrypt_hash: '123nifoh24' });
		sandbox.stub(nats_utils, 'createConnection').resolves(fake_nats_connection);
		status.__set__('cluster_network', network_stub);
		sandbox.stub(cluster_status, 'clusterStatus').resolves(fake_cluster_status);
		sandbox.stub(nats_utils, 'closeConnection').resolves();
		sandbox.stub(run, 'isHdbInstalled').resolves(true);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test status is returned as expected', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');
		await status();
		process_exit_stub.restore();
		expect(console_log_stub.args[0][0]).to.eql(
			'harperdb:\n  status: running\n  pid: 62076\nclustering:\n  hub server:\n    status: running\n    pid: 62076\n  leaf server:\n    status: running\n    pid: 62076\n  network:\n    - name: local\n      response time: 8\n      connected nodes:\n        - ec2-3-14-144-240\n      routes:\n        - host: 3.14.144.240\n          port: 12345\n    - name: ec2-3-14-144-240\n      response time: 43\n      connected nodes:\n        - local\n        - ec2-18-216-178-34\n        - ec2-3-133-121-113\n      routes: []\n  replication:\n    node name: local\n    is enabled: true\n    connections:\n      - node name: ec2-18-216-178-34\n        status: NoResponders\n        ports: {}\n        subscriptions:\n          - schema: four\n            table: frog\n            publish: true\n            subscribe: true\n        system info: {}\n      - node name: ec2-3-14-144-240\n        status: open\n        ports:\n          clustering: 12345\n          operations api: 9925\n        latency ms: 108\n        uptime: 18h 18m 3s\n        subscriptions:\n          - schema: four\n            table: frog\n            publish: true\n            subscribe: true\n          - schema: four\n            table: bird\n            publish: true\n            subscribe: true\n        system info:\n          hdb version: 4.1.1\n          node version: 18.15.0\n          platform: linux\n'
		);
	});

	it('Test status when nothing is running', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');
		get_hdb_process_info_stub.resolves({ core: [], clustering: [] });
		await status();
		process_exit_stub.restore();
		expect(console_log_stub.args[0][0]).to.eql(
			'harperdb:\n  status: stopped\nclustering:\n  hub server:\n    status: stopped\n  leaf server:\n    status: stopped\n'
		);
	});
});
