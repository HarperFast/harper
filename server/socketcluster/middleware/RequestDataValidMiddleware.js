"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const log = require('../../../utility/logging/harper_logger');
const types = require('../types');

/**
 * This middleware is used to ensure valid data is inside the request.
 */
class RequestDataValidMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            try {
                log.trace('Evaluating request data validation middleware');
                if (typeof req.data !== 'object' || Array.isArray(req.data)) {
                    log.error('Request Data Valid Middleware failure: data must be an object');
                    return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
                }
            } catch(err) {
                log.error('Error in RequestDataValid Middleware');
                log.error(err);
                return types.ERROR_CODES.MIDDLEWARE_ERROR;
            }
            log.debug('Passed request data valid middleware');
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.REQUEST_DATA_VALID;
    }
}

module.exports = RequestDataValidMiddleware;