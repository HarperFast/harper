'use strict';

const environment_utility= require('./environmentUtility');
const TransactionCursor = environment_utility.TransactionCursor;
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

    let txn = undefined;
    try {
        txn = new TransactionCursor(env, attribute);
        for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
            let key_value = common.convertKeyValueFromSearch(found, txn.key_type);
            eval_function(key_value, txn, results, hash_attribute, attribute);
        }
        txn.close();
        return results;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

        throw e;
    }
}

/**
 * Creates the basis for a full iteration of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateFullIndexToMap(env, hash_attribute, attribute, eval_function){
    let results = Object.create(null);

    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }
    let txn = undefined;
    try {
        txn = new TransactionCursor(env, attribute);
        for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
            let key_value = common.convertKeyValueFromSearch(found, txn.key_type);
            eval_function(key_value, txn, results, hash_attribute, attribute);
        }
        txn.close();
        return results;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

        throw e;
    }
}

/**
 * Creates the basis for a forward range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateRangeNext(env, hash_attribute, attribute, search_value, eval_function){
    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    let txn = undefined;
    try {
        txn = new TransactionCursor(env, attribute);

        //if the first value in the dbi is less than the search value then we seek to the value, otherwise we keep the cursor at the first item
        let found = txn.cursor.goToFirst();
        let found_converted = common.convertKeyValueFromSearch(found, txn.key_type);

        if ((isNaN(found_converted) === true && found_converted.toString() < search_value.toString()) || (isNaN(found_converted) === false && Number(found_converted) < search_value)) {
            let search_value_converted = common.convertKeyValueToWrite(search_value, txn.key_type);
            found = txn.cursor.goToRange(search_value_converted);
        }

        for (found; found !== null; found = txn.cursor.goToNext()) {
            let key_value = common.convertKeyValueFromSearch(found, txn.key_type);
            eval_function(search_value, key_value, txn, results, hash_attribute, attribute);
        }
        txn.close();
        return results;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

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
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Number} start_value
 * @param {Number} end_value
 * @returns {[]}
 */
function iterateRangeBetween(env, hash_attribute, attribute, start_value, end_value){
    let txn = undefined;
    try {
        let results = Object.create(null);
        let stat = environment_utility.statDBI(env, attribute);
        if (stat.entryCount === 0) {
            return results;
        }

        txn = new TransactionCursor(env, attribute);
        let first_key = txn.cursor.goToFirst();
        let last_key = txn.cursor.goToLast();
        let first_key_value = first_key.readDoubleBE(0);
        let last_key_value = last_key.readDoubleBE(0);
        let find_max_converted = common.convertKeyValueToWrite(Number.MIN_VALUE * -1, txn.key_type);
        let min_value;
        let max_value;
        if (first_key_value < 0 && last_key_value < 0) {
            min_value = last_key;
            max_value = first_key;
        } else if (first_key_value > 0 && last_key_value > 0) {
            min_value = first_key;
            max_value = last_key;
        } else {
            min_value = last_key;

            txn.cursor.goToRange(find_max_converted);
            max_value = txn.cursor.goToPrev();
        }

        let start_value_converted = common.convertKeyValueToWrite(start_value, txn.key_type);
        let end_value_converted = common.convertKeyValueToWrite(end_value, txn.key_type);

        //determine the maximum key we need to iterate towards
        let end_key = txn.cursor.goToRange(end_value_converted);
        if (end_key === null) {
            end_key = max_value;
        }
        if (end_value >= 0 && end_key.readDoubleBE(0) < 0) {
            end_key = max_value;
        }

        //determine the starting point for the iterator.
        let start_key;
        //if end_value is a positive and  start_value is negative we will start at the beginning of the lowest positive number which is the beginning of the iterator,
        // otherwise we jump the iterator to the start value, that would be when the values are both positive or both negative
        if (end_value >= 0 && start_value < 0) {
            start_key = txn.cursor.goToFirst();
        } else {
            start_key = txn.cursor.goToRange(start_value_converted);
        }

        if (start_key === null) {
            start_key = min_value;
        }

        //in the scenario where both values are negative we need to swap them, this is because negative numbers are ordered highest to lowest.  i.e. -1,-2,-3,...-1000.  our end point then is actually based on our start_value
        if (start_value < 0 && end_value < 0) {
            [start_key, end_key] = [end_key, start_key];
        }

        let end_key_value = end_key.readDoubleBE(0);

        let met_end_value = false;

        for (let found = txn.cursor.goToRange(start_key); found !== null; found = txn.cursor.goToNext()) {
            let key_value = common.convertKeyValueFromSearch(found, txn.key_type);
            if (key_value === end_key_value) {
                met_end_value = true;
            }

            if (met_end_value === true && key_value !== end_key_value) {
                if (end_key_value >= 0 && start_value < 0) {
                    //when we have a scenario where end_value is positive and start_value is negative we first search all the positive numbers from the beginning of the iterator.
                    // we then need to jump ahead to search negative values. and we change the end_key_value to be the start_key.
                    txn.cursor.goToRange(find_max_converted);
                    txn.cursor.goToPrev();
                    met_end_value = false;
                    end_key_value = start_key.readDoubleBE(0);
                    continue;
                }

                txn.cursor.goToLast();
            }

            if (key_value >= start_value && key_value <= end_value) {
                cursor_functions.pushResults(key_value, txn, results, hash_attribute, attribute);
            }
        }
        txn.close();
        return results;
    } catch(e){
        if(txn !== undefined){
            txn.close();
        }

        throw e;
    }
}

/**
 * Creates the basis for a previous range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {Function} eval_function
 * @returns {[]}
 */
function iterateLessThan(env, hash_attribute, attribute, search_value, eval_function){
    let txn = undefined;
    try {
        txn = new TransactionCursor(env, attribute);
        let results = Object.create(null);
        let stat = environment_utility.statDBI(env, attribute);
        if(stat.entryCount === 0){
            return results;
        }

        //if the last value in the dbi is greater than the search value then we seek to the value, otherwise we keep the cursor at the last item
        let found = txn.cursor.goToLast();
        let found_converted = common.convertKeyValueFromSearch(found, txn.key_type);

        if (found_converted > search_value) {
            let search_value_converted = common.convertKeyValueToWrite(search_value, txn.key_type);
            found = txn.cursor.goToRange(search_value_converted);
        }

        for (found; found !== null; found = txn.cursor.goToPrev()) {
            let key_value = common.convertKeyValueFromSearch(found, txn.key_type);
            eval_function(search_value, key_value, txn, results, hash_attribute, attribute);
        }

        return results;
    }catch(e) {
        if(txn !== undefined){
            txn.close();
        }
        throw e;
    }
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

    return iterateFullIndex(env, hash_attribute, hash_attribute, cursor_functions.searchAll.bind(null, fetch_attributes, get_whole_row));
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

    return iterateFullIndexToMap(env, hash_attribute, hash_attribute, cursor_functions.searchAllToMap.bind(null, fetch_attributes, get_whole_row));
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
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function equals(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);

    let txn = undefined;
    try {
        txn = new TransactionCursor(env, attribute);

        let converted_search_value = common.convertKeyValueToWrite(search_value, txn.key_type);

        let results = Object.create(null);
        for (let found = txn.cursor.goToKey(converted_search_value); found !== null; found = txn.cursor.goToNextDup()) {
            let key_value = common.convertKeyValueFromSearch(found, txn.key_type);
            if(search_value.toString() !== key_value.toString()){
                txn.cursor.goToLast();
                continue;
            }
            cursor_functions.pushResults(key_value, txn, results, hash_attribute, attribute);
        }
        txn.close();

        if(Buffer.byteLength(search_value.toString()) > lmdb_terms.MAX_BYTE_SIZE) {
            blobSearch(env, hash_attribute, attribute, search_value.toString(), lmdb_terms.SEARCH_TYPES.EQUALS, results);
        }
        return results;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

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
 * @returns {*[]}
 */
function blobSearch(env, hash_attribute, attribute, search_value, search_type, results = []){
    let txn = undefined;
    try{
        txn = new TransactionCursor(env, lmdb_terms.BLOB_DBI_NAME);
        let range_value = `${attribute}/`;
        for(let found = txn.cursor.goToRange(range_value); found !== null; found = txn.cursor.goToNext()){
            if(found.startsWith(range_value) === false){
                txn.cursor.goToLast();
                continue;
            }

            let text = txn.cursor.getCurrentString();
            let hash_value = found.replace(range_value, '');
            switch(search_type){
                case lmdb_terms.SEARCH_TYPES.EQUALS:
                    if(text === search_value){
                        results.push(hash_value);
                    }
                    break;
                case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
                    if(text.startsWith(search_value) === true){
                        results.push(hash_value);
                    }
                    break;
                case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
                    if(text.endsWith(search_value) === true){
                        results.push(hash_value);
                    }
                    break;
                case lmdb_terms.SEARCH_TYPES.CONTAINS:
                    if(text.indexOf(search_value) >= 0){
                        results.push(hash_value);
                    }
                    break;
                default:
                    break;
            }
        }
        txn.cursor.close();
        return results;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

        throw e;
    }
}

/**
 * performs an startsWith search on the key of a named dbi, returns a list of ids where their keys begin with the search_value
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @returns {[]} - ids matching the search
 */
function startsWith(env, hash_attribute, attribute, search_value){
    validateComparisonFunctions(env, attribute, search_value);
    let dbi = environment_utility.openDBI(env, attribute);
    let results = iterateRangeNext(env, hash_attribute, attribute, search_value, cursor_functions.startsWith.bind(null, dbi[lmdb_terms.DBI_DEFINITION_NAME].key_type));
    results = blobSearch(env, hash_attribute, attribute, search_value, lmdb_terms.SEARCH_TYPES.STARTS_WITH, results);
    return results;
}

/**
 * performs an endsWith search on the key of a named dbi, returns a list of ids where their keys end with search_value
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
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
 * performs a cotains search on the key of a named dbi, returns a list of ids where their keys contain the search_value
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
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
    search_info.dbi_numeric_key = dbi[lmdb_terms.DBI_DEFINITION_NAME].key_type === lmdb_terms.DBI_KEY_TYPES.NUMBER;


    //if we are trying to compare a non-numeric value to numeric keys we throw an error
    if(search_info.search_value_is_numeric === false && search_info.dbi_numeric_key === true){
        throw new Error(LMDB_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS);
    }

    return search_info;
}

/**
 * performs a greater than search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function greaterThan(env, hash_attribute, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.greaterThanStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.greaterThanStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        //add 1 to the search value because we want everything greater than the search value & the key is an int
        return iterateRangeNext(env, hash_attribute, attribute, Number(search_value), cursor_functions.greaterThanNumericCompare);
    }
}

/**
 * performs a greater than equal search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function greaterThanEqual(env, hash_attribute, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.greaterThanEqualStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.greaterThanEqualStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        return iterateRangeNext(env, hash_attribute, attribute, Number(search_value), cursor_functions.greaterThaEqualNumericCompare);
    }
}

/**
 * performs a less than search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function lessThan(env, hash_attribute, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.lessThanStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.lessThanStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        return iterateLessThan(env, hash_attribute, attribute, Number(search_value), cursor_functions.lessThanNumericCompare);
    }
}

/**
 * performs a less than equal search for string / numeric search value
 * @param {lmdb.Env} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @returns {*[]}
 */
function lessThanEqual(env, hash_attribute, attribute, search_value){
    let search_info = initializeRangeFunction(env, attribute, search_value);

    if(search_info.search_value_is_numeric === false){
        return iterateFullIndex(env, attribute, cursor_functions.lessThanEqualStringCompare.bind(null, search_value));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === false){
        return iterateFullIndex(env, attribute, cursor_functions.lessThanEqualStringToNumberCompare.bind(null, Number(search_value)));
    }

    if(search_info.search_value_is_numeric === true && search_info.dbi_numeric_key === true){
        //need to add 1 to the value other wise when prev is called it skips all but the first entry of the search_value
        return iterateLessThan(env, attribute, Number(search_value), cursor_functions.lessThanEqualNumericCompare);
    }
}

/**
 * performs a between search for string / numeric search value
 * @param {lmdb.Env} env
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

    let dbi = environment_utility.openDBI(env, attribute);
    let key_type = dbi[lmdb_terms.DBI_DEFINITION_NAME].key_type;

    if(key_type === lmdb_terms.DBI_KEY_TYPES.NUMBER){
        [start_value, end_value] = [Number(start_value), Number(end_value)];
    }

    if (start_value >= end_value) {
        throw new Error(LMDB_ERRORS.END_VALUE_MUST_BE_GREATER_THAN_START_VALUE);
    }

    let dbi_int_key = (key_type === lmdb_terms.DBI_KEY_TYPES.NUMBER);

    //if we are trying to compare a non-numeric value to numeric keys we throw an error
    if((isNaN(start_value) === true || isNaN(end_value) === true) && dbi_int_key === true){
        throw new Error(LMDB_ERRORS.CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS);
    }

    if(dbi_int_key === false && (isNaN(start_value) === true || isNaN(end_value) === true)){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.betweenStringCompare.bind(null, start_value.toString(), end_value.toString()));
    }

    if(dbi_int_key === false && isNaN(start_value) === false && isNaN(end_value) === false){
        return iterateFullIndex(env, hash_attribute, attribute, cursor_functions.betweenStringToNumberCompare.bind(null, Number(start_value), Number(end_value)));
    }

    return iterateRangeBetween(env, hash_attribute, attribute, Number(start_value), Number(end_value));
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

    let txn = undefined;
    try {
        txn = new TransactionCursor(env, hash_attribute);

        let obj = null;
        let found = txn.cursor.goToKey(id);
        if (found === id) {
            obj = cursor_functions.parseRow(txn, get_whole_row, fetch_attributes);
        }
        txn.close();
        return obj;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

        throw e;
    }
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

    let txn = undefined;
    try {
        let found_key = true;
        txn = new TransactionCursor(env, hash_attribute);

        id = common.convertKeyValueToWrite(id, txn.key_type);

        let key = txn.cursor.goToKey(id);

        if (key !== id) {
            found_key = false;
        }

        txn.close();
        return found_key;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

        throw e;
    }
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
function batchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found = []) {
    let txn = initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

    let get_whole_row = setGetWholeRowFlag(fetch_attributes);

    let results = {};

    for(let x = 0; x < ids.length; x++){
        let id = ids[x];
        try {
            let key = txn.cursor.goToKey(id);
            if(key === id) {
                cursor_functions.searchAll(fetch_attributes, get_whole_row, key, txn, results);
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
function batchSearchByHashToMap(env, hash_attribute, fetch_attributes, ids, not_found = []) {
    let txn = initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

    let results = Object.create(null);

    let get_whole_row = setGetWholeRowFlag(fetch_attributes);

    for(let x = 0; x < ids.length; x++){
        let id = ids[x];
        try {
            let key = txn.cursor.goToKey(id);
            if(key === id) {
                let obj = cursor_functions.parseRow(txn, get_whole_row, fetch_attributes);
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

    return new TransactionCursor(env, hash_attribute);
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