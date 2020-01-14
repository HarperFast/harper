"use strict";
const lmdb = require('node-lmdb');
const environment_util = require('./environmentUtility');
const MAX_BYTE_SIZE = 511;

/**
 * inserts records into LMDB
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} all_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @returns {{written: [], skipped: []}}
 */
function insertRecords(env, hash_attribute, all_attributes , records){
    validateInsert(env, hash_attribute, all_attributes , records);

    let txn = undefined;
    try {

        //dbis must be opened / created before starting the transaction
        initializeDBIs(env, records,hash_attribute, all_attributes);

        txn = env.beginTxn();

        let result = {
            written: [],
            skipped: []
        };
        for(let k = 0; k < records.length; k++){
            let record = records[k];
            let primary_key = record[hash_attribute].toString();
//TODO when search is implemented add check key exists
            for (let x = 0; x < all_attributes.length; x++){
                let attribute = all_attributes[x];

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
        console.log(e);
        if(txn !== undefined){
            txn.abort();
        }
        throw e;
    }
}

/**
 * validates the parameters for LMDB
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} all_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 */
function validateInsert(env, hash_attribute, all_attributes , records){
    if(env === undefined){
        throw new Error('env is required');
    }

    if(hash_attribute === undefined){
        throw new Error('hash_attribute is required');
    }

    if(all_attributes === undefined){
        throw new Error('all_attributes is required');
    }

    if(!Array.isArray(all_attributes)){
        throw new Error('all_attributes must be an array');
    }

    if(records === undefined){
        throw new Error('records is required');
    }

    if(!Array.isArray(records)){
        throw new Error('records must be an array');
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

    if(Buffer.byteLength(value) > MAX_BYTE_SIZE){
        return null;
    }

    return value;
}

/**
 * opens/ creates all specified attributes
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} all_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 */
function initializeDBIs(env, records, hash_attribute, all_attributes){
    for(let x = 0; x < all_attributes.length; x++){
        let attribute = all_attributes[x];
        try {
            environment_util.openDBI(env, attribute);
        } catch (e) {
            if (e.message.startsWith('MDB_NOTFOUND') === true) {
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