'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const { headers } = require('nats');
const { decode } = require('msgpackr');
const TEST_HEADERS = headers();

const test_utils = require('../../test_utils');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const nats_terms = require('../../../server/nats/utility/natsTerms');
const hdb_logger = require('../../../utility/logging/harper_logger');
const server_utilities = require('../../../server/serverHelpers/serverUtilities');
const operation_function_caller = require('../../../utility/OperationFunctionCaller');
const nats_ingest_service = rewire('../../../server/nats/natsIngestService');
const real_nats_ingest_service = require('../../../server/nats/natsIngestService');
const { table } = require('../../../resources/databases');
const { setNATSReplicator } = require('../../../server/nats/natsReplicator');
const { setMainIsWorker } = require('../../../server/threads/manageThreads');
const search = require('../../../dataLayer/search');

const TEST_TIMEOUT = 30000;
const SUBJECT_NAME = 'txn.dev.hippopotamus';
const STREAM_NAME = '9edbde5c46cbe3b97ce08a2d8a033b2b';

async function setupTestStream() {
	await nats_utils.createLocalStream(STREAM_NAME, ['txn.dev.hippopotamus.testLeafServer-leaf']);
}

async function teardownTestStream() {
	await nats_utils.deleteLocalStream(STREAM_NAME);
}

describe('Test natsIngestService module', () => {
	const sandbox = sinon.createSandbox();
	let get_operation_function_spy;
	let call_operation_function_as_await_stub;
	let log_stub;
	let Hippopotamus;
	let sub_restore;
	TEST_HEADERS.append(nats_terms.MSG_HEADERS.ORIGIN, 'some_other_node');

	before(async () => {
		log_stub = sandbox.stub(hdb_logger, 'notify');
		get_operation_function_spy = sandbox.spy(server_utilities, 'getOperationFunction');
		call_operation_function_as_await_stub = sandbox.stub(operation_function_caller, 'callOperationFunctionAsAwait');
		await test_utils.launchTestLeafServer();
		test_utils.setFakeClusterUser();
		test_utils.getMockLMDBPath();
		setMainIsWorker(true);
		Hippopotamus = table({
			table: 'hippopotamus',
			database: 'dev',
			attributes: [{ name: 'name', isPrimaryKey: true }],
		});
		setNATSReplicator('hippopotamus', 'dev', Hippopotamus);
		sub_restore = nats_ingest_service.__set__(
			'database_subscriptions',
			real_nats_ingest_service.getDatabaseSubscriptions()
		);
	});

	after(async function () {
		this.timeout(TEST_TIMEOUT);
		try {
			test_utils.unsetFakeClusterUser();
			await test_utils.stopTestLeafServer();
		} catch (err) {}

		sub_restore();
		sandbox.restore();
		rewire('../../../server/nats/natsIngestService');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test initialize function get nats references', async () => {
		await nats_ingest_service.initialize();
		const nats_connection = nats_ingest_service.__get__('nats_connection');
		const server_name = nats_ingest_service.__get__('server_name');
		const js_manager = nats_ingest_service.__get__('js_manager');
		const js_client = nats_ingest_service.__get__('js_client');

		expect(nats_connection).to.haveOwnProperty('options');
		expect(server_name).to.equal('testLeafServer-leaf');
		expect(js_manager).to.haveOwnProperty('streams');
		expect(js_manager).to.haveOwnProperty('consumers');
		expect(js_client).to.haveOwnProperty('streamAPI');
	}).timeout(10000);

	describe('Test a consumer is created and messages ingested', () => {
		const fake_connections = [
			{
				name: 'testLeafServer',
				subscriptions: [
					{
						schema: 'dev',
						table: 'hippopotamus',
						publish: true,
						subscribe: true,
					},
				],
			},
		];
		let access_consumers;

		before(async () => {
			await setupTestStream();
			sandbox.stub(search, 'searchByValue').resolves(fake_connections);
			access_consumers = nats_ingest_service.__get__('accessConsumers');
		});

		after(async () => {
			await teardownTestStream();
			sandbox.restore();
		});

		it('Test that a consumer is created and two messages are processed', async () => {
			const test_operation = {
				operation: 'insert',
				schema: 'dev',
				table: 'hippopotamus',
				records: [{ name: 'Drake' }],
			};

			const second_test_operation = {
				operation: 'insert',
				schema: 'dev',
				table: 'hippopotamus',
				records: [{ name: 'Delores' }],
			};

			await nats_ingest_service.initialize();
			const js_manager = nats_ingest_service.__get__('js_manager');
			const js_client = nats_ingest_service.__get__('js_client');
			nats_ingest_service.ingestConsumer(STREAM_NAME, js_client, js_manager, 'testLeafServer-leaf');
			await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, TEST_HEADERS, test_operation);
			await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, TEST_HEADERS, second_test_operation);
			await new Promise((resolve) => setTimeout(resolve, 2000));
			let hippo_1 = await Hippopotamus.get('Drake');
			expect(hippo_1.name).to.equal('Drake');

			let hippo_2 = await Hippopotamus.get('Delores');
			expect(hippo_2.name).to.equal('Delores');
		}).timeout(TEST_TIMEOUT);
	});

	it('Test updateConsumer when status is start', async () => {
		const ingest_stub = sandbox.stub();
		nats_ingest_service.__set__('ingestConsumer', ingest_stub);
		const connect_stub = sandbox.stub().resolves({ js: 'test-js', jsm: 'test-jsm' });
		nats_ingest_service.__set__('connectToRemoteJS', connect_stub);
		await nats_ingest_service.updateConsumer({
			status: 'start',
			stream_name: 'test',
			node_domain_name: 'unit-test-leaf',
		});

		expect(ingest_stub.args).to.eql([['test', 'test-js', 'test-jsm', 'unit-test-leaf']]);
	});

	it('Test updateConsumer when status is stop', async () => {
		const test_consumer_msg_map = new Map();
		let close_stub = sandbox.stub().callsFake(async () => {});
		test_consumer_msg_map.set('testunit-test-leaf', { close: close_stub });
		nats_ingest_service.__set__('consumer_msgs', test_consumer_msg_map);
		const connection_status = nats_ingest_service.__get__('connection_status');
		connection_status.set('unit-test-leaf', 'failed');
		await nats_ingest_service.updateConsumer({
			status: 'stop',
			stream_name: 'test',
			node_domain_name: 'unit-test-leaf',
		});

		expect(close_stub.called).to.equal(true);
		expect(connection_status.get('unit-test-leaf')).to.equal('close');
	});
});
