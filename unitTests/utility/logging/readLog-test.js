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

function logAllLevels(num, stream) {
	stream.write(
		`{"process_name": "unit-tests", "level": "notify", "timestamp": "2022-01-06T01:01:0${num}.000Z", "message": "notify log ${num}"}\n`
	);
	stream.write(
		`{"process_name": "unit-tests", "level": "fatal", "timestamp": "2022-02-06T01:02:0${num}.000Z", "message": "fatal log ${num}"}\n`
	);
	stream.write(
		`{"process_name": "unit-tests", "level": "error", "timestamp": "2022-03-06T01:03:0${num}.000Z", "message": "error log ${num}"}\n`
	);
	stream.write('This is a non json string\n');
	stream.write(
		`{"process_name": "unit-tests", "level": "warn", "timestamp": "2022-04-06T01:04:0${num}.000Z", "message": "warn log ${num}"}\n`
	);
	stream.write(
		`{"process_name": "unit-tests", "level": "info", "timestamp": "2022-05-06T01:05:0${num}.000Z", "message": "info log ${num}"}\n`
	);
	stream.write(
		`{"process_name": "unit-tests", "level": "debug", "timestamp": "2022-06-06T01:06:0${num}.000Z", "message": "debug log ${num}"}\n`
	);
	stream.write(
		`{"process_name": "unit-tests", "level": "trace", "timestamp": "2022-07-06T01:07:0${num}.000Z", "message": "trace log ${num}"}\n`
	);
}

function createTestLog() {
	fs.mkdirpSync(TEST_LOG_DIR);
	const write_stream = fs.createWriteStream(FULL_LOG_PATH_TEST);

	for (let x = 0; x < 5; x++) {
		logAllLevels(x + 1, write_stream);
	}
	write_stream.end();
}

describe('Test readLog module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});

	describe('Test readLog function', () => {
		const validator_stub = sandbox.stub().returns(null);
		let validator_rw;

		before(() => {
			createTestLog();
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

		it('Test readlog skips non json lines', async () => {
			const warn_stub = sandbox.stub(harper_logger, 'warn');

			const test_request = {
				operation: 'read_log',
				log_name: LOG_NAME_TEST,
			};
			await read_log(test_request);

			expect(warn_stub.callCount).to.equal(5);
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
				level: 'fatal',
				from: '2022-01-06T01:01:01.000Z',
				until: '2022-03-06T01:03:06.000Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:01.000Z',
					message: 'fatal log 1',
				},
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:02.000Z',
					message: 'fatal log 2',
				},
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:03.000Z',
					message: 'fatal log 3',
				},
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:04.000Z',
					message: 'fatal log 4',
				},
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:05.000Z',
					message: 'fatal log 5',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(5);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level, from, and until are defined, PLUS start, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				start: 2,
				level: 'fatal',
				from: '2022-01-06T01:01:01.000Z',
				until: '2022-03-06T01:03:06.000Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:03.000Z',
					message: 'fatal log 3',
				},
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:04.000Z',
					message: 'fatal log 4',
				},
				{
					process_name: 'unit-tests',
					level: 'fatal',
					timestamp: '2022-02-06T01:02:05.000Z',
					message: 'fatal log 5',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(3);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and from are defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'trace',
				from: '2022-07-06T01:07:02.900Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					process_name: 'unit-tests',
					level: 'trace',
					timestamp: '2022-07-06T01:07:03.000Z',
					message: 'trace log 3',
				},
				{
					process_name: 'unit-tests',
					level: 'trace',
					timestamp: '2022-07-06T01:07:04.000Z',
					message: 'trace log 4',
				},
				{
					process_name: 'unit-tests',
					level: 'trace',
					timestamp: '2022-07-06T01:07:05.000Z',
					message: 'trace log 5',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(3);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and from are defined, PLUS start, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				start: 1,
				level: 'trace',
				from: '2022-07-06T01:07:03.000Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					process_name: 'unit-tests',
					level: 'trace',
					timestamp: '2022-07-06T01:07:04.000Z',
					message: 'trace log 4',
				},
				{
					process_name: 'unit-tests',
					level: 'trace',
					timestamp: '2022-07-06T01:07:05.000Z',
					message: 'trace log 5',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(2);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and until are defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'error',
				until: '2022-03-06T01:03:04.100Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					process_name: 'unit-tests',
					level: 'error',
					timestamp: '2022-03-06T01:03:01.000Z',
					message: 'error log 1',
				},
				{
					process_name: 'unit-tests',
					level: 'error',
					timestamp: '2022-03-06T01:03:02.000Z',
					message: 'error log 2',
				},
				{
					process_name: 'unit-tests',
					level: 'error',
					timestamp: '2022-03-06T01:03:03.000Z',
					message: 'error log 3',
				},
				{
					process_name: 'unit-tests',
					level: 'error',
					timestamp: '2022-03-06T01:03:04.000Z',
					message: 'error log 4',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(4);
			expect(result).to.eql(expected_logs);
		});

		it('Test if level and until are defined, PLUS count and start, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				level: 'error',
				until: '2022-03-06T01:03:04.200Z',
				count: 1,
				start: 2,
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					process_name: 'unit-tests',
					level: 'error',
					timestamp: '2022-03-06T01:03:03.000Z',
					message: 'error log 3',
				},
				{
					process_name: 'unit-tests',
					level: 'error',
					timestamp: '2022-03-06T01:03:04.000Z',
					message: 'error log 4',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(2);
			expect(result).to.eql(expected_logs);
		});

		it('Test if from and until are defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				from: '2022-03-06T01:03:04.000Z',
				until: '2022-05-06T01:05:03.000Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'warn',
					message: 'warn log 1',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:01.000Z',
				},
				{
					level: 'info',
					message: 'info log 1',
					process_name: 'unit-tests',
					timestamp: '2022-05-06T01:05:01.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 2',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:02.000Z',
				},
				{
					level: 'info',
					message: 'info log 2',
					process_name: 'unit-tests',
					timestamp: '2022-05-06T01:05:02.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 3',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:03.000Z',
				},
				{
					level: 'info',
					message: 'info log 3',
					process_name: 'unit-tests',
					timestamp: '2022-05-06T01:05:03.000Z',
				},
				{
					level: 'error',
					message: 'error log 4',
					process_name: 'unit-tests',
					timestamp: '2022-03-06T01:03:04.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 4',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:04.000Z',
				},
				{
					level: 'error',
					message: 'error log 5',
					process_name: 'unit-tests',
					timestamp: '2022-03-06T01:03:05.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 5',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:05.000Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(10);
			expect(result).to.eql(expected_logs);
		});

		it('Test if from and until are defined, PLUS limit, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				from: '2022-03-06T01:03:04.000Z',
				until: '2022-05-06T01:05:03.000Z',
				limit: 4,
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'warn',
					message: 'warn log 1',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:01.000Z',
				},
				{
					level: 'info',
					message: 'info log 1',
					process_name: 'unit-tests',
					timestamp: '2022-05-06T01:05:01.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 2',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:02.000Z',
				},
				{
					level: 'info',
					message: 'info log 2',
					process_name: 'unit-tests',
					timestamp: '2022-05-06T01:05:02.000Z',
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
					level: 'warn',
					message: 'warn log 1',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:01.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 2',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:02.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 3',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:03.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 4',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:04.000Z',
				},
				{
					level: 'warn',
					message: 'warn log 5',
					process_name: 'unit-tests',
					timestamp: '2022-04-06T01:04:05.000Z',
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
					level: 'notify',
					message: 'notify log 5',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:05.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 4',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:04.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 3',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:03.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 2',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:02.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 1',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:01.000Z',
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
					level: 'notify',
					message: 'notify log 1',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:01.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 2',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:02.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 3',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:03.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 4',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:04.000Z',
				},
				{
					level: 'notify',
					message: 'notify log 5',
					process_name: 'unit-tests',
					timestamp: '2022-01-06T01:01:05.000Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(5);
			expect(result).to.eql(expected_logs);
		});

		it('Test if from is defined, correct results are returned', async () => {
			const test_request = {
				operation: 'read_log',
				from: '2022-06-06T01:06:05.000Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{
					level: 'trace',
					message: 'trace log 1',
					process_name: 'unit-tests',
					timestamp: '2022-07-06T01:07:01.000Z',
				},
				{
					level: 'trace',
					message: 'trace log 2',
					process_name: 'unit-tests',
					timestamp: '2022-07-06T01:07:02.000Z',
				},
				{
					level: 'trace',
					message: 'trace log 3',
					process_name: 'unit-tests',
					timestamp: '2022-07-06T01:07:03.000Z',
				},
				{
					level: 'trace',
					message: 'trace log 4',
					process_name: 'unit-tests',
					timestamp: '2022-07-06T01:07:04.000Z',
				},
				{
					level: 'debug',
					message: 'debug log 5',
					process_name: 'unit-tests',
					timestamp: '2022-06-06T01:06:05.000Z',
				},
				{
					level: 'trace',
					message: 'trace log 5',
					process_name: 'unit-tests',
					timestamp: '2022-07-06T01:07:05.000Z',
				},
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(6);
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
				until: '2022-01-06T01:01:02.000Z',
				log_name: LOG_NAME_TEST,
			};

			const expected_logs = [
				{ process_name: 'unit-tests', level: 'notify', timestamp: '2022-01-06T01:01:01.000Z', message: 'notify log 1' },
				{ process_name: 'unit-tests', level: 'notify', timestamp: '2022-01-06T01:01:02.000Z', message: 'notify log 2' },
			];

			const result = await read_log(test_request);

			expect(result.length).to.equal(2);
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
