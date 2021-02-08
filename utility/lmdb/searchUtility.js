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
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[]}
 */
function iterateFullIndex(env, hash_attribute, attribute, eval_function, reverse = false, limit = undefined, offset = undefined){
    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    let dbi = environment_utility.openDBI(env, attribute);
    if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
        hash_attribute = attribute;
    }

    try {
        for(let {key, value} of dbi.getRange({limit: limit, offset: offset, reverse: reverse})){
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
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[]}
 */
function iterateRangeNext(env, hash_attribute, attribute, search_value, eval_function, reverse = false, limit = undefined, offset = undefined){
    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    try {
        let dbi = env.dbis[attribute];
        if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
            hash_attribute = attribute;
        }

        //because reversing only returns 1 entry from a dup sorted key we get all entries for the search value
        let start_value = reverse === true ? undefined : search_value;
        let end_value = reverse === true ? search_value : undefined;

        for(let {key, value} of dbi.getRange({start:start_value, end: end_value, reverse, limit, offset})){
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
 * @param {boolean} reverse
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[]}
 */
function iterateRangeBetween(env, hash_attribute, attribute, start_value, end_value, reverse = false, limit = undefined, offset = undefined){

    try {
        let results = Object.create(null);
        let stat = environment_utility.statDBI(env, attribute);
        if (stat.entryCount === 0) {
            return results;
        }

        let dbi = environment_utility.openDBI(env, attribute);
        if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
            hash_attribute = attribute;
        }

        start_value = auto_cast(start_value);
        start_value = common.convertKeyValueToWrite(start_value);

        end_value = auto_cast(end_value);
        end_value = common.convertKeyValueToWrite(end_value);

        //get last key
        let last;
        for(let key of dbi.getKeys({reverse: true, limit: 1})){
            last = key;
        }
        if(end_value >= last){
            end_value = undefined;
        }

        //get first key
        let first;
        for(let key of dbi.getKeys({limit: 1})){
            first = key;
        }
        if(start_value <= first){
            start_value = undefined;
        }


        //advance the end_value by 1 key
        let end;
        let start_search = reverse === true ? start_value : end_value;
        if(start_search !== undefined && start_search !== null){
            for(let key of dbi.getKeys({start:start_search, reverse})){
                if(key !== start_search){
                    end = key;
                    break;
                }
            }
        }

        let start = reverse === true ? end_value : start_value;

        for(let {key, value} of env.dbis[attribute].getRange({start, end, reverse, limit, offset})){
            cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
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
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 */
function searchAll(env, hash_attribute, fetch_attributes, reverse = false, limit = undefined, offset = undefined){
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    validateFetchAttributes(fetch_attributes);

    let results = iterateFullIndex(env, hash_attribute, hash_attribute, cursor_functions.searchAll.bind(null, fetch_attributes), reverse, limit, offset);
    return Object.values(results);
}

/**
* iterates the entire  hash_attribute dbi and returns all objects back in a map
* @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
* @param {String} hash_attribute - name of the hash_attribute for this environment
* @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
* @returns {{String|Number, Object}} - object array of fetched records

*/
function searchAllToMap(env, hash_attribute, fetch_attributes, reverse = false, limit = undefined, offset = undefined){
    common.validateEnv(env);

    if(hash_attribute === undefined){
        throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
    }

    validateFetchAttributes(fetch_attributes);
    return iterateFullIndex(env, hash_attribute, hash_attribute, cursor_functions.searchAll.bind(null, fetch_attributes), reverse, limit, offset);
}

/**
 * iterates a dbi and returns the key/value pairing for each entry
 * @param env
 * @param attribute
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {Array.<Array>}
 */
function iterateDBI(env, attribute, reverse = false, limit = undefined, offset = undefined){
    common.validateEnv(env);
    if(attribute === undefined){
        throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
    }

    return iterateFullIndex(env, attribute, attribute, cursor_functions.iterateDBI, reverse, limit, offset);
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
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[]} - ids matching the search
 */
function equals(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);

    let dbi = environment_utility.openDBI(env, attribute);

    if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
        hash_attribute = attribute;
    }

    try {
        search_value = auto_cast(search_value);
        search_value = common.convertKeyValueToWrite(search_value);

        let results = Object.create(null);
        for (let value of dbi.getValues(search_value, {reverse, limit, offset})) {
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
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[]} - ids matching the search
 */
function startsWith(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);

    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    let dbi = environment_utility.openDBI(env, attribute);

    if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
        hash_attribute = attribute;
    }

    //if the search is numeric we need to scan the entire index, if string we can just do a range
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);
    let string_search = true;
    if(typeof search_value === 'number'){
        string_search = false;
    }

    //if we are reversing we need to get the key after the one we want to search on so we can start there and iterate to the front
    if(reverse === true){
        let next_key;
        //iterate based on the search_value until the key no longer starts with the search_value, this is the key we need to start with in the search
        for(let key of dbi.getKeys({start: search_value})){
            if(!key.startsWith(search_value)){
                next_key = key;
                break;
            }
        }

        //with the new search value we iterate
        if(next_key !== undefined){
            if(Number.isInteger(offset)){
                offset++;
            } else{
                limit++;
            }

            //limit++;
        }


        for(let {key, value} of dbi.getRange({start: next_key, end: undefined, reverse, limit, offset})){
            if(key === next_key){
                continue;
            }

            if(key.toString().startsWith(search_value)){
                cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
            } else if(string_search === true){
                break;
            }
        }
    }else {
        for (let {key, value} of dbi.getRange({start: search_value, reverse, limit, offset})) {
            if (key.toString().startsWith(search_value)) {
                cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
            } else if (string_search === true) {
                break;
            }
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
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {{}} - ids matching the search
 */
function endsWith(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);
    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    let dbi = environment_utility.openDBI(env, attribute);
    if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
        hash_attribute = attribute;
    }

    try {
        //we iterate just the keys as it is faster (no access of the value & less iterations in dupsorted dbis)
        for(let key of dbi.getKeys()){
            let key_str = common.convertKeyValueFromSearch(key).toString();
            if(key_str.endsWith(search_value)){
                //if there is a match we iterate the values of the key
                for(let value of dbi.getValues(key)){
                    cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
                }
            }
        }
        results = blobSearch(env, hash_attribute, attribute, search_value, lmdb_terms.SEARCH_TYPES.ENDS_WITH, results);
        return traverseResults(results, reverse, limit, offset);
    }catch(e){
        throw e;
    }
}

/**
 * performs a contains search on the key of a named dbi, returns a list of ids where their keys contain the search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param {String|Number} search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {{}} - ids matching the search
 */
function contains(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);

    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    let dbi = environment_utility.openDBI(env, attribute);
    if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
        hash_attribute = attribute;
    }

    try {
        for(let key of dbi.getKeys()){
            let found_str = key.toString();
            if(found_str.includes(search_value)){
                for(let value of dbi.getValues(key)){
                    cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
                }
            }
        }
        results = blobSearch(env, hash_attribute, attribute, search_value, lmdb_terms.SEARCH_TYPES.CONTAINS, results);

        return traverseResults(results, reverse, limit, offset);

    }catch(e){
        throw e;
    }

}

/**
 * iterates a results set to limit the results further via offset, limit & reverse
 * @param {{}}results
 * @param {boolean} reverse
 * @param {Number} limit
 * @param {Number} offset
 * @returns {{}}
 */
function traverseResults(results, reverse, limit = undefined, offset = 0){
    if(limit !== undefined || offset > 0){
        let tmp_results = Object.create(null);
        let keys = Object.keys(results);

        limit = (limit === undefined) ? keys.length : limit;

        if(reverse === true){
            for(let x = (keys.length - offset) - 1; x >= 0; x--){
                if(limit === 0){
                    break;
                }
                let id = keys[x];
                tmp_results[id] = results[id];
                limit--;
            }
        }else {
            for(let x = offset, length = keys.length; x < length; x++){
                if(limit === 0){
                    break;
                }
                let id = keys[x];
                tmp_results[id] = results[id];
                limit--;
            }
        }

        return tmp_results;
    }

    return results;
}

/** RANGE FUNCTIONS **/

/**
 * performs a greater than search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {*[]}
 */
function greaterThan(env, hash_attribute, attribute, search_value, reverse= false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);

    //if reverse = false we need to find the next value to start searching
    let next_value;
    if(reverse === true){
        next_value = search_value;
    } else{
        let dbi = environment_utility.openDBI(env, attribute);
        for (let key of dbi.getKeys({start: search_value})) {
            if (key > search_value) {
                next_value = key;
                break;
            }
        }
    }

    return iterateRangeNext(env, hash_attribute, attribute, next_value, cursor_functions.greaterThanEqualCompare, reverse, limit, offset);
}

/**
 * performs a greater than equal search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {*[]}
 */
function greaterThanEqual(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);

    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0){
        return results;
    }

    //if reverse = true we need to find the prev value to the search
    let next_value;
    if(reverse === false){
        next_value = search_value;
    } else{
        let dbi = environment_utility.openDBI(env, attribute);

        //get the first key
        let first;
        for(let key of dbi.getKeys({limit:1})){
            first = key;
        }

        //if search equal or is less than the first key we set next value to be undefined, this will have the iterator go to the very first element
        if(first >= search_value){
            next_value = undefined;
        } else {
            for (let key of dbi.getKeys({start: search_value, reverse})) {
                if (key < search_value) {
                    next_value = key;
                    break;
                }
            }
        }
    }

    try {
        let dbi = env.dbis[attribute];
        if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
            hash_attribute = attribute;
        }

        //because reversing only returns 1 entry from a dup sorted key we get all entries for the search value
        let start_value = reverse === true ? undefined : next_value;
        let end_value = reverse === true ? next_value : undefined;

        for(let {key, value} of dbi.getRange({start:start_value, end: end_value, reverse, limit, offset})){
            cursor_functions.greaterThanEqualCompare(search_value, key, value, results, hash_attribute, attribute);
        }

        return results;
    }catch(e){
        throw e;
    }


    //return iterateRangeNext(env, hash_attribute, attribute, next_value, cursor_functions.greaterThanEqualCompare, reverse, limit, offset);
}

/**
 * performs a less than search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {*[]}
 */
function lessThan(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);

    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0 || search_value === undefined || search_value === null){
        return results;
    }

    try {
        let dbi = env.dbis[attribute];

        if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
            hash_attribute = attribute;
        }

        let start;
        let end;
        if(reverse === true){
            //check if the search value exists, if it does we increment the limit & offset by 1 as we need to allow for skipping that entry
            let value = dbi.get(search_value);
            if (value !== undefined) {
                if (Number.isInteger(offset)) {
                    offset++;
                } else {
                    limit = limit === undefined ? undefined : ++limit;
                }
            }

             end = undefined;
             start = search_value;
        }else {

            start = undefined;
            end = search_value;
        }

        for(let {key, value} of dbi.getRange({start, end, reverse, limit, offset})){
            cursor_functions.lessThanCompare(search_value, key, value, results, hash_attribute, attribute);
        }

        return results;
    }catch(e){
        throw e;
    }
}

/**
 * performs a less than equal search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - defines the direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {*[]}
 */
function lessThanEqual(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined){
    validateComparisonFunctions(env, attribute, search_value);
    search_value = auto_cast(search_value);
    search_value = common.convertKeyValueToWrite(search_value);

    let results = Object.create(null);
    let stat = environment_utility.statDBI(env, attribute);
    if(stat.entryCount === 0 || search_value === undefined || search_value === null){
        return results;
    }

    try {
        let dbi = env.dbis[attribute];

        if(dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute){
            hash_attribute = attribute;
        }

        let next_value;
        for(let key of dbi.getKeys({start:search_value})){
            if(key > search_value){
                next_value = key;
                break;
            }
        }

        let start;
        let end;
        if(reverse === true){
            //check if the search value exists, if it does we increment the limit & offset by 1 as we need to allow for skipping that entry
            /*let value = dbi.get(search_value);
            if (value !== undefined) {*/
                if (Number.isInteger(offset)) {
                    offset++;
                } else {
                    limit = limit === undefined ? undefined : ++limit;
                }
            //}

            end = undefined;
            start = next_value;
        }else {

            start = undefined;
            end = next_value;
        }

        for(let {key, value} of dbi.getRange({start, end, reverse, limit, offset})){
            cursor_functions.lessThanEqualCompare(search_value, key, value, results, hash_attribute, attribute);
        }

        return results;
    }catch(e){
        throw e;
    }
}

/**
 * performs a between search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} start_value
 * @param {String|Number}end_value
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {*[]}
 */
function between(env, hash_attribute, attribute, start_value, end_value, reverse = false, limit = undefined, offset = undefined){
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

    return iterateRangeBetween(env, hash_attribute, attribute, start_value, end_value, reverse, limit, offset);
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
