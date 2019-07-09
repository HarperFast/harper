"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const log = require('../../../utility/logging/harper_logger');
const types = require('../types');

/**
 * Middleware that checks if the received message has come from an authorized source.
 */
class AuthMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            try {
                log.trace('Evaluating auth middleware');
                if (req.socket.authState === req.socket.UNAUTHENTICATED) {
                    log.error(`Not authorized`);
                    return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
                }
            } catch(err) {
                log.error('got an error in AuthMiddleware.');
                log.error(err);
                return types.ERROR_CODES.MIDDLEWARE_ERROR;
            }
            log.debug('Passed auth middleware');
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.AUTH;
    }
}

module.exports = AuthMiddleware;