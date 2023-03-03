'use strict';

const env_mangr = require('../../../utility/environment/environmentManager');
env_mangr.initTestEnvironment();
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs-extra');
const rewire = require('rewire');
const test_utils = require('../../test_utils');
const read_log = rewire('../../../utility/logging/readLog');
const hdb_terms = require('../../../utility/hdbTerms');
const harper_logger = require('../../../utility/logging/harper_logger');

const LOG_DIR_TEST = 'testLogger';
const LOG_NAME_TEST = 'log_unit_test.log';
const TEST_LOG_DIR = path.join(__dirname, LOG_DIR_TEST);
const FULL_LOG_PATH_TEST = path.join(TEST_LOG_DIR, LOG_NAME_TEST);

function logAllLevels(num) {
	fs.appendFileSync(
		FULL_LOG_PATH_TEST,
		`2023-03-02T21:52:1${num}.688Z [main/0 notify]: Howdy doody, they call me a notify log. I am used for unit testing.\n`
	);
	fs.appendFileSync(
		FULL_LOG_PATH_TEST,
		`2023-03-02T21:52:1${num}.688Z [main/0 fatal]: Howdy doody, they call me a fatal log. I am used for unit testing.\n`
	);
	fs.appendFileSync(
		FULL_LOG_PATH_TEST,
		`2023-03-02T21:52:1${num}.688Z [main/0 error]: Howdy doody, they call me a error log. I am used for unit testing.\n`
	);
	fs.appendFileSync(
		FULL_LOG_PATH_TEST,
		`2023-03-02T21:52:1${num}.688Z [main/0 warn]: Howdy doody, they call me a warn log. I am used for unit testing.\n`
	);
	fs.appendFileSync(
		FULL_LOG_PATH_TEST,
		`2023-03-02T21:52:1${num}.688Z [main/0 info]: Howdy doody, they call me a info log. I am used for unit testing.\n`
	);
	fs.appendFileSync(
		FULL_LOG_PATH_TEST,
		`2023-03-02T21:52:1${num}.688Z [main/0 debug]: Howdy doody, they call me a debug log. I am used for unit testing.\n`
	);
	fs.appendFileSync(
		FULL_LOG_PATH_TEST,
		`2023-03-02T21:52:1${num}.688Z [main/0 trace]: Howdy doody, they call me a trace log. I am used for unit testing.\n`
	);
}

function createTestLog() {
	fs.mkdirpSync(TEST_LOG_DIR);

	for (let x = 0; x < 5; x++) {
		logAllLevels(x);
	}
}

describe('Test readLog module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});

	describe('Test readLog function', () => {
		const validator_stub = sandbox.stub().returns(null);
		let validator_rw;

		before(async () => {
			await createTestLog();
			env_mangr.setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, TEST_LOG_DIR);
		});

		beforeEach(() => {
			validator_rw = read_log.__set__('validator', validator_stub);
		});

		after(() => {
			fs.removeSync(TEST_LOG_DIR);
		});

		afterEach(() => {
			sandbox.resetHistory();
			validator_rw();
		});

		it('Test bad request throws validation error', async () => {
			validator_rw();

			const test_request = {
				operation: 'read_log',
				start: 'pancake',
			};

			await test_utils.testHDBError(
				read_log(test_request),
				test_utils.generateHDBError("'start' must be a number", 400)
			);
		});

		it('Test no filter with correct number of logs returned', async () => {
			const test_request = {
				operation: 'read_log',
				log_name: LOG_NAME_TEST,
			};
			const result = await read_log(test_request);

			expect(result.length).to.equal(35);
		});

		it('Test if level, from, and until are defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'warn',
				from: '2023-03-02T21:52:10.688Z',
				until: '2023-03-02T21:52:12.688Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:11.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:12.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(3);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level, from, and until are defined, PLUS start, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				start: 2,
				level: 'fatal',
				from: '2023-03-02T21:52:10.688Z',
				until: '2023-03-02T21:52:12.688Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'fatal',
					message: 'Howdy doody, they call me a fatal log. I am used for unit testing.',
					tags: [],
					thread: 'main/0',
					timestamp: '2023-03-02T21:52:12.688Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(1);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and from are defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'trace',
				from: '2023-03-02T21:52:13.688Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'trace',
					message: 'Howdy doody, they call me a trace log. I am used for unit testing.',
					tags: [],
					thread: 'main/0',
					timestamp: '2023-03-02T21:52:13.688Z',
				},
				{
					level: 'trace',
					message: 'Howdy doody, they call me a trace log. I am used for unit testing.',
					tags: [],
					thread: 'main/0',
					timestamp: '2023-03-02T21:52:14.688Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(2);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and from are defined, PLUS start, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				start: 1,
				level: 'trace',
				from: '2023-03-02T21:52:13.688Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'trace',
					message: 'Howdy doody, they call me a trace log. I am used for unit testing.',
					tags: [],
					thread: 'main/0',
					timestamp: '2023-03-02T21:52:14.688Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(1);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and until are defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'notify',
				until: '2023-03-02T21:52:11.688Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'notify',
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
					tags: [],
					thread: 'main/0',
					timestamp: '2023-03-02T21:52:10.688Z',
				},
				{
					level: 'notify',
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
					tags: [],
					thread: 'main/0',
					timestamp: '2023-03-02T21:52:11.688Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(2);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and until are defined, PLUS count and start, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'error',
				until: '2023-03-02T21:52:13.688Z',
				limit: 1,
				start: 2,
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'error',
					message: 'Howdy doody, they call me a error log. I am used for unit testing.',
					tags: [],
					thread: 'main/0',
					timestamp: '2023-03-02T21:52:12.688Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(1);
			expect(result).to.eql(expected_logs);
		});

		it('Test if from and until are defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				from: '2023-03-02T21:52:13.700Z',
				until: '2023-03-02T21:52:14.688Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'fatal',
					tags: [],
					message: 'Howdy doody, they call me a fatal log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'error',
					tags: [],
					message: 'Howdy doody, they call me a error log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'info',
					tags: [],
					message: 'Howdy doody, they call me a info log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'debug',
					tags: [],
					message: 'Howdy doody, they call me a debug log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'trace',
					tags: [],
					message: 'Howdy doody, they call me a trace log. I am used for unit testing.',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(7);
			expect(result).to.eql(expected_logs);
		});

		it('Test if from and until are defined, PLUS limit, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				from: '2023-03-02T21:52:13.700Z',
				until: '2023-03-02T21:52:14.688Z',
				limit: 4,
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'fatal',
					tags: [],
					message: 'Howdy doody, they call me a fatal log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'error',
					tags: [],
					message: 'Howdy doody, they call me a error log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
			];
			const result = await read_log(test_request);

			expect(result.length).to.equal(4);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level is defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'warn',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:11.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:12.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:13.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(5);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level is defined, PLUS desc order, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'notify',
				order: 'desc',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:13.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:12.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:11.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(5);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level is defined, PLUS asc order, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'notify',
				order: 'asc',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:11.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:12.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:13.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:14.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(5);
			expect(result).to.eql(expected_logs);
		});

		it('Test if there are no logs for the given parameters, empty array returned', async () => {
			const test_request = {
				operation: 'read_log',
				from: '2021-06-06T01:06:05.000Z',
				until: '2021-08-06T01:06:05.000Z',
				log_name: LOG_NAME_TEST,
			};

			const result = await read_log(test_request);

			expect(result).to.be.empty;
		});

		it('Test if until is defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				until: '2023-03-02T21:52:11.687Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'notify',
					tags: [],
					message: 'Howdy doody, they call me a notify log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'fatal',
					tags: [],
					message: 'Howdy doody, they call me a fatal log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'error',
					tags: [],
					message: 'Howdy doody, they call me a error log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'warn',
					tags: [],
					message: 'Howdy doody, they call me a warn log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'info',
					tags: [],
					message: 'Howdy doody, they call me a info log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'debug',
					tags: [],
					message: 'Howdy doody, they call me a debug log. I am used for unit testing.',
				},
				{
					timestamp: '2023-03-02T21:52:10.688Z',
					thread: 'main/0',
					level: 'trace',
					tags: [],
					message: 'Howdy doody, they call me a trace log. I am used for unit testing.',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(7);
			expect(result).to.eql(expected_logs);
		});
	});

	describe('Test pushLineToResult function', () => {
		const test_line = {
			process_name: 'HarperDB',
			level: 'error',
			timestamp: '2022-01-06T22:38:51.374Z',
			message: 'Error calling operation: describeSchema',
		};
		const test_result = [];
		const pushLineToResult = read_log.__get__('pushLineToResult');
		const insert_descending_stub = sandbox.stub();
		const insert_ascending_stub = sandbox.stub();

		before(() => {
			read_log.__set__('insertDescending', insert_descending_stub);
			read_log.__set__('insertAscending', insert_ascending_stub);
		});

		it('Test if order is desc, line handled correctly', () => {
			pushLineToResult(test_line, 'desc', test_result);

			expect(insert_descending_stub.firstCall.args[0]).to.equal(test_line);
			expect(insert_descending_stub.firstCall.args[1]).to.equal(test_result);
		});

		it('Test if order is asc, line handled correctly', () => {
			pushLineToResult(test_line, 'asc', test_result);

			expect(insert_ascending_stub.firstCall.args[0]).to.equal(test_line);
			expect(insert_ascending_stub.firstCall.args[1]).to.equal(test_result);
		});

		it('Test line added to array if order not specified', () => {
			pushLineToResult(test_line, undefined, test_result);

			expect(test_result).to.include(test_line);
		});
	});

	describe('Test insertDescending and insertAscending functions', () => {
		const test_value_older = {
			process_name: 'HarperDB',
			level: 'error',
			timestamp: '2022-03-03T03:03:03.000Z',
			message: 'Error calling operation: describeSchema',
		};
		const test_value_old = {
			process_name: 'HarperDB',
			level: 'error',
			timestamp: '2022-05-05T05:05:05.000Z',
			message: 'Error calling operation: describeSchema',
		};
		const test_value_oldest = {
			process_name: 'HarperDB',
			level: 'error',
			timestamp: '2022-02-02T02:02:02.000Z',
			message: 'Error calling operation: describeSchema',
		};
		const test_value = {
			process_name: 'HarperDB',
			level: 'error',
			timestamp: '2022-04-04T04:04:04.000Z',
			message: 'Error calling operation: describeSchema',
		};

		const insertDescending = read_log.__get__('insertDescending');
		const insertAscending = read_log.__get__('insertAscending');

		it('Test insertDescending adds value to array in correct position', () => {
			const test_result = [];

			insertDescending(test_value, test_result);
			insertDescending(test_value_older, test_result);
			insertDescending(test_value_oldest, test_result);
			insertDescending(test_value_old, test_result);

			expect(test_result[0]).to.eql(test_value_old);
			expect(test_result[1]).to.eql(test_value);
			expect(test_result[2]).to.eql(test_value_older);
			expect(test_result[3]).to.eql(test_value_oldest);
		});

		it('Test insertAscending adds value to array in correct position', () => {
			const test_result = [];

			insertAscending(test_value, test_result);
			insertAscending(test_value_older, test_result);
			insertAscending(test_value_oldest, test_result);
			insertAscending(test_value_old, test_result);

			expect(test_result[0]).to.eql(test_value_oldest);
			expect(test_result[1]).to.eql(test_value_older);
			expect(test_result[2]).to.eql(test_value);
			expect(test_result[3]).to.eql(test_value_old);
		});
	});
});
