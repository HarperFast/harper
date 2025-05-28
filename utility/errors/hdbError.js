'use strict';
const hdbErrors = require('./commonErrors.js');
const logger = require('../logging/harper_logger.js');
const hdbTerms = require('../hdbTerms.ts');

/**
 * Custom error class used for better error and log handling.  Caught errors that evaluate to an instanceof HdbError can
 * be handled differently - e.g. in most cases caught HdbError likely would not need to be logged since that should have
 * already been handled when the custom error was constructed.
 */
class HdbError extends Error {
	/**
	 * @param {Error} errOrig -  Error to be translated into HdbError. If manually throwing an error, pass `new Error()` to ensure stack trace is maintained
	 * @param {String} [httpMsg] - optional -  response message that will be returned via the API
	 * @param {Number} [httpCode] - optional -  response status code that will be returned via the API
	 * @param {String} [logLevel] - optional -  log level that will be used for logging of this error
	 * @param {String} [logMsg] - optional - log message that, if provided, will be logged at the `logLevel` above
	 */
	constructor(errOrig, httpMsg, httpCode, logLevel, logMsg) {
		super();

		//This line ensures the original stack trace is captured and does not include the 'handle' or 'constructor' methods
		Error.captureStackTrace(this, handleHDBError);

		this.statusCode = httpCode ? httpCode : hdbErrors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
		this.http_resp_msg = httpMsg
			? httpMsg
			: hdbErrors.DEFAULT_ERROR_MSGS[httpCode]
				? hdbErrors.DEFAULT_ERROR_MSGS[httpCode]
				: hdbErrors.DEFAULT_ERROR_MSGS[hdbErrors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR];
		this.message = errOrig.message ? errOrig.message : this.http_resp_msg;
		this.type = errOrig.name;
		if (logLevel) this.logLevel = logLevel;

		//This ensures that the error stack does not include [object Object] if the error message is not a string
		if (typeof this.message !== 'string') {
			this.stack = errOrig.stack;
		}

		if (logMsg) {
			logger[logLevel](logMsg);
		}
	}
}
class ClientError extends Error {
	constructor(message, statusCode) {
		if (message instanceof Error) {
			message.statusCode = statusCode || 400;
			return message;
		}
		super(message);
		this.statusCode = statusCode || 400;
	}
}

class ServerError extends Error {
	constructor(message, statusCode) {
		super(message);
		this.statusCode = statusCode || 500;
	}
}

/**
 * This handler method is used to effectively evaluate caught errors and either translates them into a custom HdbError or,
 * if it is already a HdbError, just returns the error to continue being thrown up the stack
 *
 * See above for params descriptions
 * @param e
 * @param httpMsg
 * @param httpCode
 * @param logLevel
 * @param logMsg
 * @param deleteStack
 * @returns {HdbError|*}
 */
function handleHDBError(
	e,
	httpMsg,
	httpCode,
	logLevel = hdbTerms.LOG_LEVELS.ERROR,
	logMsg = null,
	deleteStack = false
) {
	if (isHDBError(e)) {
		return e;
	}

	const error = new HdbError(e, httpMsg, httpCode, logLevel, logMsg);

	// In some situations, such as validation errors, the stack does not need to be thrown/logged.
	if (deleteStack) {
		delete error.stack;
	}

	return error;
}

/**
 * Represents a general violation of validation/authorization. This should be used in situations where we are performing
 * expected verification, and we do not need to record a stack trace. This does not extend Error and
 * omitting stace trace capture is several times faster.
 * @param {Object} user - user object that caused the access violation
 * @constructor
 */

class Violation {
	constructor(message) {
		this.message = message;
	}
	toString() {
		return `${this.constructor.name}: ${this.message}`;
	}
}

/**
 * Represents an access violation. This is used to return a 403 or 401 response to the client. Uses fast Violation class
 * to avoid stack trace capture.
 * @param {Object} user - user object that caused the access violation
 * @constructor
 */
class AccessViolation extends Violation {
	constructor(user) {
		if (user) {
			super('Unauthorized access to resource');
			this.statusCode = 403;
		} else {
			super('Must login');
			this.statusCode = 401;
			// TODO: Optionally allow a Location header to redirect to
		}
	}
}

function isHDBError(e) {
	return e.__proto__.constructor.name === HdbError.name;
}

module.exports = {
	isHDBError,
	handleHDBError,
	ClientError,
	ServerError,
	AccessViolation,
	//Including common hdbErrors here so that they can be brought into modules on the same line where the handler method is brought in
	hdbErrors,
};
