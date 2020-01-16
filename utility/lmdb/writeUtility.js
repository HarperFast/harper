"use strict";
const lmdb = require('node-lmdb');
const environment_util = require('./environmentUtility');
const LMDB_ERRORS = require('../commonErrors').LMDB_ERRORS_ENUM;

const MAX_BYTE_SIZE = 511;

/**
 * inserts records into LMDB
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @returns {{written: [], skipped: []}}
 */
function insertRecords(env, hash_attribute, write_attributes , records){
    validateInsert(env, hash_attribute, write_attributes , records);

    let txn = undefined;
    try {

        //dbis must be opened / created before starting the transaction
        initializeDBIs(env, hash_attribute, write_attributes);

        txn = env.beginTxn();

        let result = {
            written: [],
            skipped: []
        };
        for(let k = 0; k < records.length; k++){
            let record = records[k];
            let primary_key = record[hash_attribute].toString();
//TODO when search is implemented add check key exists
            for (let x = 0; x < write_attributes.length; x++){
                let attribute = write_attributes[x];

                if (attribute === hash_attribute) {
                    txn.putString(env.dbis[attribute], primary_key, JSON.stringify(record));
                } else {
                    let value = stringifyData(record[attribute]);
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
 * common validation function for env, hash_attribute & fetch_attributes
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 */
function validateBasic(env, hash_attribute, write_attributes){
    if(!(env instanceof lmdb.Env)){
        if(env === undefined){
            throw LMDB_ERRORS.ENV_REQUIRED;
        }

        throw LMDB_ERRORS.INVALID_ENVIRONMENT;
    }

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
function validateInsert(env, hash_attribute, write_attributes , records){
    validateBasic(env, hash_attribute, write_attributes);

    if(!Array.isArray(records)){
        if(records === undefined){
            throw LMDB_ERRORS.RECORDS_REQUIRED;
        }

        throw LMDB_ERRORS.RECORDS_MUST_BE_ARRAY;
    }
}

/**
 * converts raw data to it's string version
 * @param raw_value
 * @returns {string|null}
 */
function stringifyData(raw_value){
    if(raw_value === null || raw_value === undefined || raw_value === ''){
        return null;
    }

    let value;
    try {
        value = typeof raw_value === 'object' ? JSON.stringify(raw_value) : raw_value.toString();
    } catch(e){
        value = raw_value.toString();
    }

    //LMDB has a 511 byte limit for keys, so we return null if the byte size is larger than 511 to not index that value
    if(Buffer.byteLength(value) > MAX_BYTE_SIZE){
        return null;
    }

    return value;
}

/**
 * opens/ creates all specified attributes
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 */
function initializeDBIs(env, hash_attribute, write_attributes){
    for(let x = 0; x < write_attributes.length; x++){
        let attribute = write_attributes[x];
        try {
            environment_util.openDBI(env, attribute);
        } catch (e) {
            if (e.message === 'dbi does not exist') {
                environment_util.createDBI(env, attribute, attribute !== hash_attribute );
            } else {
                throw e;
            }
        }
    }
}

module.exports = {
    insertRecords
};