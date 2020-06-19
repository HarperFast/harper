"use strict";
const hdb_errors = require('./commonErrors');
const logger = require('../logging/harper_logger');

class HdbError extends Error {
    constructor(
        err_orig,
        http_code,
        http_msg,
        log_level,
        log_msg
    ) {
        super();
        this.http_resp_code = http_code ? http_code : hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
        this.http_resp_msg = http_msg ? http_msg : hdb_errors.DEFAULT_ERROR_MSGS[http_code] ? hdb_errors.DEFAULT_ERROR_MSGS[http_code] : hdb_errors.DEFAULT_ERROR_MSGS[hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR];
        this.message = err_orig.message ? err_orig.message : this.http_resp_msg;
        this.name = err_orig.name;
        this.type = err_orig.name;

        //This line ensures the original stack trace is captured and does not include the 'handle' or 'constructor' methods
        Error.captureStackTrace(this, handleHDBError);

        if (log_msg) {
            logger[log_level](log_msg);
        }
    }
}

function handleHDBError(e, http_code, http_msg, log_level = logger.ERR, log_msg = false) {
    if (e instanceof HdbError) {
        return e;
    }
    return (new HdbError(e, http_code, http_msg, log_level, log_msg));
}

module.exports =  {
    handleHDBError,
    hdb_errors
};
