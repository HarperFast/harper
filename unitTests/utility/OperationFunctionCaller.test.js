'use strict';
// LEAVING THESE IN AND COMMENTED OUT TO FACILITATE FIXING CORE-471.  When these are uncommented, mocha will hang
// after the tests complete.  The tests will hang even if we only import testUtils, preTestPrep does not need to be invoked.
//const testUtils = require('../testUtils.js');
//testUtils.preTestPrep();
const assert = require('assert');
const op_func_caller = require('#src/utility/OperationFunctionCaller');
const hdb_logger = require('#src/utility/logging/harper_logger');
const { promisify } = require('util');

class TestInputObject {
	constructor() {
		this.was_run = false;
		this.followup_run = false;
	}
}

function test_function_as_callback(input, callback) {
	input.was_run = true;
	callback(null, input);
}

const p_test_function = promisify(test_function_as_callback);

async function followup_function(input) {
	input.followup_run = true;
	return input;
}

describe(`Test callOperationFunctionAsAwait`, function () {
	it('Nominal with no followup function, expect pass', async function () {
		let test_input = new TestInputObject();
		let result = await op_func_caller.callOperationFunctionAsAwait(p_test_function, test_input, null);
		assert.strictEqual(result.was_run, true);
		assert.strictEqual(result.followup_run, false);
		return true;
	});

	it('Nominal with followup function, expect pass', async function () {
		let test_input = new TestInputObject();
		let result = await op_func_caller.callOperationFunctionAsAwait(p_test_function, test_input, followup_function);
		assert.strictEqual(result.was_run, true);
		assert.strictEqual(result.followup_run, true);
	});

	it('Error in test function, expect exception & followup not run', async function () {
		let test_func_exception = async function (_input) {
			throw new Error('This is bad!');
		};
		let test_input = new TestInputObject();
		let res = undefined;
		try {
			res = await op_func_caller.callOperationFunctionAsAwait(test_func_exception, test_input, followup_function);
		} catch (err) {
			res = err;
		} finally {
			assert.strictEqual(res instanceof Error, true);
			assert.strictEqual(test_input.followup_run, false);
		}
	});

	it('Error in followup function, expect exception & was_run to be true', async function () {
		let followup_func_exception = async function (_input) {
			throw new Error('This is bad!');
		};
		let test_input = new TestInputObject();
		let res = undefined;
		try {
			res = await op_func_caller.callOperationFunctionAsAwait(p_test_function, test_input, followup_func_exception);
		} catch (err) {
			res = err;
		} finally {
			assert.strictEqual(res instanceof Error, true);
			assert.strictEqual(test_input.followup_run, false);
			assert.strictEqual(test_input.was_run, true);
		}
	});

	it('Pass invalid function, expect exception', async function () {
		let test_input = new TestInputObject();
		let res = undefined;
		try {
			res = await op_func_caller.callOperationFunctionAsAwait(null, test_input, null);
		} catch (err) {
			res = err;
		} finally {
			assert.strictEqual(res instanceof Error, true);
			assert.strictEqual(test_input.followup_run, false);
			assert.strictEqual(test_input.was_run, false);
		}
	});

	it('Pass variable instead of function, expect exception', async function () {
		let not_a_function = 'blah blah';
		let test_input = new TestInputObject();
		let res = undefined;
		try {
			res = await op_func_caller.callOperationFunctionAsAwait(not_a_function, test_input, null);
		} catch (err) {
			res = err;
		} finally {
			assert.strictEqual(res instanceof Error, true);
			assert.strictEqual(test_input.followup_run, false);
			assert.strictEqual(test_input.was_run, false);
		}
	});

	describe('Logging an error carrying a structured http_resp_msg (harper#1982)', function () {
		let original_error;
		let logged_calls;

		beforeEach(function () {
			original_error = hdb_logger.error;
			logged_calls = [];
			hdb_logger.error = (...args) => logged_calls.push(args);
		});

		afterEach(function () {
			hdb_logger.error = original_error;
		});

		it('renders a full 200-line install capture, including a >10000-char line, without flattening or truncating it', async function () {
			const lines = [];
			for (let i = 0; i < 199; i++) {
				lines.push({ manager: 'npm', stream: 'stderr', line: `npm error line ${i}` });
			}
			// createInstallCapture bounds the *total* capture to 16KB, not each line, so a single
			// line can legitimately be within a few bytes of that whole-capture cap.
			const long_line = `npm error boom ${'x'.repeat(10500)} end-of-long-line`;
			lines.push({ manager: 'npm', stream: 'stderr', line: long_line });

			const test_func_exception = async function () {
				const err = new Error('Failed to install dependencies for hdbms using npm default. Exit code: 1');
				err.http_resp_msg = {
					error: err.message,
					phase: 'prepare',
					install_output: { lines, truncated: false, dropped_lines: 0 },
					deployment_id: 'test-deployment-id',
				};
				throw err;
			};

			try {
				await op_func_caller.callOperationFunctionAsAwait(test_func_exception, new TestInputObject(), null);
				assert.fail('expected callOperationFunctionAsAwait to reject');
			} catch {
				// expected - the structured error is rethrown after being logged
			}

			// Proves the reassigned hdb_logger.error is the same function callOperationFunctionAsAwait
			// invokes (not a different export) - if it weren't, logged_calls would still be empty here.
			assert.ok(logged_calls.length >= 2, `expected the error label and payload to both be logged, got: ${logged_calls}`);
			assert.ok(
				logged_calls[0].join(' ').includes('Error calling operation:'),
				`expected the first logged call to be the operation-error label, got: ${logged_calls[0]}`
			);

			const logged = logged_calls.map((call_args) => call_args.join(' ')).join('\n');
			assert.ok(!logged.includes('[Object]'), `logged output flattened a nested object: ${logged}`);
			assert.ok(!logged.includes('more item'), `logged output truncated the lines array: ${logged}`);
			assert.ok(!logged.includes('more character'), `logged output truncated a long line: ${logged}`);
			assert.ok(logged.includes('npm error line 198'), 'logged output is missing the last short line');
			assert.ok(logged.includes('end-of-long-line'), 'logged output is missing the tail of the long line');
		});

		it('passes an Error-valued http_resp_msg to log.error unchanged instead of inspecting it raw (#1734)', async function () {
			const http_error = new Error('upstream boom');
			http_error.secretHeader = 'do-not-leak-me';
			const test_func_exception = async function () {
				const err = new Error('operation failed');
				err.http_resp_msg = http_error;
				throw err;
			};

			try {
				await op_func_caller.callOperationFunctionAsAwait(test_func_exception, new TestInputObject(), null);
				assert.fail('expected callOperationFunctionAsAwait to reject');
			} catch {
				// expected - the structured error is rethrown after being logged
			}

			assert.ok(logged_calls.length >= 2, `expected the error label and payload to both be logged, got: ${logged_calls}`);
			// If OperationFunctionCaller inspected http_resp_msg directly instead of routing it through
			// log.error, this would instead be a pre-formatted string with secretHeader dumped raw into
			// it (the #1734 regression) - the real logger's own sanitizeErrorArgs/errorForLog (covered by
			// harper_logger.test.js) is what's responsible for stripping it before this reaches the log.
			assert.strictEqual(
				logged_calls[1][0],
				http_error,
				'expected the raw Error instance to be passed to log.error, not a pre-formatted string'
			);
		});

		it('routes a VM cross-realm Error-valued http_resp_msg unchanged too (#1734)', async function () {
			// Component code runs through node:vm, so a VM-created Error fails `instanceof Error`
			// against this realm's Error constructor even though it is one (harper#1982 review).
			const vm = require('vm');
			const vm_error = vm.runInNewContext('new Error("vm upstream boom")');
			assert.strictEqual(vm_error instanceof Error, false, 'precondition: cross-realm Error fails instanceof');

			const test_func_exception = async function () {
				const err = new Error('operation failed');
				err.http_resp_msg = vm_error;
				throw err;
			};

			try {
				await op_func_caller.callOperationFunctionAsAwait(test_func_exception, new TestInputObject(), null);
				assert.fail('expected callOperationFunctionAsAwait to reject');
			} catch {
				// expected - the structured error is rethrown after being logged
			}

			assert.ok(logged_calls.length >= 2, `expected the error label and payload to both be logged, got: ${logged_calls}`);
			assert.strictEqual(
				logged_calls[1][0],
				vm_error,
				'expected the raw VM Error instance to be passed to log.error, not a pre-formatted string'
			);
		});
	});
});
