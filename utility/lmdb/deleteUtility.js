"use strict";

const environment_util = require('./environmentUtility');
const common = require('./commonUtility');
const LMDB_ERRORS = require('../commonErrors').LMDB_ERRORS_ENUM;
let search_utility = require('./searchUtility');
let log = require('../logging/harper_logger');
const hdb_utils = require('../common_utils');

/**
 *  deletes rows and their entries in all indices
 * @param {lmdb.Env} env - environment object used high level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} ids - list of ids to delete
 * @returns {{deleted: [], skipped: []}}
 */
function deleteRecords(env, hash_attribute, ids){
    //validate
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED;
    }

    if(!Array.isArray(ids)){
        if(ids === undefined){
            throw LMDB_ERRORS.IDS_REQUIRED;
        }

        throw LMDB_ERRORS.IDS_MUST_BE_ARRAY;
    }

    let deleted = {
        deleted:[],
        skipped:[]
    };
    let txn = undefined;
    try {

        //open all dbis for this env
        let all_dbis = environment_util.listDBIs(env);
        environment_util.initializeDBIs(env, hash_attribute, all_dbis);
        //create write transaction, this will lock out other writes/deletes out until complete
        txn = env.beginTxn();

        for(let x = 0; x < ids.length; x++){
            ids[x] = ids[x].toString();
        }

        //fetch records & find keys to delete
        let records = search_utility.batchSearchByHash(env, hash_attribute, all_dbis, ids, deleted.skipped);

        //iterate records and process deletes
        let hash_value;
        let cast_hash_value;
        for(let x = 0; x < records.length; x++){
            try {
                let record = records[x];
                //always just delete the hash_attribute entry upfront
                hash_value = record[hash_attribute].toString();
                cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
                txn.del(env.dbis[hash_attribute], hash_value);

                //iterate & delete the non-hash attribute entries
                for (let y = 0; y < all_dbis.length; y++) {
                    let attribute = all_dbis[y];
                    if (attribute !== hash_attribute) {
                        let value = common.stringifyData(record[attribute]);
                        if (value !== null) {
                            txn.del(env.dbis[attribute], value, hash_value);
                        }
                    }
                }
                deleted.deleted.push(cast_hash_value);
            }catch(e){
                log.warn(e);
                deleted.skipped.push(cast_hash_value);
            }
        }

        //commit the transaction
        txn.commit();

        return deleted;
    } catch(e){
        if(txn !== undefined){
            txn.abort();
        }
        throw e;
    }
}

module.exports = {
    deleteRecords
};