"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const log = require('../../../utility/logging/harper_logger');
const types = require('../types');
const env = require('../../../utility/environment/environmentManager');
const hdb_terms = require('../../../utility/hdbTerms');

/**
 * This middleware stamps a request with the time and originator of the message.
 */
class StampRequestMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            log.trace('Evaluating stamp request middleware');
            if(!req.data) {
                return;
            }
            //add / change the timestamp
            req.data.timestamp = Date.now();

            //the __originator attribute is added so we can filter out sending back the same object to the sender
            if(!req.data.__originator) {
                req.data.__originator = {};
            }
            req.data.__originator[env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)] = '';
            log.debug('Stamped request with unique info.');
        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.STAMP_REQUEST;
    }
}

module.exports = StampRequestMiddleware;