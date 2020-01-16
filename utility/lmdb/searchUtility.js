'use strict';

const data_stores= require('./environmentUtility');
const Transaction_Cursor = require('./TransactionCursor');
const lmdb = require('node-lmdb');

/**
 *
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {Array.<Object>} fetch_attributes
 * @returns {[]}
 */
function searchAll(env, hash_attribute, fetch_attributes){
    validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error('hash_attribute is required');
    }

    validateFetchAttributes(fetch_attributes);

    let txn = new Transaction_Cursor(env, hash_attribute);

    let results = [];
    for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
        let obj = {};
        let value = JSON.parse(txn.cursor.getCurrentString());

        for(let x = 0; x < fetch_attributes.length; x++){
            let attribute = fetch_attributes[x];
            obj[attribute] = value[attribute];
        }

        results.push(obj);
    }

    txn.close();
    return results;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @returns {number}
 */
function countAll(env, hash_attribute){
    validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error('hash_attribute is required');
    }

    let stat = data_stores.statDBI(env, hash_attribute);
    return stat.entryCount;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param search_value
 * @returns {[]}
 */
function equals(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let txn = new Transaction_Cursor(env, attribute);

    let results = [];
    for (let found = txn.cursor.goToKey(search_value); found !== null; found = txn.cursor.goToNextDup()) {
        let value = txn.cursor.getCurrentString();
        results.push(value);
    }
    txn.close();
    return results;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param search_value
 * @returns {[]}
 */
function startsWith(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let txn = new Transaction_Cursor(env, attribute);

    let results = [];
    for (let found = txn.cursor.goToRange(search_value); found !== null; found = txn.cursor.goToNext()) {
        let value = txn.cursor.getCurrentString();

        if(found.startsWith(search_value)){
            results.push(value);
        } else{
            txn.cursor.goToLast();
        }
    }
    txn.close();
    return results;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param search_value
 * @returns {[]}
 */
function endsWith(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let txn = new Transaction_Cursor(env, attribute);

    let results = [];
    for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
        let value = txn.cursor.getCurrentString();
        if(found.endsWith(search_value)){
            results.push(value);
        }
    }
    txn.close();
    return results;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param search_value
 * @returns {[]}
 */
function contains(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let txn = new Transaction_Cursor(env, attribute);

    let results = [];
    for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
        //let value = cursor.getCurrentString();
        if(found.includes(search_value)){
            results.push(txn.cursor.getCurrentString());
        }
    }
    txn.close();
    return results;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {Array.<String>} fetch_attributes
 * @param {String} id
 * @returns {{}}
 */
function searchByHash(env, hash_attribute, fetch_attributes, id) {
    validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error('hash_attribute is required');
    }

    validateFetchAttributes(fetch_attributes);

    if(id === undefined){
        throw new Error('id is required');
    }

    let txn = new Transaction_Cursor(env, hash_attribute);

    let obj = null;
    let found = txn.cursor.goToKey(id);
    if(found === id) {
        obj = {};
        let value = JSON.parse(txn.cursor.getCurrentString());

        fetch_attributes.forEach(attribute => {
            obj[attribute] = value[attribute];
        });
    }
    txn.close();
    return obj;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} id
 * @returns {boolean}
 */
function checkHashExists(env, hash_attribute, id) {
    validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error('hash_attribute is required');
    }

    if(id === undefined){
        throw new Error('id is required');
    }

    let found_key = true;
    let txn = new Transaction_Cursor(env, hash_attribute);

    let key = txn.cursor.goToKey(id);

    if(key !== id){
        found_key = false;
    }

    txn.close();
    return found_key;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {Array.<String>} fetch_attributes
 * @param {Array.<String>} ids
 * @returns {[]}
 */
function batchSearchByHash(env, hash_attribute, fetch_attributes, ids) {
    validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error('hash_attribute is required');
    }

    validateFetchAttributes(fetch_attributes);

    if(ids === undefined){
        throw new Error('ids is required');
    }

    if(!Array.isArray(ids)){
        throw new Error('ids must be an array');
    }

    let txn = new Transaction_Cursor(env, hash_attribute);

    let results = [];

    for(let x = 0; x < ids.length; x++){
        let id = ids[x];
        try {
            let key = txn.cursor.goToKey(id);
            if(key === id) {
                let orig = JSON.parse(txn.cursor.getCurrentString());
                let obj = {};

                fetch_attributes.forEach(attribute => {
                    obj[attribute] = orig[attribute];
                });
                results.push(obj);
            }
        }catch(e){

        }
    }

    txn.close();

    return results;
}

/**
 *
 * @param env
 */
function validateEnv(env){
    if(env === undefined){
        throw new Error('env is required');
    }

    if(!(env instanceof lmdb.Env)){
        throw new Error('invalid environment object');
    }
}

function validateFetchAttributes(fetch_attributes){
    if(fetch_attributes === undefined){
        throw new Error('fetch_attributes is required');
    }

    if(! Array.isArray(fetch_attributes)){
        throw new Error('fetch_attributes must be an array');
    }
}

function validateComparisonFunctions(env, attribute, search_value){
    validateEnv(env);
    if(attribute === undefined){
        throw new Error('attribute is required');
    }

    if(search_value === undefined){
        throw new Error('search_value is required');
    }
}

module.exports = {
    searchAll,
    countAll,
    equals,
    startsWith,
    endsWith,
    contains,
    searchByHash,
    batchSearchByHash,
    checkHashExists
};