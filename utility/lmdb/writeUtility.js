"use strict";

const environment_util = require('./environmentUtility');
const InsertRecordsResponseObject = require('./InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('./UpdateRecordsResponseObject');
const UpsertRecordsResponseObject = require('./UpsertRecordsResponseObject');
const common = require('./commonUtility');
const search_utility = require('./searchUtility');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const lmdb_terms = require('./terms');
const hdb_terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');
const uuid = require('uuid');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');

const CREATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME;
const MAX_BYTE_SIZE = lmdb_terms.MAX_BYTE_SIZE;
const LMDB_MDB_NOTFOUND_CODE = -30798;

/**
 * inserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @returns {InsertRecordsResponseObject}
 */
async function insertRecords(env, hash_attribute, write_attributes , records){
    validateWrite(env, hash_attribute, write_attributes , records);

    let txn = undefined;
    try {
        txn = initializeTransaction(env, hash_attribute, write_attributes);
        let primary_store = env.dbis[hash_attribute];
        let result = new InsertRecordsResponseObject();

        let remove_indices = [];
        let promises = new Map();
        for(let index = 0; index < records.length; index++){
            let record = records[index];
            setTimestamps(record, true);

            let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
            record[hash_attribute] = cast_hash_value;

            let promise = primary_store.ifNoExists(cast_hash_value, ()=>{
                for (let x = 0; x < write_attributes.length; x++){
                    let attribute = write_attributes[x];

                    if(attribute === hash_attribute){
                        continue;
                    }

                    let value = record[attribute];
                    if(typeof value === 'function'){
                        let value_results = value([[{}]]);
                        if(Array.isArray(value_results)){
                            value = value_results[0][hdb_terms.FUNC_VAL];
                        }
                    }

                    value = hdb_utils.autoCast(value);
                    record[attribute] = value;
                    if(value !== null) {
                        //LMDB has a 254 byte limit for keys, so we return null if the byte size is larger than 254 to not index that value
                        if(checkIsBlob(value)){
                            let key = `${attribute}/${cast_hash_value}`;
                            env.dbis[lmdb_terms.BLOB_DBI_NAME].put(key, value);
                        }else {
                            env.dbis[attribute].put(value, cast_hash_value);
                        }
                    }
                }
                primary_store.put(cast_hash_value, record);
            });

            promises.set(cast_hash_value, promise);

                // with the flag noOverwrite: true we can force lmdb to throw an error if the key already exists.
                // this allows us to auto check if the row already exists
                /*try {
                    txn.putUtf8(env.dbis[hash_attribute], primary_key, JSON.stringify(record), {noOverwrite: true});
                } catch(e) {
                    if (e.message.startsWith('MDB_KEYEXIST') === true) {
                        result.skipped_hashes.push(cast_hash_value);
                        remove_indices.push(index);
                        continue;
                    }

                    throw e;
                }*/


        }
        let promises_keys = promises.keys();
        let promise_results = await Promise.all(promises.values());
        for(let x = 0, length = promise_results.length; x < length; x++){
            if(promise_results[x] === true){
                result.written_hashes.push(promises_keys[x]);
            } else {
                result.skipped_hashes.push(promises_keys[x]);
                remove_indices.push(x);
            }
        }

        result.txn_time = common.getMicroTime();
        txn.commit();
        removeSkippedRecords(records, remove_indices);

        return result;
    }catch(e){
        throw e;
    }
}

/**
 * removes skipped records
 * @param {[{}]}records
 * @param {[number]}remove_indices
 */
function removeSkippedRecords(records, remove_indices = []){
    //remove the skipped entries from the records array
    let offset = 0;
    for(let x = 0; x < remove_indices.length; x++){
        let index = remove_indices[x];
        records.splice(index - offset, 1);
        //the offset needs to increase for every index we remove
        offset++;
    }
}

/**
 * auto sets the createdtime & updatedtime stamps on a record
 * @param {Object} record
 * @param {Boolean} is_insert
 */
function setTimestamps(record, is_insert){
    let timestamp = Date.now();
    record[UPDATED_TIME_ATTRIBUTE_NAME] = timestamp;
    if(is_insert === true) {
        record[CREATED_TIME_ATTRIBUTE_NAME] = timestamp;
    } else {
        delete record[CREATED_TIME_ATTRIBUTE_NAME];
    }
}

/**
 * makes sure all needed dbis are opened / created & starts the transaction
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @returns {*}
 */
function initializeTransaction(env, hash_attribute, write_attributes){
    //dbis must be opened / created before starting the transaction
    if(write_attributes.indexOf(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME) <0){
        write_attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
    }

    if(write_attributes.indexOf(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME) <0){
        write_attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
    }

    if(write_attributes.indexOf(lmdb_terms.BLOB_DBI_NAME) <0){
        write_attributes.push(lmdb_terms.BLOB_DBI_NAME);
    }

    environment_util.initializeDBIs(env, hash_attribute, write_attributes);

    //return env.beginTxn();
}

/**
 * updates records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @returns {UpdateRecordsResponseObject}
 */
function updateRecords(env, hash_attribute, write_attributes , records){
    //validate
    validateWrite(env, hash_attribute, write_attributes , records);

    let txn = undefined;
    try {
        txn = initializeTransaction(env, hash_attribute, write_attributes);

        let result = new UpdateRecordsResponseObject();

        //iterate update records
        let remove_indices = [];
        for(let index = 0; index < records.length; index++){
            let record = records[index];
            setTimestamps(record, false);

            let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
            let hash_value = record[hash_attribute].toString();
            //grab existing record
            let existing_record = search_utility.searchByHash(env, hash_attribute, ['*'], hash_value);

            if(existing_record === null){
                result.skipped_hashes.push(cast_hash_value);
                remove_indices.push(index);
                continue;
            }

            result.original_records.push(existing_record);

            updateUpsertRecord(env, txn, hash_attribute, record, existing_record, hash_value, cast_hash_value, result);
        }

        //commit transaction
        result.txn_time = common.getMicroTime();
        txn.commit();
        removeSkippedRecords(records, remove_indices);
        return result;
    }catch(e){
        if(txn !== undefined){
            txn.abort();
        }
        throw e;
    }
}

/**
 * upserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @returns {UpdateRecordsResponseObject}
 */
function upsertRecords(env, hash_attribute, write_attributes , records){
    //validate
    try {
        validateWrite(env, hash_attribute, write_attributes , records);
    } catch(err) {
        throw handleHDBError(err, err.message, hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST);
    }


    let txn = undefined;
    try {
        txn = initializeTransaction(env, hash_attribute, write_attributes);

        let result = new UpsertRecordsResponseObject();

        //iterate upsert records
        for(let index = 0; index < records.length; index++){
            let record = records[index];
            let is_insert = false;
            let hash_value = undefined;
            let existing_record = undefined;
            if(hdb_utils.isEmpty(record[hash_attribute]) ){
                hash_value = uuid.v4();
                record[hash_attribute] = hash_value;
                is_insert = true;
            } else {
                hash_value = record[hash_attribute].toString();
                //grab existing record
                existing_record = search_utility.searchByHash(env, hash_attribute, ['*'], hash_value);
            }

            //if the existing record doesn't exist we initialize it as an empty object & flag the record as an insert
            if (hdb_utils.isEmpty(existing_record)) {
                existing_record = {};
                is_insert = true;
            } else {
                result.original_records.push(existing_record);
            }
            let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
            setTimestamps(record, is_insert);

            updateUpsertRecord(env, txn, hash_attribute, record, existing_record, hash_value, cast_hash_value, result);
        }

        //commit transaction
        result.txn_time = common.getMicroTime();
        txn.commit();
        return result;
    }catch(e){
        if(txn !== undefined){
            txn.abort();
        }
        throw e;
    }
}

/**
 * central function used by updateRecords & upsertRecords to write a row to lmdb
 * @param {lmdb.RootDatabase} env
 * @param txn - lmdb transaction object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {{}} record - the record to process
 * @param {{}} existing_record - the original record that is potentially being updated
 * @param {string} hash_value - the hash attribute value for the row
 * @param {string|number} cast_hash_value - the hash attribute value cast to it's data type
 * @param {UpdateRecordsResponseObject} result
 */
function updateUpsertRecord(env, txn, hash_attribute, record, existing_record, hash_value, cast_hash_value, result){
    //iterate the entries from the record
    for (let [key, value] of Object.entries(record)) {
        if(key === hash_attribute){
            continue;
        }
        let dbi = env.dbis[key];
        if(dbi === undefined){
            continue;
        }

        let existing_value = existing_record[key];

        //
        if(typeof value === 'function'){
            let value_results = value([[existing_record]]);
            if(Array.isArray(value_results)){
                value = value_results[0][hdb_terms.FUNC_VAL];
                record[key] = value;
            }
        }

        let str_new_value = common.convertKeyValueToWrite(value, dbi[lmdb_terms.DBI_DEFINITION_NAME].key_type);
        let str_existing_value = common.convertKeyValueToWrite(existing_value, dbi[lmdb_terms.DBI_DEFINITION_NAME].key_type);
        if(str_new_value === str_existing_value) {
            continue;
        }

        //if the update cleared out the attribute value we need to delete it from the index
        if (str_existing_value !== null) {
            try {
                if(checkIsBlob(str_existing_value)){
                    let key_value = `${key}/${hash_value}`;
                    txn.del(env.dbis[lmdb_terms.BLOB_DBI_NAME], key_value, str_existing_value);
                }else {
                    txn.del(dbi, str_existing_value, hash_value);
                }
            } catch (e) {
                //this is the code for attempting to delete an entry that does not exist
                if (e.code !== LMDB_MDB_NOTFOUND_CODE) {
                    throw e;
                }
            }
        }

        if (str_new_value !== null) {
            //LMDB has a 254 byte limit for keys, so we return null if the byte size is larger than 254 to not index that value
            if(checkIsBlob(str_new_value)){
                let key_value = `${key}/${hash_value}`;
                txn.putUtf8(env.dbis[lmdb_terms.BLOB_DBI_NAME], key_value, str_new_value);
            }else {
                txn.putUtf8(dbi, str_new_value, hash_value);
            }
        }

    }

    let merged_record = Object.assign({}, existing_record, record);
    txn.putUtf8(env.dbis[hash_attribute], hash_value.toString(), JSON.stringify(merged_record));
    result.written_hashes.push(cast_hash_value);
}

/**
 * checks if a value is a 'blob', meaning a string over 254 bytes
 * @param {any} value
 * @returns {boolean}
 */
function checkIsBlob(value){
    if(typeof value === 'string' && Buffer.byteLength(value) > MAX_BYTE_SIZE){
        return true;
    }

    if(typeof value === 'object' && Buffer.byteLength(JSON.stringify(value)) > MAX_BYTE_SIZE){
        return true;
    }

    return false;
}

/**
 * common validation function for env, hash_attribute & fetch_attributes
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 */
function validateBasic(env, hash_attribute, write_attributes){
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    if(!Array.isArray(write_attributes)){
        if(write_attributes === undefined){
            throw new Error(LMDB_ERRORS.WRITE_ATTRIBUTES_REQUIRED);
        }

        throw new Error(LMDB_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY);
    }
}

/**
 * validates the parameters for LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 */
function validateWrite(env, hash_attribute, write_attributes , records){
    validateBasic(env, hash_attribute, write_attributes);

    if(!Array.isArray(records)){
        if(records === undefined){
            throw new Error(LMDB_ERRORS.RECORDS_REQUIRED);
        }

        throw new Error(LMDB_ERRORS.RECORDS_MUST_BE_ARRAY);
    }
}

module.exports = {
    insertRecords,
    updateRecords,
    upsertRecords
};
