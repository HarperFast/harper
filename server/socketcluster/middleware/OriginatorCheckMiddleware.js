"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

/**
 * This middleware checks the originator to make sure it does not match the request originator.
 */
class OriginatorCheckMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            try {
                log.trace('Evaluating originator check middleware');
                if (req.data.__originator !== req.socket.id) {
                    log.debug('Passed Originator Middleware');
                    return;
                }
            } catch(err) {
                log.error('Got an error in OriginatorCheckMiddleware');
                log.error(err);
                return types.ERROR_CODES.MIDDLEWARE_ERROR;
            }
            log.debug('Failed Originator Middleware check');
            return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.ORIGINATOR;
    }
}

module.exports = OriginatorCheckMiddleware;