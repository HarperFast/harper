"use strict";

const MiddlewareIF = require('./MiddlewareIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const env = require('../../../utility/environment/environmentManager');
/**
 * This middleware checks the originator to make sure it does not match the request originator.
 */
class StampOriginatorMiddleware extends MiddlewareIF {
    constructor(middleware_type_enum, eval_function) {
        eval_function = (req, next) => {
            try {
                if(!req.data.__originator) {
                    req.data.__originator = {};
                }
                req.data.__originator[env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)] = types.ORIGINATOR_SET_VALUE;

                //we need to remove the transacted flag before the outbound message goes out to the cluster.
                if(req.data.__transacted) {
                    delete req.data.__transacted;
                }
                if(req.__transacted) {
                    delete req.data.__transacted;
                }
            } catch(err) {
                log.error('Got an error in StampOriginatorMiddleware');
                log.error(err);
                return types.ERROR_CODES.MIDDLEWARE_ERROR;
            }

        };
        super(middleware_type_enum, eval_function);
        this.type = types.PREMADE_MIDDLEWARE_TYPES.STAMP_ORIGINATOR;
        this.command_order = types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST;
    }
}

module.exports = StampOriginatorMiddleware;