"use strict";
const hdb_errors = require('./commonErrors');
const logger = require('../logging/harper_logger');

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
     * @param {String} [log_level] - optional -  log level that will be used IF a `log_msg` is provided.  If not, nothing will be logged
     * @param {String} [log_msg] - optional - log message that, if provided, will be logged at the `log_level` above
     */
    constructor(
        err_orig,
        http_msg,
        http_code,
        log_level,
        log_msg
    ) {
        super();
        this.http_resp_code = http_code ? http_code : hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
        this.http_resp_msg = http_msg ?
            http_msg : hdb_errors.DEFAULT_ERROR_MSGS[http_code] ?
            hdb_errors.DEFAULT_ERROR_MSGS[http_code] : hdb_errors.DEFAULT_ERROR_MSGS[hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR];
        this.message = err_orig.message ? err_orig.message : this.http_resp_msg;
        this.type = err_orig.name;

        //This line ensures the original stack trace is captured and does not include the 'handle' or 'constructor' methods
        Error.captureStackTrace(this, handleHDBError);

        if (log_msg) {
            logger[log_level](log_msg);
        }
    }
}

/**
 * This handler method is used to effectively evaluate caught errors and either translates them into a custom HdbError or,
 * if it is already a HdbError, just returns the error to continue being thrown up the stack
 *
 * See above for params descriptions
 * @param e
 * @param http_code
 * @param http_msg
 * @param log_level
 * @param log_msg
 * @returns {HdbError}
 */
function handleHDBError(e, http_msg, http_code, log_level = logger.ERR, log_msg = null) {
    if (isHDBError(e)) {
        return e;
    }
    return (new HdbError(e, http_msg, http_code, log_level, log_msg));
}

function handleValidationError(e, validation_msg) {
    if (isHDBError(e)) {
        return e;
    }
    return (new HdbError(e, `Error: ${validation_msg}`, hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST));
}

function isHDBError(e) {
    return e.__proto__.constructor.name === HdbError.name;
}

module.exports =  {
    isHDBError,
    handleHDBError,
    handleValidationError,
    //Including common hdb_errors here so that they can be brought into modules on the same line where the handler method is brought in
    hdb_errors
};
