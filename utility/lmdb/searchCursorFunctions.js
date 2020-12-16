'use strict';

const common = require('./commonUtility');
const auto_cast = require('../common_utils').autoCast;
const lmdb_terms = require('./terms');

function parseRow(txn, attributes){
    let return_object = Object.create(null);
    let original_object = JSON.parse(txn.cursor.getCurrentUtf8());

    for (let x = 0; x < attributes.length; x++) {
        let attribute = attributes[x];
        let attribute_value = auto_cast(original_object[attribute]);
        return_object[attribute] = attribute_value === undefined ? null : attribute_value;
    }

    return return_object;
}

/**
 * The internal iterator function for searchAll
 * @param {[String]} attributes
 * @param {String|Number} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 */
function searchAll(attributes, found, txn, results){
    let obj = parseRow(txn, attributes);

    results[found] = obj;
}

/**
* The internal iterator function for searchAllToMap
 * @param {[String]} attributes
* @param {String|Number} found
* @param {lmdb.Cursor} txn
* @param {Object} results
*/
function searchAllToMap(attributes, found, txn, results){
    let obj = parseRow(txn, attributes);

    results[found] = obj;
}

/**
 * The internal iterator function for iterateDBI
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 */
function iterateDBI(found, txn, results){
    if(results[found] === undefined){
        results[found] = [];
    }
    results[found].push(txn.cursor.getCurrentUtf8());
}

/**
 * internal function used to add hash value to results, in the scenario of a hash_attribute dbi we just need to add the found key, otherwise we get the value
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function pushResults(found, txn, results, hash_attribute, attribute){
    let new_object = Object.create(null);
    new_object[attribute] = auto_cast(found);
    let hash_value = undefined;

    if(txn.is_hash_attribute === true){
        hash_value = found;
    } else {
        hash_value = txn.cursor.getCurrentUtf8();
        if(hash_attribute !== undefined) {
            new_object[hash_attribute] = auto_cast(hash_value);
        }
    }

    results[hash_value] = new_object;
}

/**
 * The internal iterator function for startsWith, if we are executing a startswith on an int keyed dbi we do not want end the cursor if the value does not start with the compare_value,
 *  this is because the next value would be the next numeric value instead of the next lexographic value
 * @param {lmdb_terms.DBI_KEY_TYPES} key_type
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function startsWith(key_type, compare_value, found, txn, results, hash_attribute, attribute){
    let found_str = found.toString();
    if(found_str.startsWith(compare_value)){
        pushResults(found, txn, results, hash_attribute, attribute);
    } else if(key_type === lmdb_terms.DBI_KEY_TYPES.STRING){
        txn.cursor.goToLast();
    }
}

/**
 * The internal iterator function for endsWith
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function endsWith(compare_value, found, txn, results, hash_attribute, attribute){
    let found_str = found.toString();
    if(found_str.endsWith(compare_value)){
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for contains
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function contains(compare_value, found, txn, results, hash_attribute, attribute){
    let found_str = found.toString();
    if(found_str.includes(compare_value)){
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a string compare_value
 * @param {String} compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanStringCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if (found > compare_value) {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanStringToNumberCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    let found_number = Number(found);
    if(found_number > compare_value){
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for greater than, used for numeric keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanNumericCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if(found < compare_value){
        txn.cursor.goToLast();
    } else if(found > compare_value) {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a sring compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {String} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanEqualStringCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if (found >= compare_value) {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanEqualStringToNumberCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    let found_number = Number(found);
    if(found_number >= compare_value){
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for greater than, used for numeric keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThaEqualNumericCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if(found < compare_value){
        txn.cursor.goToLast();
    } else {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for adding the value with no comparison check
 * @param {Number} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function addResult(compare_value, found, txn, results, hash_attribute, attribute) {
    pushResults(found, txn, results, hash_attribute, attribute);
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a string compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {String} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanStringCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if (found < compare_value) {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanStringToNumberCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    let found_number = Number(found);
    if(found_number < compare_value){
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for less than, used for number keyed dbis
 * @param {Number} found
 * @param {lmdb.Cursor} txn
 * @param {Object} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanNumericCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if(found < compare_value){
        pushResults(found, txn, results, hash_attribute, attribute);
    } else if(compare_value < 0){
        txn.cursor.goToFirst();
    } else {
        let search_value_converted = common.convertKeyValueToWrite(compare_value, txn.key_type);
        txn.cursor.goToRange(search_value_converted);
    }
}

/**
 * The internal iterator function for less than equal, used for string keyed dbis and a string compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {String} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanEqualStringCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if (found <= compare_value) {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for less than equal, used for string keyed dbis and a number compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanEqualStringToNumberCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    let found_number = Number(found);
    if(found_number <= compare_value){
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for less than equal, used for int keyed dbis
 * @param {Number} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanEqualNumericCompare(compare_value, found, txn, results, hash_attribute, attribute) {
    if(found <= compare_value){
        pushResults(found, txn, results, hash_attribute, attribute);
    } else if(compare_value < 0){
        txn.cursor.goToFirst();
    } else {
        let search_value_converted = common.convertKeyValueToWrite(compare_value, txn.key_type);
        let key = txn.cursor.goToRange(search_value_converted);
        let key_converted = common.convertKeyValueFromSearch(key, txn.key_type);
        if(key_converted === compare_value) {
            key = txn.cursor.goToLastDup();
            key_converted = common.convertKeyValueFromSearch(key, txn.key_type);
            pushResults(key_converted, txn, results, hash_attribute, attribute);
        }

    }
}

/**
 * The internal iterator function for between, used for string keyed dbis and string start/end values
 * @param {String} start_value
 * @param {String} end_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function betweenStringCompare(start_value, end_value, found, txn, results, hash_attribute, attribute) {
    if (found >= start_value && found <= end_value) {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

/**
 * The internal iterator function for between, used for string keyed dbis and number start/end values
 * @param {Number} start_value
 * @param {Number} end_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function betweenStringToNumberCompare(start_value,end_value, found, txn, results, hash_attribute, attribute) {
    let found_number = Number(found);
    if (found_number >= start_value && found_number <= end_value) {
        pushResults(found, txn, results, hash_attribute, attribute);
    }
}

module.exports = {
    parseRow,
    searchAll,
    searchAllToMap,
    iterateDBI,
    startsWith,
    endsWith,
    contains,
    greaterThanStringCompare,
    greaterThanStringToNumberCompare,
    greaterThanNumericCompare,
    greaterThanEqualStringCompare,
    greaterThanEqualStringToNumberCompare,
    greaterThaEqualNumericCompare,
    addResult,
    lessThanStringCompare,
    lessThanStringToNumberCompare,
    lessThanNumericCompare,
    lessThanEqualStringCompare,
    lessThanEqualStringToNumberCompare,
    lessThanEqualNumericCompare,
    betweenStringCompare,
    betweenStringToNumberCompare,
    pushResults
};