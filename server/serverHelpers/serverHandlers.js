'use strict';

const terms = require('../../utility/hdbTerms');
const hdb_util = require('../../utility/common_utils');
const harper_logger = require('../../utility/logging/harper_logger');
const { handleHDBError, hdb_errors } = require('../../utility/errors/hdbError');
const { isMainThread } = require('worker_threads');
const { Readable } = require('stream');

const os = require('os');
const util = require('util');

const auth = require('../../security/fastifyAuth');
const p_authorize = util.promisify(auth.authorize);
const server_utilities = require('./serverUtilities');
const { createGzip, constants } = require('zlib');

const NO_AUTH_OPERATIONS = [
	terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS,
	terms.OPERATIONS_ENUM.LOGIN,
	terms.OPERATIONS_ENUM.LOGOUT,
];

function handleServerUncaughtException(err) {
	let message = `Found an uncaught exception with message: ${err.message}. ${os.EOL}Stack: ${err.stack} ${
		os.EOL
	}Terminating ${isMainThread ? 'HDB' : 'thread'}.`;
	console.error(message);
	harper_logger.fatal(message);
	process.exit(1);
}

function serverErrorHandler(error, req, resp) {
	harper_logger[error.logLevel || 'error'](error);
	if (error.statusCode) {
		if (typeof error.http_resp_msg !== 'object') {
			return resp.code(error.statusCode).send({ error: error.http_resp_msg || error.message });
		}
		return resp.code(error.statusCode).send(error.http_resp_msg);
	}
	const statusCode = error.statusCode ? error.statusCode : hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
	if (typeof error === 'string') {
		return resp.code(statusCode).send({ error: error });
	}
	return resp.code(statusCode).send(error.message ? { error: error.message } : error);
}

function reqBodyValidationHandler(req, resp, done) {
	if (!req.body || Object.keys(req.body).length === 0 || typeof req.body !== 'object') {
		const validation_err = handleHDBError(new Error(), 'Invalid JSON.', hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST);
		done(validation_err, null);
	}
	if (hdb_util.isEmpty(req.body.operation)) {
		const validation_err = handleHDBError(
			new Error(),
			"Request body must include an 'operation' property.",
			hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST
		);
		done(validation_err, null);
	}
	done();
}

function authHandler(req, resp, done) {
	let user;

	const isAuthOperation = !NO_AUTH_OPERATIONS.includes(req.body.operation);
	if (
		// If create token is called without username/password in the body it needs to be authorized
		(req.body.operation === terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS &&
			!req.body.username &&
			!req.body.password) ||
		isAuthOperation
	) {
		p_authorize(req, resp)
			.then((user_data) => {
				user = user_data;
				req.body.hdb_user = user;
				req.body.hdb_auth_header = req.headers.authorization;
				done();
			})
			.catch((err) => {
				harper_logger.warn(err);
				harper_logger.warn(`{"ip":"${req.socket.remoteAddress}", "error":"${err.stack}"`);
				let err_msg = typeof err === 'string' ? { error: err } : { error: err.message };
				done(handleHDBError(err, err_msg, hdb_errors.HTTP_STATUS_CODES.UNAUTHORIZED), null);
			});
	} else {
		req.body.hdb_user = null;
		req.body.hdb_auth_header = req.headers.authorization;
		req.body.baseRequest = req.raw?.baseRequest;
		req.body.baseResponse = resp.raw?.baseResponse;
		req.body.fastifyResponse = resp;
		done();
	}
}

async function handlePostRequest(req, res, bypass_auth = false) {
	let operation_function;

	try {
		// Just in case someone tries to bypass auth
		if (req.body.bypass_auth) delete req.body.bypass_auth;

		operation_function = server_utilities.chooseOperation(req.body);
		let result = await server_utilities.processLocalTransaction(req, operation_function);
		if (result instanceof Readable && result.headers) {
			for (let [name, value] of result.headers) {
				res.header(name, value);
			}
			// fastify-compress has one job. I don't know why it can't do it. So we compress here to
			// handle the case of returning a stream
			if (req.headers['accept-encoding']?.includes('gzip')) {
				res.header('content-encoding', 'gzip');
				result = result.pipe(createGzip({ level: constants.Z_BEST_SPEED })); // go fast
			}
		}
		return result;
	} catch (error) {
		harper_logger.error(error);
		throw error;
	}
}

module.exports = {
	authHandler,
	handlePostRequest,
	handleServerUncaughtException,
	serverErrorHandler,
	reqBodyValidationHandler,
};
