'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const { toJsMsg } = require('nats');
const { decode } = require('msgpackr');

const test_utils = require('../../test_utils');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const nats_terms = require('../../../server/nats/utility/natsTerms');
const hdb_logger = require('../../../utility/logging/harper_logger');
const server_utilities = require('../../../server/serverHelpers/serverUtilities');
const operation_function_caller = require('../../../utility/OperationFunctionCaller');
const nats_ingest_service = rewire('../../../server/nats/natsIngestService');

const TEST_TIMEOUT = 30000;
const SUBJECT_NAME = 'txn.dev.hippopotamus';
const STREAM_NAME = '9edbde5c46cbe3b97ce08a2d8a033b2b';

async function setupTestStreamAndSource() {
	await nats_utils.createLocalStream(STREAM_NAME, ['txn.dev.hippopotamus.testLeafServer-leaf']);
	await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
	await nats_utils.addSourceToWorkStream('testLeafServer-leaf', nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name, {
		schema: 'dev',
		table: 'hippopotamus',
	});
}

async function teardownTestStreamAndSource() {
	await nats_utils.deleteLocalStream(STREAM_NAME);
	await nats_utils.deleteLocalStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
}

function decodeJsMsg(msg) {
	const js_msg = toJsMsg(msg);
	return decode(js_msg.data);
}

describe('Test natsIngestService module', () => {
	const sandbox = sinon.createSandbox();
	let get_operation_function_spy;
	let call_operation_function_as_await_stub;
	let log_stub;

	before(async () => {
		log_stub = sandbox.stub(hdb_logger, 'notify');
		get_operation_function_spy = sandbox.spy(server_utilities, 'getOperationFunction');
		call_operation_function_as_await_stub = sandbox.stub(operation_function_caller, 'callOperationFunctionAsAwait');
		await test_utils.launchTestLeafServer();
		test_utils.setFakeClusterUser();
	});

	after(async function () {
		this.timeout(TEST_TIMEOUT);
		test_utils.unsetFakeClusterUser();
		await test_utils.stopTestLeafServer();
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
		expect(js_client).to.haveOwnProperty('api');
	}).timeout(10000);

	describe('Test workQueueListener function', () => {
		const SUBJECT_NAME = 'txn.dev.hippopotamus';
		const STREAM_NAME = 'dev_hippopotamus';
		let message_processor_stub = sandbox.stub().resolves();
		let message_processor_rw;

		before(() => {
			message_processor_rw = nats_ingest_service.__set__('messageProcessor', message_processor_stub);
		});

		after(() => {
			message_processor_rw();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test workQueueListener processes one message in work queue stream', async () => {
			let opts = nats_ingest_service.__get__('SUBSCRIPTION_OPTIONS');
			opts.max = 1;
			let opts_restore = nats_ingest_service.__set__('SUBSCRIPTION_OPTIONS', opts);
			const test_operation = { operation: 'create_table', schema: 'dev', table: 'hippopotamus', hash_attribute: 'id' };
			await setupTestStreamAndSource();
			await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, [test_operation]);
			await nats_ingest_service.initialize();
			await nats_ingest_service.workQueueListener();

			expect(decodeJsMsg(message_processor_stub.args[0][0])).to.eql(test_operation);

			await teardownTestStreamAndSource();
			opts_restore();
		}).timeout(TEST_TIMEOUT);

		it('Test workQueueListener processes multiple message in work queue stream', async () => {
			let opts = nats_ingest_service.__get__('SUBSCRIPTION_OPTIONS');
			opts.max = 3;
			let opts_restore = nats_ingest_service.__set__('SUBSCRIPTION_OPTIONS', opts);
			const test_operation_1 = {
				operation: 'insert',
				schema: 'dev',
				table: 'hippopotamus',
				records: [{ name: 'Delores' }],
			};

			const test_operation_2 = {
				operation: 'insert',
				schema: 'dev',
				table: 'hippopotamus',
				records: [{ name: 'Tupac' }],
			};

			const test_operation_3 = {
				operation: 'insert',
				schema: 'dev',
				table: 'hippopotamus',
				records: [{ name: 'Biggie' }],
			};

			await setupTestStreamAndSource();
			// This first publish should not show up in queue because of the filterSubject on the sub
			await nats_utils.publishToStream('msgid.dev.hippopotamus', STREAM_NAME, [test_operation_3]);
			await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, [test_operation_1]);
			await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, [test_operation_2]);
			await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, [test_operation_3]);
			await nats_ingest_service.initialize();
			await nats_ingest_service.workQueueListener();

			expect(message_processor_stub.called).to.be.true;
			expect(decodeJsMsg(message_processor_stub.getCall(0).args[0])).to.eql(test_operation_1);
			expect(decodeJsMsg(message_processor_stub.getCall(1).args[0])).to.eql(test_operation_2);
			expect(decodeJsMsg(message_processor_stub.getCall(2).args[0])).to.eql(test_operation_3);

			await teardownTestStreamAndSource();
			opts_restore();
		}).timeout(TEST_TIMEOUT);
	});

	it('Test messageProcessor processes non job operation happy path', async () => {
		let opts = nats_ingest_service.__get__('SUBSCRIPTION_OPTIONS');
		opts.max = 1;
		let opts_restore = nats_ingest_service.__set__('SUBSCRIPTION_OPTIONS', opts);
		const test_operation = { operation: 'create_table', schema: 'dev', table: 'hippopotamus', hash_attribute: 'id' };
		await setupTestStreamAndSource();
		await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, [test_operation]);
		await nats_ingest_service.initialize();
		nats_ingest_service.__set__('server_name', 'hip_hop_hippopotamus');
		await nats_ingest_service.workQueueListener();
		test_operation['__clustering__'] = true;

		expect(get_operation_function_spy.args[0][0]).to.eql(test_operation);
		expect(call_operation_function_as_await_stub.args[0][0].name).to.equal('createTable');
		expect(call_operation_function_as_await_stub.args[0][1]).to.eql(test_operation);
		expect(call_operation_function_as_await_stub.args[0][2].name).to.equal('postOperationHandler');
		expect(call_operation_function_as_await_stub.args[0][3]).to.eql(['testLeafServer-leaf']);
		opts_restore();
	}).timeout(TEST_TIMEOUT);

	it('Test messageProcessor processes job operation happy path', async () => {
		let opts = nats_ingest_service.__get__('SUBSCRIPTION_OPTIONS');
		opts.max = 1;
		let opts_restore = nats_ingest_service.__set__('SUBSCRIPTION_OPTIONS', opts);
		const test_operation = {
			operation: 'csv_file_load',
			schema: 'dev',
			table: 'hippopotamus',
			file_path: 'file/here/data.csv',
		};
		await setupTestStreamAndSource();
		await nats_utils.publishToStream(SUBJECT_NAME, STREAM_NAME, [test_operation]);
		await nats_ingest_service.initialize();
		nats_ingest_service.__set__('server_name', 'hip_hop_hippopotamus');
		await nats_ingest_service.workQueueListener();

		expect(get_operation_function_spy.args[0][0]).to.eql(test_operation);
		expect(call_operation_function_as_await_stub.notCalled).to.be.true;
		opts_restore();
	}).timeout(TEST_TIMEOUT);
});
