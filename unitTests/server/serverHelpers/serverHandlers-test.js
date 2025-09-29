'use strict';

const test_utils = require('../../test_utils');
test_utils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const rewire = require('rewire');

const serverHandlers_rw = rewire('../../../server/serverHelpers/serverHandlers');
const auth = require('../../../security/fastifyAuth');
const serverUtilities = require('../../../server/serverHelpers/serverUtilities');
const logger = require('../../../utility/logging/harper_logger');
const { handleHDBError, hdbErrors } = require('../../../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdbErrors;

let console_stub;
let process_exit_stub;
let error_log_stub;
let warn_log_stub;
let fatal_log_stub;
let info_log_stub;
let choose_op_stub;
let process_local_trans_stub;
let final_logger_fatal_stub;
let final_logger_error_stub;
let final_logger_info_stub;

const TEST_ERR = new Error('This is a narly error');

class TestMockResp {
	constructor() {
		this.status_code = null;
		this.msg = null;
	}

	code(val) {
		this.status_code = val;
		return this;
	}

	send(val) {
		this.msg = val;
		return this;
	}
}

function setupSandbox() {
	console_stub = sandbox.stub(console, 'error').callsFake(() => {});
	error_log_stub = sandbox.stub(logger, 'error').callsFake(() => {});
	warn_log_stub = sandbox.stub(logger, 'warn').callsFake(() => {});
	fatal_log_stub = sandbox.stub(logger, 'fatal').callsFake(() => {});
	info_log_stub = sandbox.stub(logger, 'info').callsFake(() => {});
}

function testCallBack(err, data) {
	if (err) {
		throw err;
	}
	return data;
}

describe('Test serverHandlers.js module ', () => {
	before(() => {
		setupSandbox();
		serverHandlers_rw.__set__('os', { EOL: '\n' });
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
		rewire('../../../server/serverHelpers/serverHandlers');
	});

	describe('handleServerUncaughtException()', () => {
		it('Should send error to console and log before exiting process', () => {
			process_exit_stub = sandbox.stub(process, 'exit').callsFake(() => {});
			serverHandlers_rw.handleServerUncaughtException(TEST_ERR);

			assert.ok(console_stub.calledOnce === true, 'Error should be sent to console as an error');
			assert.ok(
				console_stub.args[0][0].includes(TEST_ERR.message) === true,
				'Error should be passed to console.error()'
			);
			assert.ok(fatal_log_stub.calledOnce === true, 'Error should be logged as fatal');
			assert.ok(
				fatal_log_stub.args[0][0].includes(TEST_ERR.message) === true,
				'Error should be passed to logger.fatal()'
			);
			assert.ok(process_exit_stub.calledOnce === true, 'Error should cause process to exit');
			assert.ok(process_exit_stub.args[0][0] === 1, 'Process should exit with exit code 1');

			process_exit_stub.restore();
		});
	});

	describe('serverErrorHandler()', () => {
		it('Should send a response with error message and 500 code when an plain Error is passed', () => {
			const test_result = serverHandlers_rw.serverErrorHandler(TEST_ERR, {}, new TestMockResp());

			assert.ok(test_result.status_code === HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'Resp status code should be 500');
			assert.ok(test_result.msg.error === TEST_ERR.message, 'Resp message should equal error message');
		});

		it('Should send a response with custom error message and 400 code when included in error passed', () => {
			const test_error = test_utils.deepClone(TEST_ERR);
			test_error.statusCode = 400;
			test_error.http_resp_msg = 'Custom error message!';

			const test_result = serverHandlers_rw.serverErrorHandler(test_error, {}, new TestMockResp());

			assert.ok(test_result.status_code === 400, 'Resp status code should be 400');
			assert.ok(test_result.msg.error === test_error.http_resp_msg, 'Resp message should equal custom error message');
		});

		it('Should send a response with custom error message object and 400 code when included in error passed', () => {
			const test_error = test_utils.deepClone(TEST_ERR);
			test_error.statusCode = 400;
			test_error.http_resp_msg = { blah: 'Custom error message!' };

			const test_result = serverHandlers_rw.serverErrorHandler(test_error, {}, new TestMockResp());

			assert.ok(test_result.status_code === 400, 'Resp status code should be 400');
			assert.ok(test_result.msg === test_error.http_resp_msg, 'Resp message should equal custom error message object');
		});

		it('Should send a response with custom error message object when included in standard error type passed', () => {
			const test_error = test_utils.deepClone(TEST_ERR);
			test_error.message = { blah: 'Custom error message!' };

			const test_result = serverHandlers_rw.serverErrorHandler(test_error, {}, new TestMockResp());

			assert.ok(test_result.status_code === 500, 'Resp status code should be 500');
			assert.ok(test_result.msg.error === test_error.message, 'Resp message should equal custom error message object');
		});

		it('Should send a response with custom message object when included when an object is passed', () => {
			const test_error = { blah: 'Custom error message!' };

			const test_result = serverHandlers_rw.serverErrorHandler(test_error, {}, new TestMockResp());

			assert.ok(test_result.status_code === 500, 'Resp status code should be 500');
			assert.ok(test_result.msg === test_error, 'Resp message should equal custom object');
		});

		it('Should handle error passed as a string', () => {
			const test_error = 'Custom error message!';

			const test_result = serverHandlers_rw.serverErrorHandler(test_error, {}, new TestMockResp());

			assert.ok(test_result.status_code === 500, 'Resp status code should be 500');
			assert.ok(test_result.msg.error === test_error, 'Resp error message should equal string value');
		});
	});

	describe('reqBodyValidationHandler()', () => {
		it('Should not reject if request is valid', () => {
			const test_req = { body: { operation: 'create_schema' } };
			let test_result;

			try {
				test_result = serverHandlers_rw.reqBodyValidationHandler(test_req, {}, testCallBack);
			} catch (err) {
				test_result = err;
			}

			assert.ok(test_result === undefined, 'Method should return null value for passing scenario');
		});

		it('Should throw error if request has no body', () => {
			const test_req = {};
			let test_result;

			try {
				test_result = serverHandlers_rw.reqBodyValidationHandler(test_req, {}, testCallBack);
			} catch (err) {
				test_result = err;
			}

			assert.ok(
				test_result.statusCode === HTTP_STATUS_CODES.BAD_REQUEST,
				'Method should throw error w/ BAD_REQUEST code'
			);
			assert.ok(test_result.http_resp_msg === 'Invalid JSON.', 'Method should throw error for invalid JSON');
		});

		it('Should throw error if request includes an empty body object', () => {
			const test_req = { body: {} };
			let test_result;

			try {
				test_result = serverHandlers_rw.reqBodyValidationHandler(test_req, {}, testCallBack);
			} catch (err) {
				test_result = err;
			}

			assert.ok(
				test_result.statusCode === HTTP_STATUS_CODES.BAD_REQUEST,
				'Method should throw error w/ BAD_REQUEST code'
			);
			assert.ok(test_result.http_resp_msg === 'Invalid JSON.', 'Method should throw error for invalid JSON');
		});

		it('Should throw error if request body is a string/not valid JSON', () => {
			const test_req = { body: 'Operation: create_schema' };
			let test_result;

			try {
				test_result = serverHandlers_rw.reqBodyValidationHandler(test_req, {}, testCallBack);
			} catch (err) {
				test_result = err;
			}

			assert.ok(
				test_result.statusCode === HTTP_STATUS_CODES.BAD_REQUEST,
				'Method should throw error w/ BAD_REQUEST code'
			);
			assert.ok(test_result.http_resp_msg === 'Invalid JSON.', 'Method should throw error for invalid JSON');
		});

		it('Should throw error if request body does not include an `operation` property', () => {
			const test_req = { body: { schema: 'new schema value' } };
			let test_result;

			try {
				test_result = serverHandlers_rw.reqBodyValidationHandler(test_req, {}, testCallBack);
			} catch (err) {
				test_result = err;
			}

			assert.ok(
				test_result.statusCode === HTTP_STATUS_CODES.BAD_REQUEST,
				'Method should throw error w/ BAD_REQUEST code'
			);
			assert.ok(
				test_result.http_resp_msg === "Request body must include an 'operation' property.",
				'Method should throw error for JSON body without operation property'
			);
		});

		it('Should throw error if request body does not include an value in its `operation` property', () => {
			const test_req = { body: { operation: null } };
			let test_result;

			try {
				test_result = serverHandlers_rw.reqBodyValidationHandler(test_req, {}, testCallBack);
			} catch (err) {
				test_result = err;
			}

			assert.ok(
				test_result.statusCode === HTTP_STATUS_CODES.BAD_REQUEST,
				'Method should throw error w/ BAD_REQUEST code'
			);
			assert.ok(
				test_result.http_resp_msg === "Request body must include an 'operation' property.",
				'Method should throw error for JSON body without operation property'
			);
		});
	});

	describe('authHandler()', () => {
		const TEST_AUTH_REQ = {
			headers: {
				authorization: 'BASIC hashyhash',
			},
			body: {
				operation: 'create_authentication_tokens',
			},
		};

		const TEST_REQ = {
			headers: {
				authorization: 'BASIC hashyhash',
			},
			body: {
				operation: 'create_schema',
			},
		};
		let auth_stub;
		let TEST_USER = 'This is user data!';

		before(() => {
			auth_stub = sandbox.stub().resolves(TEST_USER);
			serverHandlers_rw.__set__('pAuthorize', auth_stub);
		});

		it('Should pass auth for valid nominal request', () => {
			const test_req = test_utils.deepClone(TEST_REQ);

			serverHandlers_rw.authHandler(test_req, {}, (err, data) => {
				assert.ok(data === undefined, 'Should not return anything for valid auth');
				assert.ok(test_req.body.hdb_user === TEST_USER, 'Method should assign user to request body');
			});
		});

		it('Should pass auth for valid request for create auth tokens operation', () => {
			const test_req = test_utils.deepClone(TEST_AUTH_REQ);
			test_req.body.username = 'norm';
			test_req.body.password = 'let-me-in';

			serverHandlers_rw.authHandler(test_req, {}, (err, data) => {
				assert.ok(data === undefined, 'Should not return anything for valid auth');
				assert.ok(test_req.body.hdb_user === null, 'Method should assign null for hdb_user on request body');
			});
		});

		it('Should throw error if thrown from auth', () => {
			auth_stub.rejects(TEST_ERR);

			const test_req = test_utils.deepClone(TEST_REQ);
			test_req.socket = { remoteAddress: 'remote address' };

			serverHandlers_rw.authHandler(test_req, {}, (err, data) => {
				assert.ok(data === null, 'Should not return anything for valid auth');
				assert.ok(err.statusCode === 401, 'Method should return an error with 401 status code');
				assert.ok(err.http_resp_msg.error === TEST_ERR.message, 'Method should return correct error message');

				assert.ok(warn_log_stub.calledTwice === true, 'Warning logged twice');
				assert.ok(warn_log_stub.firstCall.args[0] === TEST_ERR, 'Warning logged error');
				assert.ok(
					warn_log_stub.secondCall.args[0].includes(test_req.socket.remoteAddress) === true,
					'Warning logged error with socket remote address'
				);
			});
		});
	});

	describe('authAndEnsureUserOnRequest()', () => {
		const TEST_AUTH_REQ = {
			headers: {
				authorization: 'BASIC hashyhash',
			},
			body: {
				operation: 'create_authentication_tokens',
			},
		};

		const TEST_REQ = {
			headers: {
				authorization: 'BASIC hashyhash',
			},
			body: {
				operation: 'create_schema',
			},
		};
		let auth_stub;
		let TEST_USER = 'This is user data!';

		before(() => {
			auth_stub = sandbox.stub().resolves(TEST_USER);
			serverHandlers_rw.__set__('pAuthorize', auth_stub);
		});

		it('Should pass auth for valid nominal request', () => {
			const test_req = test_utils.deepClone(TEST_REQ);

			serverHandlers_rw.authAndEnsureUserOnRequest(test_req, {}, (err, data) => {
				assert.ok(data === undefined, 'Should not return anything for valid auth');
				assert.ok(test_req.hdb_user === TEST_USER, 'Method should assign user to request');
			});
		});

		it('Should pass auth for valid request for create auth tokens operation', () => {
			const test_req = test_utils.deepClone(TEST_AUTH_REQ);
			test_req.body.username = 'norm';
			test_req.body.password = 'let-me-in';

			serverHandlers_rw.authHandler(test_req, {}, (err, data) => {
				assert.ok(data === undefined, 'Should not return anything for valid auth');
				assert.ok(test_req.hdb_user === undefined, 'Method should assign undefined for hdb_user on request');
			});
		});

		it('Should throw error if thrown from auth', () => {
			auth_stub.rejects(TEST_ERR);

			const test_req = test_utils.deepClone(TEST_REQ);
			test_req.socket = { remoteAddress: 'remote address' };

			serverHandlers_rw.authHandler(test_req, {}, (err, data) => {
				assert.ok(data === null, 'Should not return anything for valid auth');
				assert.ok(err.statusCode === 401, 'Method should return an error with 401 status code');
				assert.ok(err.http_resp_msg.error === TEST_ERR.message, 'Method should return correct error message');

				assert.ok(warn_log_stub.calledTwice === true, 'Warning logged twice');
				assert.ok(warn_log_stub.firstCall.args[0] === TEST_ERR, 'Warning logged error');
				assert.ok(
					warn_log_stub.secondCall.args[0].includes(test_req.socket.remoteAddress) === true,
					'Warning logged error with socket remote address'
				);
			});
		});
	});

	describe('handlePostRequest()', () => {
		const test_op_result = 'op result';
		const test_op = 'chooseOperation';
		const test_req = { body: { operation: 'create_schema' } };

		before(() => {
			choose_op_stub = sandbox.stub(serverUtilities, 'chooseOperation').returns(test_op);
			process_local_trans_stub = sandbox.stub(serverUtilities, 'processLocalTransaction').resolves(test_op_result);
		});

		it('Should return the result from the operation function', async () => {
			let test_results;

			try {
				test_results = await serverHandlers_rw.handlePostRequest(test_req);
			} catch (err) {
				test_results = err;
			}

			assert.ok(test_results === test_op_result, 'Method should return the operation result');
		});

		it('Should call processLocalTransaction with result of chooseOperation', async () => {
			await serverHandlers_rw.handlePostRequest(test_req);

			assert.ok(choose_op_stub.calledOnce === true, 'chooseOperation should be called once');
			assert.ok(process_local_trans_stub.calledOnce === true, 'processLocalTransaction should be called once');
			assert.ok(
				process_local_trans_stub.args[0][1] === test_op,
				'processLocalTransaction should be called with result from chooseOperation'
			);
		});

		it('Should handle error thrown from chooseOperation', async () => {
			choose_op_stub.throws(TEST_ERR);
			let test_result;

			try {
				await serverHandlers_rw.handlePostRequest(test_req);
			} catch (err) {
				test_result = err;
			}

			assert.ok(test_result === TEST_ERR, 'Error from chooseOperation not thrown');
			assert.ok(process_local_trans_stub.calledOnce === false, 'processLocalTransaction should not have been called');
			assert.ok(error_log_stub.calledOnce === true, 'Error not logged');
			assert.ok(error_log_stub.args[0][0] === TEST_ERR, 'Error message not logged');
			choose_op_stub.resetBehavior();
		});

		it('Should handle error thrown from processLocalTransaction', async () => {
			process_local_trans_stub.throws(TEST_ERR);
			let test_result;

			try {
				await serverHandlers_rw.handlePostRequest(test_req);
			} catch (err) {
				test_result = err;
			}

			assert.ok(test_result === TEST_ERR, 'Error from chooseOperation not thrown');
			assert.ok(process_local_trans_stub.calledOnce === true, 'processLocalTransaction was not called');
			assert.ok(error_log_stub.calledOnce === true, 'Error not logged');
			assert.ok(error_log_stub.args[0][0] === TEST_ERR, 'Error message not logged');
		});
	});
});
