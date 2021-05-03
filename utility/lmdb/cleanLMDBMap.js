'use strict';

const environment_utility = require('./environmentUtility');
const harper_logger = require('../logging/harper_logger');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;

module.exports = cleanLMDBMap;

/**
 * this function strips away the cached environments from global when a schema item is removed
 * @param msg
 */
function cleanLMDBMap(msg){
    try{
        if(global.lmdb_map !== undefined && msg.operation !== undefined){
            let keys = Object.keys(global.lmdb_map);
            let cached_environment = undefined;

            switch (msg.operation.operation) {
                case 'drop_schema':
                    for(let x = 0; x < keys.length; x ++){
                        let key = keys[x];
                        if(key.startsWith(`${msg.operation.schema}.`) || key.startsWith(`txn.${msg.operation.schema}.`)){
                            try {
                                environment_utility.closeEnvironment(global.lmdb_map[key]);
                            } catch(err) {
                                if (err.message && err.message === LMDB_ERRORS.ENV_REQUIRED) {
                                    break;
                                }
                                throw err;
                            }
                        }
                    }
                    break;
                case 'drop_table':
                    // eslint-disable-next-line no-case-declarations
                    let schema_table_name = `${msg.operation.schema}.${msg.operation.table}`;
                    // eslint-disable-next-line no-case-declarations
                    let txn_schema_table_name = `txn.${schema_table_name}`;
                    try {
                        environment_utility.closeEnvironment(global.lmdb_map[schema_table_name]);
                        environment_utility.closeEnvironment(global.lmdb_map[txn_schema_table_name]);
                    } catch(err) {
                        if (err.message && err.message === LMDB_ERRORS.ENV_REQUIRED) {
                            break;
                        }
                        throw err;
                    }
                    break;
                case 'drop_attribute':
                    cached_environment = global.lmdb_map[`${msg.operation.schema}.${msg.operation.table}`];
                    if(cached_environment !== undefined && typeof cached_environment.dbis === 'object' && cached_environment.dbis[`${msg.operation.attribute}`] !== undefined){
                        delete cached_environment.dbis[`${msg.operation.attribute}`];
                    }
                    break;
                default:
                    break;
            }

        }
    } catch(e){
        harper_logger.error(e);
    }
}