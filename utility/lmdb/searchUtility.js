'use strict';

const environment_utility= require('./environmentUtility');
const Transaction_Cursor = environment_utility.TransactionCursor;
const lmdb = require('node-lmdb');
const log = require('../logging/harper_logger');
const common = require('./commonUtility');
const lmdb_terms = require('./terms');
const hdb_terms = require('../hdbTerms');
const LMDB_ERRORS = require('../commonErrors').LMDB_ERRORS_ENUM;
const hdb_utils = require('../common_utils');
const cursor_functions = require('./searchCursorFunctions');

/** UTILITY CURSOR FUNCTIONS **/

/**
 * Creates the basis for a full iteration of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateFullIndex(env, attribute, eval_function){
    let results = [];
    let txn = new Transaction_Cursor(env, attribute);
    for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
        eval_function(found, txn.cursor, results);
    }
    txn.close();
    return results;
}

/**
 * Creates the basis for a full iteration of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateFullIndexToMap(env, attribute, eval_function){
    let results = Object.create(null);
    let txn = new Transaction_Cursor(env, attribute);
    for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
        eval_function(found, txn.cursor, results);
    }
    txn.close();
    return results;
}

/**
 * Creates the basis for a forward range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateRangeNext(env, attribute, search_value, eval_function){
    let txn = new Transaction_Cursor(env, attribute);

    if(txn.int_key === true){
        search_value = parseInt(search_value);
    }

    //if the first value in the dbi is less than the search value then we seek to the value, otherwise we keep the cursor at the first item
    let found = txn.cursor.goToFirst();
    if((isNaN(found) === true && found.toString() < search_value.toString()) || (isNaN(found) === false && Number(found) < search_value)){
        found = txn.cursor.goToRange(search_value);
    }

    let results = [];
    for (found; found !== null; found = txn.cursor.goToNext()) {
        eval_function(search_value, found, txn.cursor, results);
    }
    txn.close();
    return results;
}

/**
 * Creates the basis for a previous range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateRangePrev(env, attribute, search_value, eval_function){
    let txn = new Transaction_Cursor(env, attribute);

    if(txn.int_key === true){
        search_value = parseInt(search_value);
    }

    let results = [];
    //if the last value in the dbi is greater than the search value then we seek to the value, otherwise we keep the cursor at the last item
    let found = txn.cursor.goToLast();
    if((isNaN(found) === true && found > search_value.toString()) || (isNaN(found) === false && Number(found) > search_value)){
        found = txn.cursor.goToRange(search_value);
    }

    for (found; found !== null; found = txn.cursor.goToPrev()) {
        eval_function(search_value, found, txn.cursor, results);
    }
    txn.close();
    return results;
}

/**
 * determines if the intent is to return the whole row based on fetch_attributes having 1 entry that is wildcard * or %
 * @param fetch_attributes
 * @returns {boolean}
 */
function setGetWholeRowFlag(fetch_attributes){
    let get_whole_row = false;
    if(fetch_attributes.length === 1 && hdb_terms.SEARCH_WILDCARDS.indexOf(fetch_attributes[0]) >= 0){
        get_whole_row = true;
    }

    return get_whole_row;
}

/**
 * iterates the entire  hash_attribute dbi and returns all objects back
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @returns {Array.<Object>} - object array of fetched records
 */
function searchAll(env, hash_attribute, fetch_attributes){
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    validateFetchAttributes(fetch_attributes);

    let get_whole_row = setGetWholeRowFlag(fetch_attributes);

    return iterateFullIndex(env, hash_attribute, cursor_functions.searchAll.bind(null, fetch_attributes, get_whole_row));
}

/**
* iterates the entire  hash_attribute dbi and returns all objects back in a map
* @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
* @param {String} hash_attribute - name of the hash_attribute for this environment
* @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
* @returns {{String|Number, Object}} - object array of fetched records
*/
function searchAllToMap(env, hash_attribute, fetch_attributes){
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    validateFetchAttributes(fetch_attributes);

    let get_whole_row = setGetWholeRowFlag(fetch_attributes);

    return iterateFullIndexToMap(env, hash_attribute, cursor_functions.searchAllToMap.bind(null, fetch_attributes, get_whole_row));
}

/**
 * iterates a dbi and returns the key/value pairing for each entry
 * @param env
 * @param attribute
 * @returns {Array.<Array>}
 */
function iterateDBI(env, attribute){
    common.validateEnv(env);
    if(attribute === undefined){
        throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
    }

    return iterateFullIndex(env, attribute, cursor_functions.iterateDBI);
}

/**
 * counts all records in an environment based on the count from stating the hash_attribute  dbi
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @returns {number} - number of records in the environment
 */
function countAll(env, hash_attribute){
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    let stat = environment_utility.statDBI(env, hash_attribute);
    return stat.entryCount;
}

/**
 * performs an equal search on the key of a named dbi, returns a list of ids where their keys literally match the search_value
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function equals(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let txn = new Transaction_Cursor(env, attribute);

    if(txn.int_key === true){
        search_value = parseInt(search_value);
    }

    let results = [];
    for (let found = txn.cursor.goToKey(search_value); found !== null; found = txn.cursor.goToNextDup()) {
        let value = txn.cursor.getCurrentString();
        results.push(value);
    }
    txn.close();
    return results;
}

/**
 * performs an startsWith search on the key of a named dbi, returns a list of ids where their keys begin with the search_value
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function startsWith(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);
    let dbi = environment_utility.openDBI(env, attribute);
    return iterateRangeNext(env, attribute, search_value, cursor_functions.startsWith.bind(null, dbi[lmdb_terms.DBI_DEFINITION_NAME].int_key));
}

/**
 * performs an endsWith search on the key of a named dbi, returns a list of ids where their keys end with search_value
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function endsWith(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    return iterateFullIndex(env, attribute, cursor_functions.endsWith.bind(null, search_value));
}

/**
 * performs a cotains search on the key of a named dbi, returns a list of ids where their keys contain the search_value
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param {String|Number} search_value - value to search
 * @returns {[]} - ids matching the search
 */
function contains(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    return iterateFullIndex(env, attribute, cursor_functions.contains.bind(null, search_value));
}

/** RANGE FUNCTIONS **/

/**
 * performs standard validation on range functions
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {{}}
 */
function initializeRangeFunction(env, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let dbi = environment_utility.openDBI(env, attribute);
    let search_info = new Object(null);
    search_info.search_value_is_numeric = isNaN(search_value) === false;
    search_info.dbi_numeric_key = dbi[lmdb_terms.DBI_DEFINITION_NAME].int_key;


    //if we are trying to compare a non-numeric value to numeric keys we throw an error
    if(search_info.search_value_is_numeric === false && search_info.dbi_numeric_key === true){
        throw new Error(LMDB_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS);
    }

    return search_info;
}

/**
 * performs a greater than search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function greaterThan(env, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, attribute, cursor_functions.greaterThanStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, attribute, cursor_functions.greaterThanStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        //add 1 to the search value because we want everything greater than the search value & the key is an int
        return iterateRangeNext(env, attribute, parseInt(search_value) + 1, cursor_functions.addResult);
    }
}

/**
 * performs a greater than equal search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function greaterThanEqual(env, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, attribute, cursor_functions.greaterThanEqualStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, attribute, cursor_functions.greaterThanEqualStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        return iterateRangeNext(env, attribute, parseInt(search_value), cursor_functions.addResult);
    }
}

/**
 * performs a less than search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function lessThan(env, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, attribute, cursor_functions.lessThanStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, attribute, cursor_functions.lessThanStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        return iterateRangePrev(env, attribute, parseInt(search_value), cursor_functions.lessThanNumericCompare);
    }
}

/**
 * performs a less than equal search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function lessThanEqual(env, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, attribute, cursor_functions.lessThanEqualStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, attribute, cursor_functions.lessThanEqualStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        //need to add 1 to the value other wise when prev is called it skips all but the first entry of the search_value
        return iterateRangePrev(env, attribute, parseInt(search_value) + 1, cursor_functions.lessThanEqualNumericCompare);
    }
}

/**
 * performs a between search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} attribute
 * @param {String|Number} start_value
 * @param {String|Number}end_value
 * @returns {*[]}
 */
function between(env, attribute, start_value, end_value){
    common.validateEnv(env);
    if(attribute === undefined){
        throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
    }

    if(start_value === undefined){
        throw new Error(LMDB_ERRORS.START_VALUE_REQUIRED);
    }

    if(end_value === undefined){
        throw new Error(LMDB_ERRORS.END_VALUE_REQUIRED);
    }

    if( start_value >= end_value){
        throw new Error(LMDB_ERRORS.END_VALUE_MUST_BE_GREATER_THAN_START_VALUE);
    }

    let dbi = environment_utility.openDBI(env, attribute);
    let dbi_int_key = dbi[lmdb_terms.DBI_DEFINITION_NAME].int_key;

    //if we are trying to compare a non-numeric value to numeric keys we throw an error
    if((isNaN(start_value) === true || isNaN(end_value) === true) && dbi_int_key === true){
        throw new Error(LMDB_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS);
    }

    if(dbi_int_key === false && (isNaN(start_value) === true || isNaN(end_value) === true)){
        return iterateFullIndex(env, attribute, cursor_functions.betweenStringCompare.bind(null, start_value.toString(), end_value.toString()));
    }

    if(dbi_int_key === false && isNaN(start_value) === false && isNaN(end_value) === false){
        return iterateFullIndex(env, attribute, cursor_functions.betweenStringToNumberCompare.bind(null, Number(start_value), Number(end_value)));
    }

    return iterateRangeNext(env, attribute, parseInt(start_value), cursor_functions.betweenNumericCompare.bind(null, parseInt(end_value)));
}

/**
 * finds a single record based on the id passed
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {String} id - id value to search
 * @returns {{}} - object found
 */
function searchByHash(env, hash_attribute, fetch_attributes, id) {
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    validateFetchAttributes(fetch_attributes);

    if(id === undefined){
        throw new Error(LMDB_ERRORS.ID_REQUIRED);
    }

    let get_whole_row = setGetWholeRowFlag(fetch_attributes);

    let txn = new Transaction_Cursor(env, hash_attribute);

    let obj = null;
    let found = txn.cursor.goToKey(id);
    if(found === id) {
        obj = cursor_functions.parseRow(txn.cursor, get_whole_row, fetch_attributes);
    }
    txn.close();
    return obj;
}

/**
 * checks if a hash value exists based on the id passed
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {String|Number} id - id value to check exists
 * @returns {boolean} - whether the hash exists (true) or not (false)
 */
function checkHashExists(env, hash_attribute, id) {
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    if(id === undefined){
        throw new Error(LMDB_ERRORS.ID_REQUIRED);
    }

    let found_key = true;
    let txn = new Transaction_Cursor(env, hash_attribute);

    if(txn.int_key === true){
        id = parseInt(id);
    }

    let key = txn.cursor.goToKey(id);

    if(key !== id){
        found_key = false;
    }

    txn.close();
    return found_key;
}

/**
 * finds an array of records based on the ids passed
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Array.<Object>} - object array of records found
 */
function batchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found) {
    let txn = initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

    let get_whole_row = setGetWholeRowFlag(fetch_attributes);

    let results = [];

    for(let x = 0; x < ids.length; x++){
        let id = ids[x];
        try {
            let key = txn.cursor.goToKey(id);
            if(key === id) {
                cursor_functions.searchAll(fetch_attributes, get_whole_row, key, txn.cursor, results);
            }else {
                not_found.push(hdb_utils.autoCast(id));
            }
        }catch(e){
            log.warn(e);
        }
    }

    txn.close();

    return results;
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {{}} - object array of records found
 */
function batchSearchByHashToMap(env, hash_attribute, fetch_attributes, ids, not_found) {
    let txn = initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

    let results = Object.create(null);

    let get_whole_row = setGetWholeRowFlag(fetch_attributes);

    for(let x = 0; x < ids.length; x++){
        let id = ids[x];
        try {
            let key = txn.cursor.goToKey(id);
            if(key === id) {
                let obj = cursor_functions.parseRow(txn.cursor, get_whole_row, fetch_attributes);
                results[id] = obj;
            }else {
                not_found.push(hdb_utils.autoCast(id));
            }
        }catch(e){
            log.warn(e);
        }
    }

    txn.close();

    return results;
}

/**
 * function used to intialize the batchSearchByHash functions
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] -optional,  meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {TransactionCursor}
 */
function initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found){
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    validateFetchAttributes(fetch_attributes);

    if(!Array.isArray(ids)){
        if(ids === undefined){
            throw new Error(LMDB_ERRORS.IDS_REQUIRED);
        }

        throw new Error(LMDB_ERRORS.IDS_MUST_BE_ARRAY);
    }

    if(!Array.isArray(not_found)){
        not_found = [];
    }

    return new Transaction_Cursor(env, hash_attribute);
}

/**
 * validates the fetch_attributes argument
 * @param fetch_attributes - string array of attributes to pull from the object
 */
function validateFetchAttributes(fetch_attributes){
    if(!Array.isArray(fetch_attributes)){
        if(fetch_attributes === undefined){
            throw new Error(LMDB_ERRORS.FETCH_ATTRIBUTES_REQUIRED);
        }
        throw new Error(LMDB_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY);
    }


}

/**
 * common validation function for all of the comparison searches (equals, startsWith, endsWith, contains)
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 */
function validateComparisonFunctions(env, attribute, search_value){
    common.validateEnv(env);
    if(attribute === undefined){
        throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
    }

    if(search_value === undefined){
        throw new Error(LMDB_ERRORS.SEARCH_VALUE_REQUIRED);
    }
}

module.exports = {
    searchAll,
    searchAllToMap,
    countAll,
    equals,
    startsWith,
    endsWith,
    contains,
    searchByHash,
    batchSearchByHash,
    batchSearchByHashToMap,
    checkHashExists,
    iterateDBI,
    greaterThan,
    greaterThanEqual,
    lessThan,
    lessThanEqual,
    between
};