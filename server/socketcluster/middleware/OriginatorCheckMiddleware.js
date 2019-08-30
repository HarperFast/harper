"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const env = require('../../../utility/environment/environmentManager');
/**
 * This middleware checks the originator to make sure it does not match the request originator.
 */
class OriginatorCheckMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            try {
                log.trace('Evaluating originator check middleware');
                if (!req.data.__originator || req.data.__originator[env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)] !== types.ORIGINATOR_SET_VALUE) {
                    log.debug('Passed Originator Middleware');
                    return;
                }
            } catch(err) {
                log.error('Got an error in OriginatorCheckMiddleware');
                log.error(err);
                return types.ERROR_CODES.MIDDLEWARE_ERROR;
            }
            log.debug(`Failed Originator Middleware check on channel: ${req.channel} for request type: ${req.data.type} and originator id: ${env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)}`);
            return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.ORIGINATOR;
        this.command_order = types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST;
    }
}

module.exports = OriginatorCheckMiddleware;