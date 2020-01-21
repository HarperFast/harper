"use strict";
const lmdb = require('node-lmdb');
const environment_util = require('./environmentUtility');
const common = require('./commonUtility');
const search_utility = require('./searchUtility');
const LMDB_ERRORS = require('../commonErrors').LMDB_ERRORS_ENUM;

/**
 * inserts records into LMDB
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @returns {{written: [], skipped: []}}
 */
function insertRecords(env, hash_attribute, write_attributes , records){
    validateWrite(env, hash_attribute, write_attributes , records);

    let txn = undefined;
    try {

        //dbis must be opened / created before starting the transaction
        environment_util.initializeDBIs(env, hash_attribute, write_attributes);

        txn = env.beginTxn();

        let result = {
            written: [],
            skipped: []
        };
        for(let k = 0; k < records.length; k++){
            let record = records[k];
            let primary_key = record[hash_attribute].toString();

            // with the flag noOverwrite: true we can force lmdb to throw an error if the key already exists.
            // this allows us to auto check if the row already exists
            try {
                txn.putString(env.dbis[hash_attribute], primary_key, JSON.stringify(record), {noOverwrite: true});
            } catch(e){
                if(e.message.startsWith('MDB_KEYEXIST') === true){
                    result.skipped.push(primary_key);
                    continue;
                }else{
                    throw e;
                }
            }

            for (let x = 0; x < write_attributes.length; x++){
                let attribute = write_attributes[x];

                if (attribute !== hash_attribute) {
                    let value = common.stringifyData(record[attribute]);
                    if(value !== null) {
                        txn.putString(env.dbis[attribute], value, primary_key);
                    }
                }
            }
            result.written.push(primary_key);
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
 * inserts records into LMDB
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @returns {{written: [], skipped: []}}
 */
function updateRecords(env, hash_attribute, write_attributes , records){
    //validate
    validateWrite(env, hash_attribute, write_attributes , records);

    let txn = undefined;
    try {

    //init all dbis
        //dbis must be opened / created before starting the transaction
        environment_util.initializeDBIs(env, hash_attribute, write_attributes);

        //create write transaction to lock data changes rows
        txn = env.beginTxn();

        let result = {
            written: [],
            skipped: []
        };

        //iterate update records
        for(let x = 0; x < records.length; x++){
            let record = records[x];
            let hash_value = record[hash_attribute].toString();
            //grab existing record
            let existing_record = search_utility.searchByHash(env, hash_attribute, write_attributes, hash_value);

            if(existing_record === null){
                result.skipped.push(hash_value);
                continue;
            }

            //iterate the entries from the record
            for (let [key, value] of Object.entries(record)) {
                if(key === hash_attribute){
                    continue;
                }

                let existing_value = existing_record[key];

                let str_new_value = common.stringifyData(value);
                let str_existing_value = common.stringifyData(existing_value);

                //if the update cleared out the attribute value we need to delete it from the index
                if(str_existing_value !== null) {
                    txn.del(env.dbis[key], str_existing_value, hash_value);
                }

                if(str_new_value !== null){
                    txn.putString(env.dbis[key], str_new_value, hash_value);
                }
            }

            let merged_record = Object.assign(existing_record, record);
            txn.putString(env.dbis[hash_attribute], hash_value.toString(), JSON.stringify(merged_record));
            result.written.push(hash_value);
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
        throw LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED;
    }

    if(!Array.isArray(write_attributes)){
        if(write_attributes === undefined){
            throw LMDB_ERRORS.WRITE_ATTRIBUTES_REQUIRED;
        }

        throw LMDB_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY;
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
            throw LMDB_ERRORS.RECORDS_REQUIRED;
        }

        throw LMDB_ERRORS.RECORDS_MUST_BE_ARRAY;
    }
}

module.exports = {
    insertRecords,
    updateRecords
};