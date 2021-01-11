'use strict';

const environment_utility= require('./environmentUtility');

const log = require('../logging/harper_logger');
const common = require('./commonUtility');
const auto_cast = require('../common_utils').autoCast;
const lmdb_terms = require('./terms');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const hdb_utils = require('../common_utils');
const cursor_functions = require('./searchCursorFunctions');
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb-store');

/** UTILITY CURSOR FUNCTIONS **/

/**
 * Creates the basis for a full iteration of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateFullIndex(env, hash_attribute, attribute, eval_function){
    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    try {
        for(let {key, value} of env.dbis[attribute].getRange({})){
            eval_function(key, value, results, hash_attribute, attribute);
        }
        return results;
    }catch(e){
        throw e;
    }
}

/**
 * Creates the basis for a forward/reverse range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {Function} eval_function
 * @param {Boolean} reverse
 * @returns {[]}
 */
function iterateRangeNext(env, hash_attribute, attribute, search_value, eval_function, reverse = false){
    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    try {
        search_value = auto_cast(search_value);
        search_value = common.convertKeyValueToWrite(search_value);
        let dbi = env.dbis[attribute];

        if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
            hash_attribute = attribute;
        }

        //because reversing only returns 1 entry from a dup sorted key we get all entries for the search value
        if(reverse === true){
            for(let value of dbi.getValues(search_value)){
                eval_function(search_value, search_value, value, results, hash_attribute, attribute);
            }
        }

        for(let {key, value} of dbi.getRange({start:search_value, reverse: reverse})){
            eval_function(search_value, key, value, results, hash_attribute, attribute);
        }

        return results;
    }catch(e){
        throw e;
    }
}

/**
 * specific iterator function for perfroming betweens on numeric columns
 * for this function specifically it is important to remember that the buffer representations of numbers are stored in the following order:
 * 0,1,2,3,4,5,6.....1000,-1,-2,-3,-4,-5,-6....-1000
 * as such we need to do some work with the cursor in order to move to the point we need depending on the type of range we are searching.
 * another important point to remember is the search is always iterating forward.  this makes sense for positive number searches,
 * but get wonky for negative number searches and especially for a range of between -4 & 6.  the reason is we will start the iterator at 0, move forward to 6,
 * then we need to jump forward to the highest negative number and stop at the start of our range (-4).
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Number|String} start_value
 * @param {Number|String} end_value
 * @returns {[]}
 */
function iterateRangeBetween(env, hash_attribute, attribute, start_value, end_value){

    try {
        let results = Object.create(null);
        let stat = environment_utility.statDBI(env, attribute);
        if (stat.entryCount === 0) {
            return results;
        }
        start_value = auto_cast(start_value);
        start_value = common.convertKeyValueToWrite(start_value);

        end_value = auto_cast(end_value);
        end_value = common.convertKeyValueToWrite(end_value);

        for(let {key, value} of env.dbis[attribute].getRange({start: start_value, end: end_value})){
            cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
        }

        for(let value of env.dbis[attribute].getValues(end_value)){
            cursor_functions.pushResults(end_value, value, results, hash_attribute, attribute);
        }
        return results;
    } catch(e){

        throw e;
    }
}

/**
 * iterates the entire  hash_attribute dbi and returns all objects back
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
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

    let results = iterateFullIndex(env, hash_attribute, hash_attribute, cursor_functions.searchAll.bind(null, fetch_attributes));
    return Object.values(results);
}

/**
* iterates the entire  hash_attribute dbi and returns all objects back in a map
* @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
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
    return iterateFullIndex(env, hash_attribute, hash_attribute, cursor_functions.searchAll.bind(null, fetch_attributes));
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

    return iterateFullIndex(env, attribute, attribute, cursor_functions.iterateDBI);
}

/**
 * counts all records in an environment based on the count from stating the hash_attribute  dbi
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
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
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function equals(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let dbi = environment_utility.openDBI(env, attribute);

    try {
        search_value = auto_cast(search_value);
        search_value = common.convertKeyValueToWrite(search_value);

        let results = Object.create(null);
        for (let value of dbi.getValues(search_value)) {
            cursor_functions.pushResults(search_value, value, results, hash_attribute, attribute);
        }

        if(Buffer.byteLength(search_value.toString()) > lmdb_terms.MAX_BYTE_SIZE) {
            blobSearch(env, hash_attribute, attribute, search_value, lmdb_terms.SEARCH_TYPES.EQUALS, results);
        }
        return results;
    }catch(e){
        throw e;
    }
}

/**
 *
 * @param env
 * @param hash_attribute
 * @param attribute
 * @param search_value
 * @param search_type
 * @param results
 * @returns {{}}
 */
function blobSearch(env, hash_attribute, attribute, search_value, search_type, results = []){
    try{
        let range_value = `${attribute}/`;

        for(let {key, value} of env.dbis[lmdb_terms.BLOB_DBI_NAME].getRange({start: range_value})){
            if(key.startsWith(range_value) === false){
                break;
            }

            let hash_value = key.replace(range_value, '');
            switch(search_type){
                case lmdb_terms.SEARCH_TYPES.EQUALS:
                    if(value === search_value){
                        addResultFromBlobSearch(hash_value, value, hash_attribute, attribute, results);
                    }
                    break;
                case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
                    if(value.startsWith(search_value) === true){
                        addResultFromBlobSearch(hash_value, value, hash_attribute, attribute, results);
                    }
                    break;
                case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
                    if(value.endsWith(search_value) === true){
                        addResultFromBlobSearch(hash_value, value, hash_attribute, attribute, results);
                    }
                    break;
                case lmdb_terms.SEARCH_TYPES.CONTAINS:
                    if(value.indexOf(search_value) >= 0){
                        addResultFromBlobSearch(hash_value, value, hash_attribute, attribute, results);
                    }
                    break;
                default:
                    break;
            }
        }

        return results;
    }catch(e){
        throw e;
    }
}

/**
 *
 * @param {String|Number} hash_value
 * @param {*} blob_value
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Object} results
 */
function addResultFromBlobSearch(hash_value, blob_value, hash_attribute, attribute, results){
    let new_object = Object.create(null);
    new_object[attribute] = auto_cast(blob_value);

    if(hash_attribute !== undefined) {
        new_object[hash_attribute] = auto_cast(hash_value);
    }

    results[hash_value] = new_object;
}

/**
 * performs an startsWith search on the key of a named dbi, returns a list of ids where their keys begin with the search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function startsWith(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    let dbi = environment_utility.openDBI(env, attribute);

    //if the search is numeric we need to scan the entire index, if string we can just do a range
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);
    let string_search = true;
    if(typeof search_value === 'number'){
        string_search = false;
    }

    for(let {key, value} of dbi.getRange({start: search_value})){
        if(key.toString().startsWith(search_value)){
            cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
        } else if(string_search === true){
            break;
        }
    }

    results = blobSearch(env, hash_attribute, attribute, search_value, lmdb_terms.SEARCH_TYPES.STARTS_WITH, results);
    return results;
}

/**
 * performs an endsWith search on the key of a named dbi, returns a list of ids where their keys end with search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function endsWith(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let results = iterateFullIndex(env, hash_attribute, attribute, cursor_functions.endsWith.bind(null, search_value));
    results = blobSearch(env, hash_attribute, attribute, search_value, lmdb_terms.SEARCH_TYPES.ENDS_WITH, results);
    return results;
}

/**
 * performs a contains search on the key of a named dbi, returns a list of ids where their keys contain the search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param {String|Number} search_value - value to search
 * @returns {[]} - ids matching the search
 */
function contains(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let results = iterateFullIndex(env, hash_attribute, attribute, cursor_functions.contains.bind(null, search_value));
    results = blobSearch(env, hash_attribute, attribute, search_value, lmdb_terms.SEARCH_TYPES.CONTAINS, results);
    return results;
}

/** RANGE FUNCTIONS **/

/**
 * performs a greater than search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function greaterThan(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);
    return iterateRangeNext(env, hash_attribute, attribute, search_value, cursor_functions.greaterThanCompare);
}

/**
 * performs a greater than equal search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function greaterThanEqual(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);
    return iterateRangeNext(env, hash_attribute, attribute, search_value, cursor_functions.greaterThanEqualCompare);
}

/**
 * performs a less than search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function lessThan(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);
    return iterateRangeNext(env, hash_attribute, attribute, search_value, cursor_functions.lessThanCompare, true);
}

/**
 * performs a less than equal search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function lessThanEqual(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);
    return iterateRangeNext(env, hash_attribute, attribute, search_value, cursor_functions.lessThanEqualCompare, true);
}

/**
 * performs a between search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} start_value
 * @param {String|Number}end_value
 * @returns {*[]}
 */
function between(env, hash_attribute, attribute, start_value, end_value){
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

    start_value = hdb_utils.autoCast(start_value);
    start_value = common.convertKeyValueToWrite(start_value);
    end_value = hdb_utils.autoCast(end_value);
    end_value = common.convertKeyValueToWrite(end_value);
    if (start_value >= end_value) {
        throw new Error(LMDB_ERRORS.END_VALUE_MUST_BE_GREATER_THAN_START_VALUE);
    }

    return iterateRangeBetween(env, hash_attribute, attribute, start_value, end_value);
}

/**
 * finds a single record based on the id passed
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
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

    id = auto_cast(id);

    try {
        let obj = null;
        let object = env.dbis[hash_attribute].get(id);

        if (object) {
            obj = cursor_functions.parseRow(object, fetch_attributes);
        }
        return obj;
    }catch(e){
        throw e;
    }
}

/**
 * checks if a hash value exists based on the id passed
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
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

    try {
        id = auto_cast(id);
        let found_key = true;

        let value = env.dbis[hash_attribute].get(id);

        if (value === undefined) {
            found_key = false;
        }
        return found_key;
    }catch(e){
        throw e;
    }
}

/**
 * finds an array of records based on the ids passed
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Array.<Object>} - object array of records found
 */
function batchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found = []) {
    initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

    let results = batchHashSearch(env, hash_attribute, fetch_attributes, ids, not_found);

    return Object.values(results);
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {{}} - object array of records found
 */
function batchSearchByHashToMap(env, hash_attribute, fetch_attributes, ids, not_found = []) {
    initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

    return batchHashSearch(env, hash_attribute, fetch_attributes, ids, not_found);
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Object}
 */
function batchHashSearch(env, hash_attribute, fetch_attributes, ids, not_found = []){
    let results = Object.create(null);

    for(let x = 0; x < ids.length; x++){
        let id = auto_cast(ids[x]);
        try {
            let object = env.dbis[hash_attribute].get(id);
            if(object) {
                let obj = cursor_functions.parseRow(object, fetch_attributes);
                results[id] = obj;
            }else {
                not_found.push(id);
            }
        }catch(e){
            log.warn(e);
        }
    }

    return results;
}

/**
 * function used to intialize the batchSearchByHash functions
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
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
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
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
