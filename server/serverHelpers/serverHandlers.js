'use strict';

const terms = require('../../utility/hdbTerms');
const hdb_util = require('../../utility/common_utils');
const harper_logger = require('../../utility/logging/harper_logger');
const { handleHDBError, hdb_errors } = require('../../utility/errors/hdbError');

const os = require('os');
const util = require('util');

const auth = require('../../security/auth');
const p_authorize = util.promisify(auth.authorize);
const server_utilities = require('./serverUtilities');

function handleServerUncaughtException(err) {
    let message = `Found an uncaught exception with message: ${err.message}. ${os.EOL}Stack: ${err.stack} ${os.EOL}Terminating HDB.`;
    console.error(message);
    const final_logger = harper_logger.finalLogger();
    final_logger.fatal(message);
    process.exit(1);
}

function handleBeforeExit() {
    const final_logger = harper_logger.finalLogger();
    final_logger.info('beforeExit caught');
    process.exit(0);
}

function handleExit() {
    const final_logger = harper_logger.finalLogger();
    final_logger.info('exit caught');
    process.exit(0);
}

function handleSigint() {
    const final_logger = harper_logger.finalLogger();
    final_logger.info('SIGINT caught');
    process.exit(0);
}

function handleSigquit() {
    const final_logger = harper_logger.finalLogger();
    final_logger.info('SIGQUIT caught');
    process.exit(0);
}

function handleSigterm() {
    const final_logger = harper_logger.finalLogger();
    final_logger.info('SIGTERM caught');
    process.exit(0);
}

function serverErrorHandler(error, req, resp) {
    if (error.http_resp_code) {
        if (typeof error.http_resp_msg === 'string') {
            return resp.code(error.http_resp_code).send({error: error.http_resp_msg});
        }
        return resp.code(error.http_resp_code).send(error.http_resp_msg);
    }
    const statusCode = error.statusCode ? error.statusCode : hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
    if (typeof error === 'string') {
        return resp.code(statusCode).send({error: error});
    }
    return resp.code(statusCode).send(error.message ? {error: error.message} : error);
}

function reqBodyValidationHandler(req, resp, done) {
    if (!req.body || Object.keys(req.body).length === 0 || typeof req.body !== 'object') {
        const validation_err = handleHDBError(new Error(), "Invalid JSON.", hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST);
        done(validation_err, null);
    }
    if (hdb_util.isEmpty(req.body.operation)) {
        const validation_err = handleHDBError(new Error(), "Request body must include an 'operation' property.", hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST);
        done(validation_err, null);
    }
    done();
}

function authHandler(req, resp, done) {
    let user;

    //create_authorization_tokens needs to not authorize
    if (req.body.operation !== terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS) {
        p_authorize(req, resp)
            .then(user_data => {
                user = user_data;
                req.body.hdb_user = user;
                req.body.hdb_auth_header = req.headers.authorization;
                done();
            })
            .catch(err => {
                harper_logger.warn(err);
                harper_logger.warn(`{"ip":"${req.socket.remoteAddress}", "error":"${err.stack}"`);
                let err_msg = typeof err === 'string' ? { error: err } : { error:err.message };
                done(handleHDBError(err, err_msg, hdb_errors.HTTP_STATUS_CODES.UNAUTHORIZED), null);
            });
    } else {
        req.body.hdb_user = null;
        req.body.hdb_auth_header = req.headers.authorization;
        done();
    }
}

async function handlePostRequest(req) {
    let operation_function;

    try {
        operation_function = server_utilities.chooseOperation(req.body);
        return server_utilities.processLocalTransaction(req, operation_function);
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
    handleBeforeExit,
    handleExit,
    handleSigint,
    handleSigquit,
    handleSigterm
};
