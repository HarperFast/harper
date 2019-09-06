"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const log = require('../../../utility/logging/harper_logger');
const types = require('../types');
const terms = require('../../../utility/hdbTerms');
const uuidV4 = require('uuid/v4');
const env = require('../../../utility/environment/environmentManager');
const url = require('url');

/**
 * This middleware should be called after any middlware which compares against the message's originator.  It will stamp
 * the current message's originator map with this node's name.
 */
class ConnectionNameCheckMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            log.trace('Evaluating Message Prep middleware');
            if(!req.data.__originator) {
                log.info('ConnectionNameCheckMiddleware processing a message with no originator.');
            }
            if(!req.socket.request.url) {
                log.info('ConnectionNameCheckMiddleware processing a message that has no node name in its connector options.');
            }
            if(!this.server_node_name || !this.client_node_name) {
                this.parseConnectionString(req.socket.request.url);
            }

            if(this.client_node_name) {
                if (req.data.__originator && req.data.__originator[this.client_node_name] !== undefined) {
                    return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
                }
            }
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.CONNECTION_NAME_CHECK;
        this.command_order = types.COMMAND_EVAL_ORDER_ENUM.LOW;
        this.server_node_name = undefined;
        this.client_node_name = undefined;
    }

    parseConnectionString(req_url) {
        let query_vals = url.parse(req_url, true).query;
        this.server_node_name = query_vals.node_server_name;
        this.client_node_name = query_vals.node_client_name;
    }
}

module.exports = ConnectionNameCheckMiddleware;