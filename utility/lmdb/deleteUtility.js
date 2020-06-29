"use strict";

const environment_util = require('./environmentUtility');
const common = require('./commonUtility');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const search_utility = require('./searchUtility');
const lmdb_terms = require('./terms');
const log = require('../logging/harper_logger');
const hdb_utils = require('../common_utils');
const DeleteRecordsResponseObject = require('./DeleteRecordsResponseObject');

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
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    if(!Array.isArray(ids)){
        if(ids === undefined){
            throw new Error(LMDB_ERRORS.IDS_REQUIRED);
        }

        throw new Error(LMDB_ERRORS.IDS_MUST_BE_ARRAY);
    }


    let txn = undefined;
    try {

        //open all dbis for this env
        let all_dbis = environment_util.listDBIs(env);
        environment_util.initializeDBIs(env, hash_attribute, all_dbis);
        //create write transaction, this will lock out other writes/deletes out until complete
        txn = env.beginTxn();

        let deleted = new DeleteRecordsResponseObject();

        for(let x = 0; x < ids.length; x++){
            ids[x] = ids[x].toString();
        }

        //fetch records & find keys to delete
        let records = search_utility.batchSearchByHash(env, hash_attribute, all_dbis, ids, deleted.skipped);
        records = Object.values(records);
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
                        let dbi = env.dbis[attribute];
                        let value = common.convertKeyValueToWrite(record[attribute], dbi[lmdb_terms.DBI_DEFINITION_NAME].key_type);
                        if (value !== null) {
                            if(typeof value === 'string' && Buffer.byteLength(value) > lmdb_terms.MAX_BYTE_SIZE){
                                txn.del(env.dbis[lmdb_terms.BLOB_DBI_NAME], `${attribute}/${hash_value}`);
                            } else {
                                try {
                                    txn.del(dbi, value, hash_value);
                                }catch(e){
                                    log.warn(`cannot delete from attribute: ${attribute}, ${value}:${hash_value}`);
                                }
                            }
                        }
                    }
                }
                deleted.deleted.push(cast_hash_value);
                deleted.original_records.push(record);
            }catch(e){
                log.warn(e);
                deleted.skipped.push(cast_hash_value);
            }
        }

        deleted.txn_time = common.getMicroTime();
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
