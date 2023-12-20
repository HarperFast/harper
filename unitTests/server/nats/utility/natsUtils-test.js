'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const { headers } = require('nats');
const { decode } = require('msgpackr');
const path = require('path');
const fs = require('fs-extra');

const test_utils = require('../../../test_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const nats_terms = require('../../../../server/nats/utility/natsTerms');
const env_manager = require('../../../../utility/environment/environmentManager');
const nats_utils = rewire('../../../../server/nats/utility/natsUtils');
const hdb_logger = require('../../../../utility/logging/harper_logger');
const crypto_hash = require('../../../../security/cryptoHash');
const hdb_utils = require('../../../../utility/common_utils');

const TEST_TIMEOUT = 30000;
const TEST_SUBJECT_NAME = 'txn.devTest.Chicken1.testLeafServer-leaf';
const TEST_SCHEMA = 'devTest';
const TEST_TABLE1 = 'Chicken1';
const TEST_TABLE2 = 'capybara';
const TEST_STREAM_NAME = crypto_hash.createNatsTableStreamName(TEST_SCHEMA, TEST_TABLE1);
const TEST_SUBJECT_NAME_2 = 'txn.devTest.capybara.testLeafServer-leaf';
const TEST_STREAM_NAME_2 = crypto_hash.createNatsTableStreamName(TEST_SCHEMA, TEST_TABLE2);
const TEST_HEADERS = headers();
TEST_HEADERS.append(nats_terms.MSG_HEADERS.TRANSACTED_NODES, 'another_node');
TEST_HEADERS.append(nats_terms.MSG_HEADERS.ORIGIN, 'testLeafServer');

function CreateStreamMessage(operation, schema, table, records) {
	this.operation = operation;
	this.schema = schema;
	this.table = table;
	this.records = records;
}

describe('Test natsUtils module', () => {
	let sandbox = sinon.createSandbox();
	let hdb_warn_log_stub;

	before(() => {
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED, true);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME, 'testLeafServer');
		hdb_warn_log_stub = sandbox.stub(hdb_logger, 'warn');
	});

	after(async () => {
		await nats_utils.closeConnection();
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
			sandbox.stub(hdb_utils, 'getTableHashAttribute').returns('id');
			await test_utils.launchTestLeafServer();
			test_utils.setFakeClusterUser();
		});

		after(async () => {
			await test_utils.stopTestLeafServer();
			test_utils.unsetFakeClusterUser();
			await nats_utils.closeConnection();
		});

		it('Test createConnection connects to a leaf server', async () => {
			const connection = await nats_utils.createConnection(9991, test_cluster_user, test_cluster_user_pass, true);
			expect(connection).to.haveOwnProperty('options');
			expect(connection).to.haveOwnProperty('protocol');
			expect(connection).to.haveOwnProperty('listeners');
			expect(connection.protocol.connected).to.be.true;
			await connection.close();
		}).timeout(TEST_TIMEOUT);

		it('Test getConnection creates a connection and sets it to var', async () => {
			env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT, 9991);
			await nats_utils.getConnection();
			const nats_connection = nats_utils.__get__('nats_connection');

			expect(nats_connection).to.haveOwnProperty('options');
			expect(nats_connection).to.haveOwnProperty('protocol');
			expect(nats_connection).to.haveOwnProperty('listeners');
			expect(nats_connection.protocol.connected).to.be.true;
		}).timeout(TEST_TIMEOUT);

		it('Test getJetStreamManager returns JetStream manager', async () => {
			await nats_utils.getConnection();
			const result = await nats_utils.getJetStreamManager();
			expect(result).to.haveOwnProperty('nc');
			expect(result).to.haveOwnProperty('opts');
			expect(result).to.haveOwnProperty('jc');
			expect(result).to.haveOwnProperty('streams');
			expect(result).to.haveOwnProperty('consumers');
		}).timeout(TEST_TIMEOUT);

		it('Test getJetStreamManager calls getConnection if a connection does not exist', async () => {
			const result = await nats_utils.getJetStreamManager();
			expect(result).to.haveOwnProperty('nc');
			expect(result).to.haveOwnProperty('opts');
			expect(result).to.haveOwnProperty('jc');
			expect(result).to.haveOwnProperty('streams');
			expect(result).to.haveOwnProperty('consumers');
		}).timeout(TEST_TIMEOUT);

		it('Test getJetStream returns JetStream client', async () => {
			await nats_utils.getConnection();
			const result = await nats_utils.getJetStream();
			expect(result).to.haveOwnProperty('nc');
			expect(result).to.haveOwnProperty('opts');
			expect(result).to.haveOwnProperty('jc');
			expect(result).to.haveOwnProperty('streamAPI');
		}).timeout(TEST_TIMEOUT);

		it('Test getJetStream returns JetStream client if if a connection does not exist', async () => {
			nats_utils.__set__('nats_connection', undefined);
			const result = await nats_utils.getJetStream();
			expect(result).to.haveOwnProperty('nc');
			expect(result).to.haveOwnProperty('opts');
			expect(result).to.haveOwnProperty('jc');
			expect(result).to.haveOwnProperty('streamAPI');
		}).timeout(TEST_TIMEOUT);

		it('Test getNATSReferences calls getConnection and the JetStream functions', async () => {
			const result = await nats_utils.getNATSReferences();
			expect(result.connection.constructor.name).to.equal('NatsConnectionImpl');
			expect(result.jsm.constructor.name).to.equal('JetStreamManagerImpl');
			expect(result.js.constructor.name).to.equal('JetStreamClientImpl');
		}).timeout(TEST_TIMEOUT);

		it('Test getServerList returns a list with the test server in it', async () => {
			env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT, 9991);
			const result = await nats_utils.getServerList(2000);
			expect(result[0].server.name).to.equal('testLeafServer-leaf');
		}).timeout(TEST_TIMEOUT);

		it('Test createLocalStream creates a stream', async () => {
			await nats_utils.createLocalStream(TEST_STREAM_NAME, [TEST_SUBJECT_NAME]);
			const all_streams = await nats_utils.listStreams();
			let stream_found = false;
			for (const stream of all_streams) {
				if (stream.config.name === TEST_STREAM_NAME) {
					stream_found = true;
					break;
				}
			}
			expect(stream_found, 'createLocalStream failed to create a stream').to.be.true;
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME);
		}).timeout(TEST_TIMEOUT);

		it('Test listStreams returns a list of streams', async () => {
			await nats_utils.createLocalStream(TEST_STREAM_NAME, [TEST_SUBJECT_NAME]);
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			const all_streams = await nats_utils.listStreams();
			let dog_found = false;
			let capybara_found = false;
			for (const stream of all_streams) {
				if (stream.config.name === TEST_STREAM_NAME) {
					dog_found = true;
					expect(stream.config.subjects[0]).to.equal(TEST_SUBJECT_NAME);
				}

				if (stream.config.name === TEST_STREAM_NAME_2) {
					capybara_found = true;
					expect(stream.config.subjects[0]).to.equal(TEST_SUBJECT_NAME_2);
				}
			}

			expect(dog_found, 'listStreams failed to return dog_found stream').to.be.true;
			expect(capybara_found, 'listStreams failed to return capybara_found stream').to.be.true;
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME);
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test deleteLocalStream deletes a local stream', async () => {
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
			const all_streams = await nats_utils.listStreams();
			let capybara_found = false;
			for (const stream of all_streams) {
				if (stream.config.name === TEST_STREAM_NAME_2) {
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
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			const result = await nats_utils.listRemoteStreams('testLeafServer-leaf');
			expect(result[0].total).to.equal(1);
			expect(result[0].streams[0].config.name).to.equal(TEST_STREAM_NAME_2);
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test viewStream returns three entries from a stream', async () => {
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', { id: 2 })
			);
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', { id: 3 })
			);
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', { id: 4 })
			);
			const result = await nats_utils.viewStream(TEST_STREAM_NAME_2);

			expect(result.length).to.equal(3);
			expect(result[0].origin).to.equal('testLeafServer');
			expect(result[0].entry).to.eql({
				operation: 'insert',
				records: {
					id: 2,
				},
				schema: 'devTest',
				table: 'capybara',
			});
			expect(result[1].origin).to.equal('testLeafServer');
			expect(result[1].entry).to.eql({
				operation: 'insert',
				records: {
					id: 3,
				},
				schema: 'devTest',
				table: 'capybara',
			});
			expect(result[2].origin).to.equal('testLeafServer');
			expect(result[2].entry).to.eql({
				operation: 'insert',
				records: {
					id: 4,
				},
				schema: 'devTest',
				table: 'capybara',
			});

			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test viewStream returns zero entries ', async () => {
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			const result = await nats_utils.viewStream(TEST_STREAM_NAME_2);
			expect(result.length).to.equal(0);
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test viewStreamIterator returns three entries from a stream', async () => {
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', { id: 2 })
			);
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', { id: 3 })
			);
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', { id: 4 })
			);
			const transactions = await nats_utils.viewStreamIterator(TEST_STREAM_NAME_2);

			const result = [];
			for await (const tx of transactions) {
				result.push(tx);
			}

			expect(result.length).to.equal(3);
			expect(result[0].origin).to.equal('testLeafServer');
			expect(result[0].entry).to.eql({
				operation: 'insert',
				schema: 'devTest',
				table: 'capybara',
				records: {
					id: 2,
				},
			});
			expect(result[1].entry).to.eql({
				operation: 'insert',
				schema: 'devTest',
				table: 'capybara',
				records: {
					id: 3,
				},
			});
			expect(result[2].entry).to.eql({
				operation: 'insert',
				schema: 'devTest',
				table: 'capybara',
				records: {
					id: 4,
				},
			});

			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test viewStreamIterator returns zero entries ', async () => {
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			const transactions = await nats_utils.viewStreamIterator(TEST_STREAM_NAME_2);
			const result = [];
			for await (const tx of transactions) {
				result.push(tx);
			}
			expect(result.length).to.equal(0);
		}).timeout(TEST_TIMEOUT);

		it('Test publishToStream if the stream exists', async () => {
			const test_entry = [
				{ id: 2, name: 'big bird' },
				{ id: 3, alive: true },
			];
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				TEST_HEADERS,
				new CreateStreamMessage('insert', 'devTest', 'capybara', test_entry)
			);
			const stream_view = await nats_utils.viewStream(TEST_STREAM_NAME_2);

			expect(stream_view[0].origin).to.equal('testLeafServer');
			expect(stream_view[0].entry.records).to.eql(test_entry);

			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test publish to stream when the stream doesnt exist', async () => {
			const test_entry = [
				{ id_a: 2.32321, name: 'henry' },
				{ id_c: 3, alive: true },
			];
			await nats_utils.publishToStream(
				'txn.dev.giraffe',
				'dev_giraffe',
				TEST_HEADERS,
				new CreateStreamMessage('insert', 'devTest', 'capybara', test_entry)
			);
			const stream_view = await nats_utils.viewStream('dev_giraffe');

			expect(stream_view[0].origin).to.equal('testLeafServer');
			expect(stream_view[0].entry.records).to.eql(test_entry);

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
			const test_sub = {
				schema: TEST_SCHEMA,
				table: TEST_TABLE1,
				publish: true,
				subscribe: true,
			};
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);

			const { jsm } = await nats_utils.getNATSReferences();
			const wq_stream = await jsm.streams.info('__HARPERDB_WORK_QUEUE__');

			expect(wq_stream.config.sources[0].name).to.equal(TEST_STREAM_NAME);
			expect(wq_stream.config.sources[0].external.api).to.equal('$JS.unit_test_node.API');
			expect(wq_stream.config.sources[0].external.deliver).to.equal('');
			expect(wq_stream.config.sources[0].opt_start_time).to.not.be.undefined;
			expect(wq_stream.config.sources[0].filter_subject).to.equal('txn.>');

			await jsm.consumers.delete('__HARPERDB_WORK_QUEUE__', 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream('__HARPERDB_WORK_QUEUE__');
		}).timeout(TEST_TIMEOUT);

		it.skip('Test concurrently calling updateWorkStream', async () => {
			// TODO: This is creating a database level subscription, and probably shouldn't
			const test_schema = 'tx_lock_test_schema';
			const test_table = 'tx_lock_test_table';
			const { jsm } = await nats_utils.getNATSReferences();
			env_manager.setHdbBasePath(test_utils.getMockTestPath());

			const test_env = await test_utils.createMockDB('name', test_schema, test_table, []);
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);

			const schema_rw = nats_utils.__set__('hdb_terms.SYSTEM_SCHEMA_NAME', test_schema);
			const table_rw = nats_utils.__set__('hdb_terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME', test_table);

			let add_source_promises = [];
			for (let x = 0; x < 3; x++) {
				const test_sub = {
					schema: TEST_SCHEMA,
					table: x,
					publish: true,
					subscribe: true,
				};

				add_source_promises.push(nats_utils.updateWorkStream(test_sub, 'unit_test_node'));
			}

			await Promise.all(add_source_promises);

			const wq_stream = await jsm.streams.info('__HARPERDB_WORK_QUEUE__');
			expect(wq_stream.config.sources.length).to.equal(3);

			let remove_source_promises = [];
			for (let x = 0; x < 3; x++) {
				const test_sub = {
					schema: TEST_SCHEMA,
					table: x,
					publish: false,
					subscribe: false,
				};

				remove_source_promises.push(nats_utils.updateWorkStream(test_sub, 'unit_test_node'));
			}

			await Promise.all(remove_source_promises);
			schema_rw();
			table_rw();

			const wq_stream_remove = await jsm.streams.info('__HARPERDB_WORK_QUEUE__');
			expect(wq_stream_remove.config.sources).to.be.undefined;

			await jsm.consumers.delete('__HARPERDB_WORK_QUEUE__', 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream('__HARPERDB_WORK_QUEUE__');
			await test_utils.tearDownMockDB(test_env);
		}).timeout(TEST_TIMEOUT);

		it.skip('Test concurrently adding removing updateWorkStream', async () => {
			// TODO: This is creating a database level subscription, and probably shouldn't
			const test_schema = 'tx_lock_test_schema';
			const test_table = 'tx_lock_test_table';
			const { jsm } = await nats_utils.getNATSReferences();
			env_manager.setHdbBasePath(test_utils.getMockTestPath());

			const test_env = await test_utils.createMockDB('name', test_schema, test_table, []);
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);

			const schema_rw = nats_utils.__set__('hdb_terms.SYSTEM_SCHEMA_NAME', test_schema);
			const table_rw = nats_utils.__set__('hdb_terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME', test_table);

			let update_source_promises = [];
			for (let x = 0; x < 3; x++) {
				const test_sub = {
					schema: TEST_SCHEMA,
					table: x,
					publish: true,
					subscribe: true,
				};

				update_source_promises.push(nats_utils.updateWorkStream(test_sub, 'unit_test_node'));
			}

			for (let x = 0; x < 3; x++) {
				const test_sub = {
					schema: TEST_SCHEMA,
					table: x,
					publish: false,
					subscribe: false,
				};

				update_source_promises.push(nats_utils.updateWorkStream(test_sub, 'unit_test_node'));
			}

			await Promise.all(update_source_promises);
			schema_rw();
			table_rw();

			const wq_stream_remove = await jsm.streams.info('__HARPERDB_WORK_QUEUE__');
			expect(wq_stream_remove.config.sources).to.be.undefined;

			await jsm.consumers.delete('__HARPERDB_WORK_QUEUE__', 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream('__HARPERDB_WORK_QUEUE__');
			await test_utils.tearDownMockDB(test_env);
		}).timeout(TEST_TIMEOUT);

		it.skip('Test addSourceToWorkStream where start_time is before one message in source', async () => {
			// Create local stream
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			// Publish a message to stream
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				TEST_HEADERS,
				new CreateStreamMessage('insert', 'devTest', 'capybara', [{ id: 1 }])
			);
			// Wait half a second
			await hdb_utils.async_set_timeout(500);
			// Get the time now
			const test_start_date = new Date(Date.now()).toISOString();
			// Publish another message to the stream

			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				TEST_HEADERS,
				new CreateStreamMessage('insert', 'devTest', 'capybara', [{ id: 2 }])
			);
			// Create a work queue stream
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);

			const test_sub = {
				schema: TEST_SCHEMA,
				table: TEST_TABLE2,
				publish: true,
				subscribe: true,
				start_time: test_start_date,
			};

			// Add the test local stream as a source to the work queue stream, pass the start date that was generated between the two inserts.
			await nats_utils.addSourceToWorkStream(
				'testLeafServer-leaf',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);
			const { jsm } = await nats_utils.getNATSReferences();
			// Get the work queue stream info and make sure there is just one message in the stream to prove that start date filter is working.
			const wq_stream = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			expect(wq_stream.state.messages).to.equal(1);
			// Get the one message from the work queue and make sure it is the one that was published after the start date
			const msg = await jsm.streams.getMessage(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name, {
				seq: wq_stream.state.first_seq,
			});
			expect(decode(msg.data).records[0].id).to.equal(2);

			await jsm.consumers.delete(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name, 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test addNatsMsgHeader creates header and adds ID and origin', async () => {
			const addNatsMsgHeader = nats_utils.__get__('addNatsMsgHeader');
			const result = addNatsMsgHeader({ operation: 'insert', schema: 'pet', table: 'dragon' });

			expect(typeof result).to.equal('object');
			expect(result.has('origin')).to.be.true;
		});

		it('Test addSourceToWorkStream using default start_time', async () => {
			const test_sub = {
				schema: TEST_SCHEMA,
				table: TEST_TABLE2,
				publish: true,
				subscribe: true,
			};

			// Create local stream
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			// Publish a message to stream
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', [{ id: 1 }])
			);
			// Publish another message to the stream
			await nats_utils.publishToStream(
				'txn.devTest.capybara',
				TEST_STREAM_NAME_2,
				undefined,
				new CreateStreamMessage('insert', 'devTest', 'capybara', [{ id: 2 }])
			);
			// Create a work queue stream
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			// Add the test local stream as a source to the work queue stream, pass the start date that was generated between the two inserts.
			await nats_utils.addSourceToWorkStream(
				'testLeafServer-leaf',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);
			const { jsm } = await nats_utils.getNATSReferences();
			// Get the work queue stream info and make sure there are no messaged in there.
			const wq_stream = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			expect(wq_stream.state.messages).to.equal(0);

			await jsm.consumers.delete(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name, 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test addSourceToWorkStream that already exists in work stream', async () => {
			const test_sub = {
				schema: TEST_SCHEMA,
				table: TEST_TABLE1,
				publish: true,
				subscribe: true,
			};
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);

			const { jsm } = await nats_utils.getNATSReferences();
			let wq_stream = await jsm.streams.info('__HARPERDB_WORK_QUEUE__');

			expect(wq_stream.config.sources[0].name).to.equal(TEST_STREAM_NAME);
			expect(wq_stream.config.sources[0].external.api).to.equal('$JS.unit_test_node.API');
			expect(wq_stream.config.sources[0].external.deliver).to.equal('');
			expect(wq_stream.config.sources[0].opt_start_time).to.not.be.undefined;

			test_sub.start_time = '2022-09-02T20:06:35.993Z';

			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);

			wq_stream = await jsm.streams.info('__HARPERDB_WORK_QUEUE__');
			expect(wq_stream.config.sources[0].name).to.equal(TEST_STREAM_NAME);
			expect(wq_stream.config.sources[0].external.api).to.equal('$JS.unit_test_node.API');
			expect(wq_stream.config.sources[0].external.deliver).to.equal('');
			expect(wq_stream.config.sources[0].opt_start_time).to.equal('2022-09-02T20:06:35.993Z');
		}).timeout(TEST_TIMEOUT);

		it('Test removeSourceFromWorkStream removes a node from work stream', async () => {
			const test_sub = {
				schema: TEST_SCHEMA,
				table: TEST_TABLE1,
				publish: true,
				subscribe: true,
			};

			const test_sub2 = {
				schema: 'dev',
				table: 'horse',
				publish: true,
				subscribe: true,
			};

			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);

			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub2
			);

			await nats_utils.removeSourceFromWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);

			const jsm = await nats_utils.getJetStreamManager();
			const wq_stream = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			await nats_utils.removeSourceFromWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub2
			);

			expect(wq_stream.config.sources.length).to.equal(1);
			expect(wq_stream.config.sources[0].name).to.equal('7016c5a324d59667522d62b145fd2e54');
		}).timeout(TEST_TIMEOUT);

		it('Test removeSourceFromWorkStream removes last node from work stream', async () => {
			const test_sub = {
				schema: TEST_SCHEMA,
				table: TEST_TABLE1,
				publish: true,
				subscribe: true,
			};

			const jsm = await nats_utils.getJetStreamManager();
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			await jsm.streams.purge(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			await nats_utils.addSourceToWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);

			await nats_utils.removeSourceFromWorkStream(
				'unit_test_node',
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				test_sub
			);

			const wq_stream = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			expect(wq_stream.config.sources).to.be.undefined;

			const work_queue_inf_file = path.resolve(
				__dirname,
				'../tempTestDir/clustering/leaf/jetstream/HDB/streams/__HARPERDB_WORK_QUEUE__/meta.inf'
			);

			const inf_json = await fs.readJson(work_queue_inf_file);
			expect(inf_json.sources).to.be.undefined;
		}).timeout(TEST_TIMEOUT);

		it('Test getJsmServerName returns correct name', async () => {
			const getJsmServerName = nats_utils.__get__('getJsmServerName');
			const res = await getJsmServerName();
			expect(res).to.equal('testLeafServer-leaf');
		});

		it('Test createSubjectName returns correct name', async () => {
			const createSubjectName = nats_utils.__get__('createSubjectName');
			const res = createSubjectName('unit', 'test', 'nats');
			expect(res).to.equal('txn.unit.test.nats');
		});

		it.skip('Test updateLocalStreams updates subject name', async () => {
			// Create local stream
			await nats_utils.createLocalStream(TEST_STREAM_NAME_2, [TEST_SUBJECT_NAME_2]);
			// Create a work queue stream
			await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);

			const get_jsm_server_name_rw = nats_utils.__set__(
				'getJsmServerName',
				sandbox.stub().resolves('chicken_leg-leaf')
			);

			await nats_utils.updateLocalStreams();

			const { jsm } = await nats_utils.getNATSReferences();

			// Test that the work queue stream subject is updated
			const wq_stream = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			expect(wq_stream.config.subjects[0]).to.equal('__HARPERDB_WORK_QUEUE__.chicken_leg-leaf');

			// Test that the consumer of the work queue is updated
			const wq_consumer = await jsm.consumers.info(
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
				nats_terms.WORK_QUEUE_CONSUMER_NAMES.durable_name
			);
			expect(wq_consumer.config.deliver_subject).to.equal('__HDB__.WORKQUEUE.chicken_leg-leaf');

			// Test that the regular good old stream is updated
			const test_stream = await jsm.streams.info(TEST_STREAM_NAME_2);
			expect(test_stream.config.subjects[0]).to.equal('txn.devTest.capybara.chicken_leg-leaf');

			get_jsm_server_name_rw();
			await jsm.consumers.delete(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name, 'HDB_WORK_QUEUE');
			await nats_utils.deleteLocalStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
			await nats_utils.deleteLocalStream(TEST_STREAM_NAME_2);
		}).timeout(TEST_TIMEOUT);

		it('Test closeConnection closes a connection', async () => {
			await nats_utils.getConnection();
			await nats_utils.closeConnection();
			const nats_connection = nats_utils.__get__('nats_connection');
			expect(nats_connection).to.be.undefined;
		});
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

			const decode_rw = nats_utils.__set__('decode', util_sandbox.stub().returns('Test request response'));
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

	it('Test createLocalTableStream create correct stream and subject name and calls create stream', async () => {
		const test_server_name = 'unit_test-leaf';
		const jsm = { nc: { info: { server_name: test_server_name } } };
		const get_nats_ref_stub = sandbox.stub().resolves({ jsm });
		const create_local_stream_stub = sandbox.stub();
		const get_jsm_server_name_stub = sandbox.stub().resolves('unit_test-leaf');
		const get_jsm_server_name_rw = nats_utils.__set__('getJsmServerName', get_jsm_server_name_stub);
		const create_local_stream_rw = nats_utils.__set__('createLocalStream', create_local_stream_stub);
		const get_nats_ref_rw = nats_utils.__set__('getNATSReferences', get_nats_ref_stub);
		await nats_utils.createLocalTableStream('dev', 'chicken');
		expect(create_local_stream_stub.args[0][0]).to.equal('87a0f14775b2cdab9b437370b79abc4c');
		expect(create_local_stream_stub.args[0][1][0]).to.equal('txn.dev.chicken.unit_test-leaf');
		create_local_stream_rw();
		get_nats_ref_rw();
		get_jsm_server_name_rw();
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
		expect(purge_stub.args[0][0]).to.equal('87a0f14775b2cdab9b437370b79abc4c');
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

	it('Test updateStreamLimits updates age and bytes but not msgs', async () => {
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE, 3600);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES, 10000);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS, null);
		const updateStreamLimits = nats_utils.__get__('updateStreamLimits');
		const fake_stream = {
			config: {
				name: '9a771e7de733e54216e6ae98d794be01',
				subjects: ['radio.genre.david_local-leaf'],
				retention: 'limits',
				max_consumers: -1,
				max_msgs: -1,
				max_bytes: -1,
				max_age: 0,
				max_msgs_per_subject: -1,
				max_msg_size: -1,
				discard: 'old',
			},
		};

		//const fake_stream_clone = test_utils.deepClone(fake_stream);
		const result = await updateStreamLimits(fake_stream);

		expect(result).to.be.true;
		expect(fake_stream.config.max_age).to.equal(3600000000000);
		expect(fake_stream.config.max_bytes).to.equal(10000);
		expect(fake_stream.config.max_msgs).to.equal(-1);
	});

	it('Test updateStreamLimits does not update if values null', async () => {
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE, null);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES, null);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS, null);
		const updateStreamLimits = nats_utils.__get__('updateStreamLimits');
		const fake_stream = {
			config: {
				name: '9a771e7de733e54216e6ae98d794be01',
				subjects: ['radio.genre.david_local-leaf'],
				retention: 'limits',
				max_consumers: -1,
				max_msgs: -1,
				max_bytes: -1,
				max_age: 0,
				max_msgs_per_subject: -1,
				max_msg_size: -1,
				discard: 'old',
			},
		};

		//const fake_stream_clone = test_utils.deepClone(fake_stream);
		const result = await updateStreamLimits(fake_stream);

		expect(result).to.be.false;
		expect(fake_stream.config.max_age).to.equal(0);
		expect(fake_stream.config.max_bytes).to.equal(-1);
		expect(fake_stream.config.max_msgs).to.equal(-1);
	});
});
