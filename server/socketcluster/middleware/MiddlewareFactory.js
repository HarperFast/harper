"use strict";

/**
 * A factory module for creating middleware.  Will construct and return a middlewareIF object based on the options
 * parameter.
 * @type {MiddlewareIF}
 */
const GenericMiddleware = require('./GenericMiddleware');
const OriginatorCheckMiddleware = require('./OriginatorCheckMiddleware');
const RequestDataValidMiddleware = require('./RequestDataValidMiddleware');
const AuthMiddleware = require('./AuthMiddleware');
const StampRequestMiddleware = require('./StampRequestMiddleware');
const MessagePrepMiddleware = require('./MessagePrepMiddleware');
const ConnectionNameCheckMiddleware = require('./ConnectionNameCheckMiddleware');

const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

class MiddlewareFactoryOptions {
    constructor(premade_middleware_type_enum) {
        this.premade_middleware_type_enum = (premade_middleware_type_enum ? premade_middleware_type_enum : types.PREMADE_MIDDLEWARE_TYPES.GENERIC);
    }
}

/**
 * A
 * @param middleware_type_enum
 * @param eval_function
 * @param options
 * @returns {null}
 */
function createMiddleware(middleware_type_enum, eval_function, options) {
    let created_middleware = null;
    try {
        if(options) {
            switch(options.premade_middleware_type_enum) {
                case types.PREMADE_MIDDLEWARE_TYPES.GENERIC:
                    log.trace('Creating Generic middleware');
                    created_middleware = new GenericMiddleware(middleware_type_enum, null);
                    break;
                case types.PREMADE_MIDDLEWARE_TYPES.AUTH:
                    log.trace('Creating Auth middleware');
                    created_middleware = new AuthMiddleware(middleware_type_enum, null);
                    break;
                case types.PREMADE_MIDDLEWARE_TYPES.ORIGINATOR:
                    log.trace('Creating Originator middleware');
                    created_middleware = new OriginatorCheckMiddleware(middleware_type_enum, null);
                    break;
                case types.PREMADE_MIDDLEWARE_TYPES.REQUEST_DATA_VALID:
                    log.trace('Creating Data validator middleware');
                    created_middleware = new RequestDataValidMiddleware(middleware_type_enum, null);
                    break;
                case types.PREMADE_MIDDLEWARE_TYPES.STAMP_REQUEST:
                    log.trace('Creating Stamp middleware');
                    created_middleware = new StampRequestMiddleware(middleware_type_enum, null);
                    break;
                case types.PREMADE_MIDDLEWARE_TYPES.MSG_PREP:
                    log.trace('Creating msg prep middleware');
                    created_middleware = new MessagePrepMiddleware(middleware_type_enum, null);
                    break;
                case types.PREMADE_MIDDLEWARE_TYPES.CONNECTION_NAME_CHECK:
                    log.trace('Creating connection name check middleware');
                    created_middleware = new ConnectionNameCheckMiddleware(middleware_type_enum, null);
                    break;
                default:
                    created_middleware = new GenericMiddleware(middleware_type_enum, null);
                    break;
            }
            // TODO: fill in supported options if needed.
        } else {
            created_middleware = new GenericMiddleware(middleware_type_enum, eval_function);
        }
    } catch(err) {
        log.error(`In createMiddleware: ${err}`);
    }
    return created_middleware;
}

module.exports = {
    MiddlewareFactoryOptions,
    createMiddleware,
};
