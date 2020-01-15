'use strict';

const data_stores= require('./environmentUtility');
const Transaction_Cursor = require('./TransactionCursor');
const lmdb = require('node-lmdb');

/**
 *
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {Array.<Object>} fetch_attributes
 * @returns {[]}
 */
function searchAll(env, attribute, fetch_attributes){
    let txn = new Transaction_Cursor(env, attribute);

    let results = [];
    for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
        results.push(JSON.parse(txn.cursor.getCurrentString()));
    }

    txn.close();
    return results;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @returns {number}
 */
function countAll(env, attribute){
    let stat = data_stores.statDBI(env, attribute);
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
    let txn = new Transaction_Cursor(env, attribute);

    let results = [];
    for (let found = (txn.cursor.goToKey(search_value) === search_value); found !== null; found = txn.cursor.goToNextDup()) {
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
function getById(env, hash_attribute, fetch_attributes, id) {
    validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error('hash_attribute is required');
    }

    validateFetchAttributes(fetch_attributes);

    if(id === undefined){
        throw new Error('id is required');
    }


    let txn = new Transaction_Cursor(env, hash_attribute);

    txn.cursor.goToKey(id);

    let value = JSON.parse(txn.cursor.getCurrentString());
    let obj = {};

    fetch_attributes.forEach(attribute=>{
        obj[attribute] = value[attribute];
    });

    txn.close();
    return obj;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} primary_attribute
 * @param {String} id
 * @returns {boolean}
 */
function checkKeyExists(env, primary_attribute, id) {
    let found_key = true;
    let txn = new Transaction_Cursor(env, primary_attribute);

    let key = txn.cursor.goToKey(id);

    if(key === null || key === undefined){
        found_key = false;
    }

    txn.close();
    return found_key;
}

/**
 *
 * @param {lmdb.Env} env
 * @param {String} primary_attribute
 * @param {Array.<String>} fetch_attributes
 * @param {Array.<String>} ids
 * @returns {[]}
 */
function batchGetById(env, primary_attribute, fetch_attributes, ids) {

    let txn = new Transaction_Cursor(env, primary_attribute);

    let results = [];
    ids.forEach(id=>{
        try {
            txn.cursor.goToKey(id);

            let orig = JSON.parse(txn.cursor.getCurrentString());
            let obj = {};

            fetch_attributes.forEach(attribute=>{
                obj[attribute] = orig[attribute];
            });
            results.push(obj);
        }catch(e){
            console.error(e);
        }
    });

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

module.exports = {
    searchAll,
    countAll,
    equals,
    startsWith,
    endsWith,
    contains,
    getById,
    batchGetById,
    checkKeyExists
};