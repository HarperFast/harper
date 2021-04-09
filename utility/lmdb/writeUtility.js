"use strict";

const environment_util = require('./environmentUtility');
const InsertRecordsResponseObject = require('./InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('./UpdateRecordsResponseObject');
const UpsertRecordsResponseObject = require('./UpsertRecordsResponseObject');
const common = require('./commonUtility');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const lmdb_terms = require('./terms');
const hdb_terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');
const uuid = require('uuid');
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb-store');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');

const CREATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME;
const LMDB_MDB_NOTFOUND_CODE = -30798;

/**
 * inserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @param {Boolean} generate_timestamps - defines if timestamps should be created
 * @returns {Promise<InsertRecordsResponseObject>}
 */
async function insertRecords(env, hash_attribute, write_attributes , records, generate_timestamps = true){
    validateWrite(env, hash_attribute, write_attributes , records);

    try {
        initializeTransaction(env, hash_attribute, write_attributes);

        let result = new InsertRecordsResponseObject();

        let puts = [];
        let keys = [];
        for(let index = 0; index < records.length; index++){
            let record = records[index];
            setTimestamps(record, true, generate_timestamps);

            let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
            record[hash_attribute] = cast_hash_value;
            let put_values = [];
            put_values.push([env.dbis[hash_attribute], cast_hash_value, record, 1]);
            for (let x = 0; x < write_attributes.length; x++) {
                let attribute = write_attributes[x];

                //we do not process the write to the hash attribute, blob as they are handled differently.  Also skip if the attribute does not exist on the object
                if (attribute === hash_attribute || attribute === lmdb_terms.BLOB_DBI_NAME || record.hasOwnProperty(attribute) === false) {
                    continue;
                }

                let value = record[attribute];
                if (typeof value === 'function') {
                    let value_results = value([[{}]]);
                    if (Array.isArray(value_results)) {
                        value = value_results[0][hdb_terms.FUNC_VAL];
                        record[attribute] = value;
                    }
                }

                value = hdb_utils.autoCast(value);
                value = value === undefined ? null : value;
                record[attribute] = value;
                if (value !== null && value !== undefined) {
                    //LMDB has a 254 byte limit for keys, so we return null if the byte size is larger than 254 to not index that value
                    if (common.checkIsBlob(value)) {
                        let key = `${attribute}/${cast_hash_value}`;
                        put_values.push([env.dbis[lmdb_terms.BLOB_DBI_NAME], key, value]);
                    } else {
                        let converted_key = common.convertKeyValueToWrite(value);
                        put_values.push([env.dbis[attribute], converted_key, cast_hash_value]);
                    }
                }
            }

            let promise = env.dbis[hash_attribute].ifNoExists(cast_hash_value, ()=> {
                for(let x = 0, length = put_values.length; x < length; x++){
                    let put_value = put_values[x];
                    put_value[0].put(put_value[1], put_value[2], put_value[3]);
                }
            });

            puts.push(promise);
            keys.push(cast_hash_value);
        }

        return await finalizeWrite(puts, keys, records, result);
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
 * @param {Boolean} generate_timestamps - defines if we should create timestamps for this record
 */
function setTimestamps(record, is_insert, generate_timestamps = true){
    if(generate_timestamps === false){
        return;
    }

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
}

/**
 * updates records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @returns {Promise<UpdateRecordsResponseObject>}
 */
async function updateRecords(env, hash_attribute, write_attributes , records){
    //validate
    validateWrite(env, hash_attribute, write_attributes , records);

    try {
        initializeTransaction(env, hash_attribute, write_attributes);

        let result = new UpdateRecordsResponseObject();

        //iterate update records
        let remove_indices = [];
        let puts = [];
        let keys = [];
        for(let index = 0; index < records.length; index++){
            let record = records[index];
            setTimestamps(record, false);

            let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
            //grab existing record
            let existing_record = env.dbis[hash_attribute].get(cast_hash_value);

            if(!existing_record){
                result.skipped_hashes.push(cast_hash_value);
                remove_indices.push(index);
                continue;
            }

            result.original_records.push(existing_record);
            let promise = env.dbis[hash_attribute].ifVersion(cast_hash_value, 1, ()=> {
                updateUpsertRecord(env, hash_attribute, record, existing_record, cast_hash_value);
            });
            puts.push(promise);
            keys.push(cast_hash_value);
        }

        return await finalizeWrite(puts, keys, records, result, remove_indices);
    }catch(e){
        throw e;
    }
}

/**
 * upserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @returns {Promise<UpdateRecordsResponseObject>}
 */
async function upsertRecords(env, hash_attribute, write_attributes , records){
    //validate
    try {
        validateWrite(env, hash_attribute, write_attributes , records);
    } catch(err) {
        throw handleHDBError(err, err.message, hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST);
    }

    try {
        initializeTransaction(env, hash_attribute, write_attributes);

        let result = new UpsertRecordsResponseObject();

        let puts = [];
        let keys = [];
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
                hash_value = hdb_utils.autoCast(record[hash_attribute]);
                //grab existing record
                existing_record = env.dbis[hash_attribute].get(hash_value);
            }


            let promise;
            //if the existing record doesn't exist we initialize it as an empty object & flag the record as an insert
            if (hdb_utils.isEmpty(existing_record)) {
                existing_record = {};
                is_insert = true;
                setTimestamps(record, is_insert);
                promise = env.dbis[hash_attribute].ifNoExists(hash_value, ()=> {
                    updateUpsertRecord(env, hash_attribute, record, existing_record, hash_value);
                });
            } else {
                setTimestamps(record, is_insert);
                promise = env.dbis[hash_attribute].ifVersion(hash_value, 1, ()=> {
                    updateUpsertRecord(env, hash_attribute, record, existing_record, hash_value);
                });
                result.original_records.push(existing_record);
            }

            puts.push(promise);
            keys.push(hash_value);
        }

        return await finalizeWrite(puts, keys, records, result);
    }catch(e){
        throw e;
    }
}

async function finalizeWrite(puts, keys, records, result, remove_indices = []){
    let put_results = await Promise.all(puts);
    for (let x = 0, length = put_results.length; x < length; x++){
        if(put_results[x] === true){
            result.written_hashes.push(keys[x]);
        } else{
            result.skipped_hashes.push(keys[x]);
            remove_indices.push(x);
        }
    }

    result.txn_time = common.getMicroTime();

    removeSkippedRecords(records, remove_indices);
    return result;
}

/**
 * central function used by updateRecords & upsertRecords to write a row to lmdb
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {{}} record - the record to process
 * @param {{}} existing_record - the original record that is potentially being updated
 * @param {string|number} cast_hash_value - the hash attribute value cast to it's data type
 */
function updateUpsertRecord(env, hash_attribute, record, existing_record, cast_hash_value){
    //iterate the entries from the record
    for (let [key, value] of Object.entries(record)) {
        if(key === hash_attribute || key === lmdb_terms.BLOB_DBI_NAME){
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
        value = hdb_utils.autoCast(value);
        value = value === undefined ? null : value;
        record[key] = value;
        existing_value = hdb_utils.autoCast(existing_value);
        if(value === existing_value) {
            continue;
        }

        //if the update cleared out the attribute value we need to delete it from the index
        if (existing_value !== null && existing_value !== undefined) {
            try {
                if(common.checkIsBlob(existing_value)){
                    let key_value = `${key}/${cast_hash_value}`;
                    env.dbis[lmdb_terms.BLOB_DBI_NAME].remove(key_value);
                }else {
                    let converted_key = common.convertKeyValueToWrite(existing_value);
                    dbi.remove(converted_key, cast_hash_value);
                }
            } catch (e) {
                //this is the code for attempting to delete an entry that does not exist
                if (e.code !== LMDB_MDB_NOTFOUND_CODE) {
                    throw e;
                }
            }
        }

        if (value !== null && value !== undefined) {
            //LMDB has a 254 byte limit for keys, so we return null if the byte size is larger than 254 to not index that value
            if(common.checkIsBlob(value)){
                let key_value = `${key}/${cast_hash_value}`;
                env.dbis[lmdb_terms.BLOB_DBI_NAME].put(key_value, value);
            }else {
                let converted_key = common.convertKeyValueToWrite(value);
                dbi.put(converted_key, cast_hash_value);
            }
        }

    }

    let merged_record = Object.assign({}, existing_record, record);
    env.dbis[hash_attribute].put(cast_hash_value, merged_record, 1);
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
