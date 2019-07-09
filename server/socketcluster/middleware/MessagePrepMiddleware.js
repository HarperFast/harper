"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const log = require('../../../utility/logging/harper_logger');
const types = require('../types');
const uuidV4 = require('uuid/v4');

/**
 * This middleware should be called upon receipt of a message that passes auth.  It will assign data members that can
 * be used during message processing.
 */
class MessagePrepMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            log.trace('Evaluating Message Prep middleware');
            req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.ID] = uuidV4();
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.MSG_PREP;
    }
}

module.exports = MessagePrepMiddleware;