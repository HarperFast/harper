'use strict';

const environment_utility = require('./environmentUtility');
const harper_logger = require('../logging/harper_logger');

module.exports = cleanLMDBMap;

/**
 * this function strips away the cached environments from global when a schema item is removed
 * @param msg
 */
function cleanLMDBMap(msg, log = false){
    try{
        if(global.lmdb_map && msg && msg.operation !== undefined){
            let keys = Object.keys(global.lmdb_map);
            let cached_environment = undefined;
            let deleted_keys = [];
            switch (msg.operation.operation) {
                case 'drop_schema':


                    for(let x = 0; x < keys.length; x ++){
                        let key = keys[x];
                        if(key.startsWith(`${msg.operation.schema}.`) || key.startsWith(`txn.${msg.operation.schema}.`)){
                            deleted_keys.push(key);
                            environment_utility.closeEnvironment(global.lmdb_map[key]);
                            try{
                                if(log) {
                                    console.log(`closed ${key}`);
                                    console.log(global.lmdb_map[key].stat());
                                }
                            }catch (e){
                                if(log){
                                    console.error(`${key}: ${e}`);
                                }
                            }
                            //delete global.lmdb_map[key];
                        }
                    }
                    /*if(log === true){
                        console.log(process.pid, msg, deleted_keys);

                    }*/
                    for(let x = 0, length = deleted_keys.length; x< length; x++){

                        delete global.lmdb_map[deleted_keys[x]];
                    }
                    break;
                case 'drop_table':
                    // eslint-disable-next-line no-case-declarations
                    let schema_table_name = `${msg.operation.schema}.${msg.operation.table}`;
                    // eslint-disable-next-line no-case-declarations
                    let txn_schema_table_name = `txn.${schema_table_name}`;
                    environment_utility.closeEnvironment(global.lmdb_map[schema_table_name]);
                    environment_utility.closeEnvironment(global.lmdb_map[txn_schema_table_name]);
                    delete global.lmdb_map[schema_table_name];
                    delete global.lmdb_map[txn_schema_table_name];
                    break;
                case 'drop_attribute':
                    cached_environment = global.lmdb_map[`${msg.operation.schema}.${msg.operation.table}`];
                    if(cached_environment !== undefined && typeof cached_environment.dbis === 'object' && cached_environment.dbis[`${msg.operation.attribute}`] !== undefined){
                        delete cached_environment.dbis[`${msg.operation.attribute}`];
                    }
                    break;
            }
        }
    } catch(e){
        harper_logger.error(e);
    }
}