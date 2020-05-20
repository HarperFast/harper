"use strict";
const lmdb = require('node-lmdb');
const environment_util = require('./environmentUtility');
const common = require('./commonUtility');
const search_utility = require('./searchUtility');
const LMDB_ERRORS = require('../commonErrors').LMDB_ERRORS_ENUM;
const lmdb_terms = require('./terms');
const hdb_terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');

const CREATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME;
const MAX_BYTE_SIZE = lmdb_terms.MAX_BYTE_SIZE;

/**
 * inserts records into LMDB
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @returns {{written_hashes: [], skipped_hashes: []}}
 */
function insertRecords(env, hash_attribute, write_attributes , records){
    validateWrite(env, hash_attribute, write_attributes , records);

    let txn = undefined;
    try {

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

        txn = env.beginTxn();

        let result = {
            written_hashes: [],
            skipped_hashes: []
        };
        for(let k = 0; k < records.length; k++){
            let record = records[k];
            setTimestamps(record, true);

            let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
            let primary_key = record[hash_attribute].toString();

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
                        record[attribute] = value;
                    }
                }

                value = common.convertKeyValueToWrite(value, env.dbis[attribute][lmdb_terms.DBI_DEFINITION_NAME].key_type);
                if(value !== null) {
                    //LMDB has a 511 byte limit for keys, so we return null if the byte size is larger than 511 to not index that value
                    if(typeof value === 'string' && Buffer.byteLength(value) > MAX_BYTE_SIZE){
                        let key = `${attribute}/${primary_key}`;
                        txn.putString(env.dbis[lmdb_terms.BLOB_DBI_NAME], key, value);
                    }else {
                        txn.putString(env.dbis[attribute], value, primary_key);
                    }
                }
            }

            // with the flag noOverwrite: true we can force lmdb to throw an error if the key already exists.
            // this allows us to auto check if the row already exists
            try {
                txn.putString(env.dbis[hash_attribute], primary_key, JSON.stringify(record), {noOverwrite: true});
            } catch(e){
                if(e.message.startsWith('MDB_KEYEXIST') === true){
                    result.skipped_hashes.push(cast_hash_value);
                    continue;
                }else{
                    throw e;
                }
            }

            result.written_hashes.push(cast_hash_value);
        }

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
 * auto sets the createdtime & updatedtime stamps on a record
 * @param {Object} record
 * @param {Boolean} is_insert
 */
function setTimestamps(record, is_insert){
    let timestamp = Date.now();
    record[UPDATED_TIME_ATTRIBUTE_NAME] = timestamp;
    if(is_insert === true) {
        record[CREATED_TIME_ATTRIBUTE_NAME] = timestamp;
    }
}

/**
 * inserts records into LMDB
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @returns {{written_hashes: [], skipped_hashes: []}}
 */
function updateRecords(env, hash_attribute, write_attributes , records){
    //validate
    validateWrite(env, hash_attribute, write_attributes , records);

    let txn = undefined;
    try {

    //init all dbis
        //dbis must be opened / created before starting the transaction
        if(write_attributes.indexOf(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME) <0){
            write_attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
        }

        if(write_attributes.indexOf(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME) <0){
            write_attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
        }

        environment_util.initializeDBIs(env, hash_attribute, write_attributes);

        //create write transaction to lock data changes rows
        txn = env.beginTxn();

        let result = {
            written_hashes: [],
            skipped_hashes: []
        };

        //iterate update records
        for(let x = 0; x < records.length; x++){
            let record = records[x];
            setTimestamps(record, false);

            let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
            let hash_value = record[hash_attribute].toString();
            //grab existing record
            let existing_record = search_utility.searchByHash(env, hash_attribute, ['*'], hash_value);

            if(existing_record === null){
                result.skipped_hashes.push(cast_hash_value);
                continue;
            }

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
                        if(typeof str_existing_value === 'string' && Buffer.byteLength(str_existing_value) > MAX_BYTE_SIZE){
                            let key_value = `${key}/${hash_value}`;
                            txn.del(env.dbis[lmdb_terms.BLOB_DBI_NAME], key_value, str_existing_value);
                        }else {
                            txn.del(dbi, str_existing_value, hash_value);
                        }
                    } catch (e) {
                        //this is the code for attempting to delete an entry that does not exist
                        if (e.code !== -30798) {
                            throw e;
                        }
                    }
                }

                if (str_new_value !== null) {
                    //LMDB has a 511 byte limit for keys, so we return null if the byte size is larger than 511 to not index that value
                    if(typeof str_new_value === 'string' && Buffer.byteLength(str_new_value) > MAX_BYTE_SIZE){
                        let key_value = `${key}/${hash_value}`;
                        txn.putString(env.dbis[lmdb_terms.BLOB_DBI_NAME], key_value, str_new_value);
                    }else {
                        txn.putString(dbi, str_new_value, hash_value);
                    }
                }

            }

            let merged_record = Object.assign(existing_record, record);
            txn.putString(env.dbis[hash_attribute], hash_value.toString(), JSON.stringify(merged_record));
            result.written_hashes.push(cast_hash_value);
        }

        //commit transaction
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
 * common validation function for env, hash_attribute & fetch_attributes
 * @param {lmdb.Env} env - lmdb environment object
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
 * @param {lmdb.Env} env - lmdb environment object
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
    updateRecords
};