"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const log = require('../../../utility/logging/harper_logger');
const types = require('../types');
const terms = require('../../../utility/hdbTerms');
const uuidV4 = require('uuid/v4');
const env = require('../../../utility/environment/environmentManager');

/**
 * This middleware should be called after any middlware which compares against the message's originator.  It will stamp
 * the current message's originator map with this node's name.
 */
class ConnectionNameCheckMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            log.trace('Evaluating Message Prep middleware');
            if(!req.__originator) {
                log.info('ConnectionNameCheckMiddleware processing a message with no originator.');
            }
            if(!req.socket.request.url) {
                log.info('ConnectionNameCheckMiddleware processing a message that has no node name in its connector options.');
            }
            // NOTE: This is assuming the socket cluster connection url has only 1 variable, node_name.  If we add more
            // later this will need to change.
            let value_index = req.socket.request.url.lastIndexOf('=')+1;
            if(value_index) {
                let node_name = req.socket.request.url.substr(value_index, req.socket.request.url.length);
                if (req.__originator && req.__originator[node_name] !== undefined) {
                    return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
                }
            }
            next();
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.CONNECTION_NAME_CHECK;
        this.command_order = types.COMMAND_EVAL_ORDER_ENUM.LOW;
    }
}

module.exports = ConnectionNameCheckMiddleware;