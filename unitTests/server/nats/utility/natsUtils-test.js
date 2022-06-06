'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const test_utils = require('../../../test_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const nats_terms = require('../../../../server/nats/utility/natsTerms');
const env_manager = require('../../../../utility/environment/environmentManager');
const nats_utils = rewire('../../../../server/nats/utility/natsUtils');
const hdb_logger = require('../../../../utility/logging/harper_logger');

const TEST_TIMEOUT = 30000;

async function closeDeleteNatsCon() {
	await global.NATSConnection.close();
	delete global.NATSConnection;
}

describe('Test natsUtils module', () => {
	const sandbox = sinon.createSandbox();
	let hdb_warn_log_stub;

	before(() => {
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, true);
		hdb_warn_log_stub = sandbox.stub(hdb_logger, 'warn');
	});

	after(() => {
		sandbox.restore();
		rewire('../../../../server/nats/utility/natsUtils');
	});

	describe('test checkNATSServerInstalled', () => {
		const check_server_sandbox = sinon.createSandbox();
		let check_installed = nats_utils.checkNATSServerInstalled;

		it('test nats-server binary does not exist', async () => {
			let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
				throw Error('ENONT');
			});

			let cmd_stub = check_server_sandbox.stub();
			let semver_stub = check_server_sandbox.spy(nats_utils.__get__('semver'), 'eq');

			let fs_restore = nats_utils.__set__('fs', {
				access: access_stub,
			});
			let cmd_restore = nats_utils.__set__('runCommand', cmd_stub);

			let result = await check_installed();
			expect(result).to.equal(false);
			expect(access_stub.callCount).to.equal(1);
			let expected_err;
			try {
				let rez = await access_stub.returnValues[0];
			} catch (e) {
				expected_err = e;
			}
			expect(expected_err.message).to.equal('ENONT');
			expect(cmd_stub.callCount).to.equal(0);
			expect(semver_stub.callCount).to.equal(0);
			fs_restore();
			cmd_restore();
			check_server_sandbox.restore();
		});

		it('test nats-server binary does exist, wrong version of nats-server', async () => {
			let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
				return;
			});

			let cmd_stub = check_server_sandbox.stub().callsFake(async (cmd, cwd) => {
				return 'nats-server v2.7.0';
			});

			let nats_version_restore = nats_utils.__set__('REQUIRED_NATS_SERVER_VERSION', '2.7.2');

			let fs_restore = nats_utils.__set__('fs', {
				access: access_stub,
			});
			let cmd_restore = nats_utils.__set__('runCommand', cmd_stub);
			let semver_spy = check_server_sandbox.spy(nats_utils.__get__('semver'), 'eq');

			let result = await check_installed();
			expect(result).to.equal(false);
			expect(access_stub.callCount).to.equal(1);
			let expected_err;
			let rez;
			try {
				rez = await access_stub.returnValues[0];
			} catch (e) {
				expected_err = e;
			}
			expect(expected_err).to.equal(undefined);
			expect(rez).to.equal(undefined);
			expect(cmd_stub.callCount).to.equal(1);

			let cmd_result = await cmd_stub.returnValues[0];
			expect(cmd_result).to.equal('nats-server v2.7.0');

			expect(semver_spy.callCount).to.equal(1);
			expect(semver_spy.returnValues[0]).to.equal(false);
			fs_restore();
			cmd_restore();
			nats_version_restore();
			check_server_sandbox.restore();
		});

		it('test nats-server binary does exist, same version of nats-server returned as expected', async () => {
			let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
				return;
			});

			let cmd_stub = check_server_sandbox.stub().callsFake(async (cmd, cwd) => {
				return 'nats-server v2.7.2';
			});

			let nats_version_restore = nats_utils.__set__('REQUIRED_NATS_SERVER_VERSION', '2.7.2');

			let fs_restore = nats_utils.__set__('fs', {
				access: access_stub,
			});
			let cmd_restore = nats_utils.__set__('runCommand', cmd_stub);
			let semver_spy = check_server_sandbox.spy(nats_utils.__get__('semver'), 'eq');

			let result = await check_installed();
			expect(result).to.equal(true);
			expect(access_stub.callCount).to.equal(1);
			let expected_err;
			let rez;
			try {
				rez = await access_stub.returnValues[0];
			} catch (e) {
				expected_err = e;
			}
			expect(expected_err).to.equal(undefined);
			expect(rez).to.equal(undefined);
			expect(cmd_stub.callCount).to.equal(1);

			let cmd_result = await cmd_stub.returnValues[0];
			expect(cmd_result).to.equal('nats-server v2.7.2');

			expect(semver_spy.callCount).to.equal(1);
			expect(semver_spy.returnValues[0]).to.equal(true);
			fs_restore();
			cmd_restore();
			nats_version_restore();
			check_server_sandbox.restore();
		});

		it('test nats-server binary does exist, greater version of nats-server returned as expected', async () => {
			let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
				return;
			});

			let cmd_stub = check_server_sandbox.stub().callsFake(async (cmd, cwd) => {
				return 'nats-server v2.7.3';
			});

			let nats_version_restore = nats_utils.__set__('REQUIRED_NATS_SERVER_VERSION', '2.7.2');

			let fs_restore = nats_utils.__set__('fs', {
				access: access_stub,
			});
			let cmd_restore = nats_utils.__set__('runCommand', cmd_stub);
			let semver_spy = check_server_sandbox.spy(nats_utils.__get__('semver'), 'eq');

			let result = await check_installed();
			expect(result).to.equal(false);
			expect(access_stub.callCount).to.equal(1);
			let expected_err;
			let rez;
			try {
				rez = await access_stub.returnValues[0];
			} catch (e) {
				expected_err = e;
			}
			expect(expected_err).to.equal(undefined);
			expect(rez).to.equal(undefined);
			expect(cmd_stub.callCount).to.equal(1);

			let cmd_result = await cmd_stub.returnValues[0];
			expect(cmd_result).to.equal('nats-server v2.7.3');

			expect(semver_spy.callCount).to.equal(1);
			expect(semver_spy.returnValues[0]).to.equal(false);
			fs_restore();
			cmd_restore();
			nats_version_restore();
			check_server_sandbox.restore();
		});
	});

	describe('test runCommand function', () => {
		const run_command_sandbox = sinon.createSandbox();
		let run_command = nats_utils.runCommand;

		it('test function, with error', async () => {
			let exec_stub = run_command_sandbox.stub().callsFake(async (cmd, opts) => {
				return { stderr: 'this is bad\n' };
			});

			let exec_restore = nats_utils.__set__('exec', exec_stub);

			let error;
			try {
				await run_command('cool command');
			} catch (e) {
				error = e;
			}

			expect(error.message).to.equal('this is bad');
			expect(exec_stub.callCount).to.equal(1);
			expect(exec_stub.firstCall.args).to.eql(['cool command', { cwd: undefined }]);

			exec_restore();
			run_command_sandbox.restore();
		});

		it('test function, without error', async () => {
			let exec_stub = run_command_sandbox.stub().callsFake(async (cmd, opts) => {
				return { stdout: 'all good\n' };
			});

			let exec_restore = nats_utils.__set__('exec', exec_stub);

			let error;
			let result;
			try {
				result = await run_command('cool command', '/tmp/nats-server-2.7.1/');
			} catch (e) {
				error = e;
			}

			expect(error).to.equal(undefined);
			expect(result).to.equal('all good');
			expect(exec_stub.callCount).to.equal(1);
			expect(exec_stub.firstCall.args).to.eql(['cool command', { cwd: '/tmp/nats-server-2.7.1/' }]);

			exec_restore();
			run_command_sandbox.restore();
		});
	});

	describe('Test util functions that depend on leaf server', () => {
		const test_cluster_user = test_utils.NATS_TEST_SERVER_VALUES.CLUSTER_USER;
		const test_cluster_user_pass = test_utils.NATS_TEST_SERVER_VALUES.CLUSTER_USER_PASS;

		before(async () => {
			await test_utils.launchTestLeafServer();
			test_utils.setFakeClusterUser();
		});

		after(async () => {
			test_utils.unsetFakeClusterUser();
			await test_utils.stopTestLeafServer();
		});

		it('Test createConnection connects to a leaf server', async () => {
			const connection = await nats_utils.createConnection(9991, test_cluster_user, test_cluster_user_pass, true);
			expect(connection).to.haveOwnProperty('options');
			expect(connection).to.haveOwnProperty('protocol');
			expect(connection).to.haveOwnProperty('listeners');
			expect(connection.protocol.connected).to.be.true;
			await connection.close();
		}).timeout(TEST_TIMEOUT);

		it('Test getConnection creates a connection and sets it to global', async () => {
			global.NATSConnection = undefined;
			env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT, 9991);
			await nats_utils.getConnection();

			expect(global.NATSConnection).to.haveOwnProperty('options');
			expect(global.NATSConnection).to.haveOwnProperty('protocol');
			expect(global.NATSConnection).to.haveOwnProperty('listeners');
			expect(global.NATSConnection.protocol.connected).to.be.true;
			await closeDeleteNatsCon();
		}).timeout(TEST_TIMEOUT);

		it('Test getJetStreamManager returns JetStream manager', async () => {
			await nats_utils.getConnection();
			const result = await nats_utils.getJetStreamManager();
			expect(result).to.haveOwnProperty('nc');
			expect(result).to.haveOwnProperty('opts');
			expect(result).to.haveOwnProperty('jc');
			expect(result).to.haveOwnProperty('streams');
			expect(result).to.haveOwnProperty('consumers');
			await closeDeleteNatsCon();
		}).timeout(TEST_TIMEOUT);

		it('Test getJetStreamManager throws error if nats connection undefined', async () => {
			await test_utils.assertErrorAsync(
				nats_utils.getJetStreamManager,
				[],
				new Error('NATSConnection global var is undefined. Unable to get JetStream manager.')
			);
		});

		it('Test getJetStream returns JetStream client', async () => {
			await nats_utils.getConnection();
			const result = await nats_utils.getJetStream();
			expect(result).to.haveOwnProperty('nc');
			expect(result).to.haveOwnProperty('opts');
			expect(result).to.haveOwnProperty('jc');
			expect(result).to.haveOwnProperty('api');
			await closeDeleteNatsCon();
		}).timeout(TEST_TIMEOUT);

		it('Test getNATSReferences calls getConnection and the JetStream functions', async () => {
			const result = await nats_utils.getNATSReferences();
			expect(result.connection.constructor.name).to.equal('NatsConnectionImpl');
			expect(result.jsm.constructor.name).to.equal('JetStreamManagerImpl');
			expect(result.js.constructor.name).to.equal('JetStreamClientImpl');
			await closeDeleteNatsCon();
		}).timeout(TEST_TIMEOUT);

		it('Test getServerList returns a list with the test server in it', async () => {
			const result = await nats_utils.getServerList();
			expect(result[0].server.name).to.equal('testLeafServer-leaf');
		}).timeout(TEST_TIMEOUT);

		it('Test createLocalStream creates a stream', async () => {
			await nats_utils.createLocalStream('dev_dog', ['dev.dog.testLeafServer-leaf']);
			const all_streams = await nats_utils.listStreams();
			let stream_found = false;
			for (const stream of all_streams) {
				if (stream.config.name === 'dev_dog') {
					stream_found = true;
					break;
				}
			}
			expect(stream_found, 'createLocalStream failed to create a stream').to.be.true;
			await nats_utils.deleteLocalStream('dev_dog');
		}).timeout(TEST_TIMEOUT);

		it('Test listStreams returns a list of streams', async () => {
			await nats_utils.createLocalStream('dev_dog', ['dev.dog.testLeafServer-leaf']);
			await nats_utils.createLocalStream('dev_capybara', ['dev.capybara.testLeafServer-leaf']);
			const all_streams = await nats_utils.listStreams();
			let dog_found = false;
			let capybara_found = false;
			for (const stream of all_streams) {
				if (stream.config.name === 'dev_dog') {
					dog_found = true;
					expect(stream.config.subjects[0]).to.equal('dev.dog.testLeafServer-leaf');
				}

				if (stream.config.name === 'dev_capybara') {
					capybara_found = true;
					expect(stream.config.subjects[0]).to.equal('dev.capybara.testLeafServer-leaf');
				}
			}

			expect(dog_found, 'listStreams failed to return dog_found stream').to.be.true;
			expect(capybara_found, 'listStreams failed to return capybara_found stream').to.be.true;
			await nats_utils.deleteLocalStream('dev_dog');
			await nats_utils.deleteLocalStream('dev_capybara');
		}).timeout(TEST_TIMEOUT);

		it('Test deleteLocalStream deletes a local stream', async () => {
			await nats_utils.createLocalStream('dev_capybara', ['dev.capybara.testLeafServer-leaf']);
			await nats_utils.deleteLocalStream('dev_capybara');
			const all_streams = await nats_utils.listStreams();
			let capybara_found = false;
			for (const stream of all_streams) {
				if (stream.config.name === 'dev_capybara') {
					capybara_found = true;
					break;
				}
			}

			expect(capybara_found, 'Expected deleteLocalStream to delete stream but it did not').to.be.false;
		}).timeout(TEST_TIMEOUT);

		it('Test getServerConfig returns server leaf config', () => {
			const result = nats_utils.getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
			expect(result.port).to.equal(9991);
			expect(result.server_name).to.equal('testLeafServer-leaf');
			expect(result.config_file).to.equal('leaf.json');
			expect(result.domain).to.equal('testLeafServer-leaf');
		});

		it('Test getServerConfig returns server hub config', () => {
			env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT, 7788);
			const result = nats_utils.getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
			expect(result.port).to.equal(7788);
			expect(result.server_name).to.equal('testLeafServer-hub');
			expect(result.config_file).to.equal('hub.json');
		});

		// Testing this with a local stream because that's all the test servers we have.
		it('Test listRemoteStreams returns a stream', async () => {
			await nats_utils.createLocalStream('dev_capybara', ['dev.capybara.testLeafServer-leaf']);
			const result = await nats_utils.listRemoteStreams('testLeafServer-leaf');
			expect(result[0].total).to.equal(1);
			expect(result[0].streams[0].config.name).to.equal('dev_capybara');
			await nats_utils.deleteLocalStream('dev_capybara');
		}).timeout(TEST_TIMEOUT);

		it('Test viewStream returns three entries from a stream', async () => {
			await nats_utils.createLocalStream('dev_capybara', ['dev.capybara.testLeafServer-leaf']);
			await nats_utils.publishToStream('dev.capybara', 'dev_capybara', [{ id: 2 }, { id: 3 }, { id: 4 }]);
			const result = await nats_utils.viewStream('dev_capybara');

			expect(result.length).to.equal(3);
			expect(result[0].originators[0]).to.equal('testLeafServer-leaf');
			expect(result[0].entry).to.eql({ id: 2 });
			expect(result[1].originators[0]).to.equal('testLeafServer-leaf');
			expect(result[1].entry).to.eql({ id: 3 });
			expect(result[2].originators[0]).to.equal('testLeafServer-leaf');
			expect(result[2].entry).to.eql({ id: 4 });

			await nats_utils.deleteLocalStream('dev_capybara');
		}).timeout(TEST_TIMEOUT);

		it('Test viewStream returns zero entries ', async () => {
			await nats_utils.createLocalStream('dev_capybara', ['dev.capybara.testLeafServer-leaf']);
			const result = await nats_utils.viewStream('dev_capybara');
			expect(result.length).to.equal(0);
		}).timeout(TEST_TIMEOUT);

		it('Test publishToStream if the stream exists', async () => {
			const test_entry = [
				{ id: 2, name: 'big bird' },
				{ id: 3, alive: true },
			];
			await nats_utils.createLocalStream('dev_capybara', ['dev.capybara.testLeafServer-leaf']);
			await nats_utils.publishToStream('dev.capybara', 'dev_capybara', test_entry);
			const stream_view = await nats_utils.viewStream('dev_capybara');

			expect(stream_view[0].originators[0]).to.equal('testLeafServer-leaf');
			expect(stream_view[0].entry).to.eql(test_entry[0]);
			expect(stream_view[1].originators[0]).to.equal('testLeafServer-leaf');
			expect(stream_view[1].entry).to.eql(test_entry[1]);

			await nats_utils.deleteLocalStream('dev_capybara');
		}).timeout(TEST_TIMEOUT);

		it('Test publish to stream when the stream doesnt exist', async () => {
			const test_entry = [
				{ id_a: 2.32321, name: 'henry' },
				{ id_c: 3, alive: true },
			];
			await nats_utils.publishToStream('dev.giraffe', 'dev_giraffe', test_entry);
			const stream_view = await nats_utils.viewStream('dev_giraffe');

			expect(stream_view[0].originators[0]).to.equal('testLeafServer-leaf');
			expect(stream_view[0].entry).to.eql(test_entry[0]);
			expect(stream_view[1].originators[0]).to.equal('testLeafServer-leaf');
			expect(stream_view[1].entry).to.eql(test_entry[1]);

			await nats_utils.deleteLocalStream('dev_giraffe');
		}).timeout(TEST_TIMEOUT);

		it('Test createWorkQueueStream creates a work queue and a consumer', async () => {
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			const streams = await nats_utils.listStreams();
			const { jsm } = await nats_utils.getNATSReferences();
			const consumer = await jsm.consumers.info(
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.durable_name
			);

			expect(streams[0].config.name).to.equal('__HARPERDB_WORK_QUEUE__');
			expect(consumer.name).to.equal('HDB_WORK_QUEUE');

			await jsm.consumers.delete('__HARPERDB_WORK_QUEUE__', 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream('__HARPERDB_WORK_QUEUE__');
		}).timeout(TEST_TIMEOUT);

		it('Test addSourceToWorkStream adds a node to work queue', async () => {
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				'dev_giraffe'
			);

			const { jsm } = await nats_utils.getNATSReferences();
			const wq_stream = await jsm.streams.info('__HARPERDB_WORK_QUEUE__');

			expect(wq_stream.config.sources[0].name).to.equal('dev_giraffe');
			expect(wq_stream.config.sources[0].external.api).to.equal('$JS.unit_test_node.API');
			expect(wq_stream.config.sources[0].external.deliver).to.equal('');

			await jsm.consumers.delete('__HARPERDB_WORK_QUEUE__', 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream('__HARPERDB_WORK_QUEUE__');
		}).timeout(TEST_TIMEOUT);

		it('Test removeSourceFromWorkStream removes a node from work stream', async () => {
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				'dev_giraffe'
			);

			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				'dev_horse'
			);

			await nats_utils.removeSourceFromWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				'dev_giraffe'
			);

			const jsm = await nats_utils.getJetStreamManager();
			const wq_stream = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			expect(wq_stream.config.sources.length).to.equal(1);
			expect(wq_stream.config.sources[0].name).to.equal('dev_horse');
		}).timeout(TEST_TIMEOUT);
	});

	describe('Test natUtils with stubs', () => {
		const util_sandbox = sinon.createSandbox();

		afterEach(() => {
			util_sandbox.restore();
		});

		it('Test request function calls stubbed nats methods', async () => {
			const test_msg = JSON.stringify({ message: 'im a response' });
			const fake_request = util_sandbox.stub().callsFake(() => {
				return { data: test_msg };
			});
			const connection = {
				request: fake_request,
			};

			const decode_rw = nats_utils.__set__('jc.decode', util_sandbox.stub().returns('Test request response'));
			const fake_nats_ref = util_sandbox.stub().resolves({ connection });
			const get_nats_ref_rw = nats_utils.__set__('getNATSReferences', fake_nats_ref);
			const result = await nats_utils.request('request_subject', { operation: 'add_node' }, 3000);
			expect(result).to.equal('Test request response');
			expect(fake_request.args[0][0]).to.eql('request_subject');
			expect(fake_request.args[0][2].timeout).to.eql(3000);
			expect(fake_request.args[0][2].noMux).to.be.true;
			decode_rw();
			get_nats_ref_rw();
		});

		it('Test reloadNATSHub calls reload with Hub pid file path', async () => {
			const pid_file_path = 'hub/pid/file.pid';
			const get_server_config_rw = nats_utils.__set__(
				'getServerConfig',
				util_sandbox.stub().returns({ pid_file_path })
			);
			const reload_nats_stub = util_sandbox.stub().resolves();
			const reload_nats_rw = nats_utils.__set__('reloadNATS', reload_nats_stub);
			await nats_utils.reloadNATSHub();
			expect(reload_nats_stub.args[0][0]).to.equal(pid_file_path);
			get_server_config_rw();
			reload_nats_rw();
		});

		it('Test reloadNATSLeaf calls reload with Leaf pid file path', async () => {
			const pid_file_path = 'leaf/pid/file.pid';
			const get_server_config_rw = nats_utils.__set__(
				'getServerConfig',
				util_sandbox.stub().returns({ pid_file_path })
			);
			const reload_nats_stub = util_sandbox.stub().resolves();
			const reload_nats_rw = nats_utils.__set__('reloadNATS', reload_nats_stub);
			await nats_utils.reloadNATSLeaf();
			expect(reload_nats_stub.args[0][0]).to.equal(pid_file_path);
			get_server_config_rw();
			reload_nats_rw();
		});
	});

	it('Test requestErrorHandler returns no response error', () => {
		const result = nats_utils.requestErrorHandler({ code: '503' }, 'add_node', 'im_remote');
		expect(result).to.equal("Unable to add_node, node 'im_remote' is not listening.");
	});

	it('Test requestErrorHandler returns timeout error', () => {
		const result = nats_utils.requestErrorHandler({ code: 'TIMEOUT' }, 'add_node', 'im_remote');
		expect(result).to.equal("Unable to add_node, node 'im_remote' is listening but did not respond.");
	});

	it('Test updateWorkStream calls add source once happy path', async () => {
		let add_source_to_work_stream_stub = sandbox.stub();
		let add_source_rw = nats_utils.__set__('addSourceToWorkStream', add_source_to_work_stream_stub);
		await nats_utils.updateWorkStream(
			{
				schema: 'dog',
				table: 'poodle',
				publish: false,
				subscribe: true,
			},
			'node_i_am'
		);
		expect(add_source_to_work_stream_stub.args[0]).to.eql(['node_i_am-leaf', '__HARPERDB_WORK_QUEUE__', 'dog/poodle']);
		add_source_rw();
	});

	it('Test updateWorkStream calls remove source once happy path', async () => {
		let remove_source_from_work_stream_stub = sandbox.stub();
		let remove_source_rw = nats_utils.__set__('removeSourceFromWorkStream', remove_source_from_work_stream_stub);
		await nats_utils.updateWorkStream(
			{
				schema: 'dog',
				table: 'poodle',
				publish: false,
				subscribe: false,
			},
			'node_i_am'
		);
		expect(remove_source_from_work_stream_stub.args[0]).to.eql([
			'node_i_am-leaf',
			'__HARPERDB_WORK_QUEUE__',
			'dog/poodle',
		]);
		remove_source_rw();
	});

	it('Test createLocalTableStream create correct stream and subject name and calls create stream', async () => {
		const test_server_name = 'unit_test-leaf';
		const jsm = { nc: { info: { server_name: test_server_name } } };
		const get_nats_ref_stub = sandbox.stub().resolves({ jsm });
		const create_local_stream_stub = sandbox.stub();
		const create_local_stream_rw = nats_utils.__set__('createLocalStream', create_local_stream_stub);
		const get_nats_ref_rw = nats_utils.__set__('getNATSReferences', get_nats_ref_stub);
		await nats_utils.createLocalTableStream('dev', 'chicken');
		expect(create_local_stream_stub.args[0][0]).to.equal('dev/chicken');
		expect(create_local_stream_stub.args[0][1][0]).to.equal('dev.chicken.unit_test-leaf');
		create_local_stream_rw();
		get_nats_ref_rw();
	});

	it('Test createTableStreams calls create local table for each sub', async () => {
		const test_subs = [
			{
				schema: 'breed',
				table: 'beagle',
				subscribe: true,
				publish: true,
			},
			{
				schema: 'country',
				table: 'england',
				subscribe: true,
				publish: false,
			},
		];

		const create_local_table_stream_stub = sandbox.stub();
		const create_local_table_stream_rw = nats_utils.__set__('createLocalTableStream', create_local_table_stream_stub);
		await nats_utils.createTableStreams(test_subs);
		expect(create_local_table_stream_stub.getCall(0).args).to.eql(['breed', 'beagle']);
		expect(create_local_table_stream_stub.getCall(1).args).to.eql(['country', 'england']);
		create_local_table_stream_rw();
	});

	it('Test purgeTableStream calls purge with stream name', async () => {
		const purge_stub = sandbox.stub().callsFake();
		const jsm = { streams: { purge: purge_stub } };
		const get_nats_ref_stub = sandbox.stub().resolves({ jsm });
		const get_nats_ref_rw = nats_utils.__set__('getNATSReferences', get_nats_ref_stub);
		await nats_utils.purgeTableStream('dev', 'chicken');
		expect(purge_stub.args[0][0]).to.equal('dev/chicken');
		get_nats_ref_rw();
	});

	it('Test purgeTableStream handles stream not found error', async () => {
		const purge_stub = sandbox.stub().throws(new Error('stream not found'));
		const jsm = { streams: { purge: purge_stub } };
		const get_nats_ref_stub = sandbox.stub().resolves({ jsm });
		const get_nats_ref_rw = nats_utils.__set__('getNATSReferences', get_nats_ref_stub);
		await nats_utils.purgeTableStream('dev', 'chicken');
		expect(hdb_warn_log_stub.args[0][0].message).to.equal('stream not found');
		get_nats_ref_rw();
	});

	it('Test purgeSchemaTableStreams calls purge for all tables', async () => {
		const test_tables = ['chicken', 'dog', 'cow'];
		const test_schema = 'farm_animals';
		const purge_table_stub = sandbox.stub().resolves();
		const purge_table_rw = nats_utils.__set__('purgeTableStream', purge_table_stub);
		await nats_utils.purgeSchemaTableStreams(test_schema, test_tables);
		expect(purge_table_stub.getCall(0).args).to.eql(['farm_animals', 'chicken']);
		expect(purge_table_stub.getCall(1).args).to.eql(['farm_animals', 'dog']);
		expect(purge_table_stub.getCall(2).args).to.eql(['farm_animals', 'cow']);
		purge_table_rw();
	});
});
