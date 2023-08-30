'use strict';
const hdb_errors = require('./commonErrors');
const logger = require('../logging/harper_logger');
const hdb_terms = require('../hdbTerms');

/**
 * Custom error class used for better error and log handling.  Caught errors that evaluate to an instanceof HdbError can
 * be handled differently - e.g. in most cases caught HdbError likely would not need to be logged since that should have
 * already been handled when the custom error was constructed.
 */
class HdbError extends Error {
	/**
	 * @param {Error} err_orig -  Error to be translated into HdbError. If manually throwing an error, pass `new Error()` to ensure stack trace is maintained
	 * @param {String} [http_msg] - optional -  response message that will be returned via the API
	 * @param {Number} [http_code] - optional -  response status code that will be returned via the API
	 * @param {String} [log_level] - optional -  log level that will be used for logging of this error
	 * @param {String} [log_msg] - optional - log message that, if provided, will be logged at the `log_level` above
	 */
	constructor(err_orig, http_msg, http_code, log_level, log_msg) {
		super();

		//This line ensures the original stack trace is captured and does not include the 'handle' or 'constructor' methods
		Error.captureStackTrace(this, handleHDBError);

		this.statusCode = http_code ? http_code : hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
		this.http_resp_msg = http_msg
			? http_msg
			: hdb_errors.DEFAULT_ERROR_MSGS[http_code]
			? hdb_errors.DEFAULT_ERROR_MSGS[http_code]
			: hdb_errors.DEFAULT_ERROR_MSGS[hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR];
		this.message = err_orig.message ? err_orig.message : this.http_resp_msg;
		this.type = err_orig.name;
		if (log_level) this.logLevel = log_level;

		//This ensures that the error stack does not include [object Object] if the error message is not a string
		if (typeof this.message !== 'string') {
			this.stack = err_orig.stack;
		}

		if (log_msg) {
			logger[log_level](log_msg);
		}
	}
}
class ClientError extends Error {
	constructor(message, status_code) {
		if (message instanceof Error) {
			message.statusCode = status_code || 400;
			return message;
		}
		super(message);
		this.statusCode = status_code || 400;
	}
}

class ServerError extends Error {
	constructor(message, status_code) {
		super(message);
		this.statusCode = status_code || 500;
	}
}

/**
 * This handler method is used to effectively evaluate caught errors and either translates them into a custom HdbError or,
 * if it is already a HdbError, just returns the error to continue being thrown up the stack
 *
 * See above for params descriptions
 * @param e
 * @param http_msg
 * @param http_code
 * @param log_level
 * @param log_msg
 * @param delete_stack
 * @returns {HdbError|*}
 */
function handleHDBError(
	e,
	http_msg,
	http_code,
	log_level = hdb_terms.LOG_LEVELS.ERROR,
	log_msg = null,
	delete_stack = false
) {
	if (isHDBError(e)) {
		return e;
	}

	const error = new HdbError(e, http_msg, http_code, log_level, log_msg);

	// In some situations, such as validation errors, the stack does not need to be thrown/logged.
	if (delete_stack) {
		delete error.stack;
	}

	return error;
}

function isHDBError(e) {
	return e.__proto__.constructor.name === HdbError.name;
}

module.exports = {
	isHDBError,
	handleHDBError,
	ClientError,
	ServerError,
	//Including common hdb_errors here so that they can be brought into modules on the same line where the handler method is brought in
	hdb_errors,
};
