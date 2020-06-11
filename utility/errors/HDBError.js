"use strict";
const hdb_errors = require('./commonErrors');
const logger = require('../logging/harper_logger');

class HDBError extends Error {
    constructor(
        err_orig,
        http_code,
        http_msg,
        log_level,
        log_msg
    ) {
        super();
        this.message = err_orig.message;
        this.name = err_orig.name;
        this.http_code = http_code;
        this.http_msg = http_msg ? http_msg : hdb_errors.COMMON_ERROR_MSGS[http_code] ? hdb_errors.COMMON_ERROR_MSGS[http_code] : hdb_errors.DEFAULT_ERROR_MSG;
        this.type = err_orig.name;

        //This line ensures the original stack trace is captured and does not include the 'handle' or 'constructor' methods
        Error.captureStackTrace(this, handleHDBError);

        if (log_msg) {
            logger[log_level](log_msg);
        }
    }
}

function handleHDBError(e, http_code= 500, http_msg, log_level = logger.ERR, log_msg = false) {
    if (e instanceof HDBError) {
        return e;
    }
    return (new HDBError(e, http_code, http_msg, log_level, log_msg));
}

module.exports =  handleHDBError;
