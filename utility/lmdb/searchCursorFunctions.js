'use strict';

const common = require('./commonUtility');

function parseRow(txn, get_whole_row, attributes){
    let return_object = Object.create(null);
    let original_object = JSON.parse(txn.cursor.getCurrentString());

    if(get_whole_row === true){
        return_object = Object.assign(return_object, original_object);
    } else {
        for (let x = 0; x < attributes.length; x++) {
            let attribute = attributes[x];
            return_object[attribute] = original_object[attribute];
        }
    }

    return return_object;
}

/**
 * The internal iterator function for searchAll
 * @param {[String]} attributes
 * @param {Boolean} get_whole_row
 * @param {String|Number} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 */
function searchAll(attributes, get_whole_row, found, txn, results){
    let obj = parseRow(txn, get_whole_row, attributes);

    results.push(obj);
}

/**
* The internal iterator function for searchAllToMap
 * @param {[String]} attributes
* @param {Boolean} get_whole_row
* @param {String|Number} found
* @param {lmdb.Cursor} txn
* @param {Object} results
*/
function searchAllToMap(attributes, get_whole_row, found, txn, results){
    let obj = parseRow(txn, get_whole_row, attributes);

    results[found] = obj;
}

/**
 * The internal iterator function for iterateDBI
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 */
function iterateDBI(found, txn, results){
    results.push([found, txn.cursor.getCurrentString()]);
}

/**
 * The internal iterator function for startsWith, if we are executing a startswith on an int keyed dbi we do not want end the cursor if the value does not start with the compare_value,
 *  this is because the next value would be the next numeric value instead of the next lexographic value
 * @param {Boolean} int_key
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 */
function startsWith(int_key, compare_value, found, txn, results){
    let found_str = found.toString();
    if(found_str.startsWith(compare_value)){
        results.push(txn.cursor.getCurrentString());
    } else if(int_key === false){
        txn.cursor.goToLast();
    }
}

/**
 * The internal iterator function for endsWith
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 */
function endsWith(compare_value, found, txn, results){
    let found_str = found.toString();
    if(found_str.endsWith(compare_value)){
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for contains
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 */
function contains(compare_value, found, txn, results){
    let found_str = found.toString();
    if(found_str.includes(compare_value)){
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a string compare_value
 * @param {String} compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results

 */
function greaterThanStringCompare(compare_value, found, txn, results) {
    if (found > compare_value) {
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function greaterThanStringToNumberCompare(compare_value, found, txn, results) {
    let found_number = Number(found);
    if(found_number > compare_value){
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than, used for numeric keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function greaterThanNumericCompare(compare_value, found, txn, results) {
    if(found < compare_value){
        txn.cursor.goToLast();
    } else if(found > compare_value) {
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a sring compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {String} compare_value
 */
function greaterThanEqualStringCompare(compare_value, found, txn, results) {
    if (found >= compare_value) {
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function greaterThanEqualStringToNumberCompare(compare_value, found, txn, results) {
    let found_number = Number(found);
    if(found_number >= compare_value){
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than, used for numeric keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function greaterThaEqualNumericCompare(compare_value, found, txn, results) {
    if(found < compare_value){
        txn.cursor.goToLast();
    } else {
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for adding the value with no comparison check
 * @param {Number} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function addResult(compare_value, found, txn, results) {
    results.push(txn.cursor.getCurrentString());
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a string compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {String} compare_value
 */
function lessThanStringCompare(compare_value, found, txn, results) {
    if (found < compare_value) {
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanStringToNumberCompare(compare_value, found, txn, results) {
    let found_number = Number(found);
    if(found_number < compare_value){
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than, used for number keyed dbis
 * @param {Number} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanNumericCompare(compare_value, found, txn, results) {
    if(found < compare_value){
        results.push(txn.cursor.getCurrentString());
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
 */
function lessThanEqualStringCompare(compare_value, found, txn, results) {
    if (found <= compare_value) {
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than equal, used for string keyed dbis and a number compare_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanEqualStringToNumberCompare(compare_value, found, txn, results) {
    let found_number = Number(found);
    if(found_number <= compare_value){
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than equal, used for int keyed dbis
 * @param {Number} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanEqualNumericCompare(compare_value, found, txn, results) {
    if(found <= compare_value){
        results.push(txn.cursor.getCurrentString());
    } else if(compare_value < 0){
        txn.cursor.goToFirst();
    } else {
        let search_value_converted = common.convertKeyValueToWrite(compare_value, txn.key_type);
        let key = txn.cursor.goToRange(search_value_converted);
        let key_converted = common.convertKeyValueFromSearch(key, txn.key_type);
        if(key_converted === compare_value) {
            txn.cursor.goToLastDup();
            results.push(txn.cursor.getCurrentString());
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

 */
function betweenStringCompare(start_value, end_value, found, txn, results) {
    if (found >= start_value && found <= end_value) {
        results.push(txn.cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for between, used for string keyed dbis and number start/end values
 * @param {Number} start_value
 * @param {Number} end_value
 * @param {String} found
 * @param {lmdb.Cursor} txn
 * @param {[]} results
 */
function betweenStringToNumberCompare(start_value,end_value, found, txn, results) {
    let found_number = Number(found);
    if (found_number >= start_value && found_number <= end_value) {
        results.push(txn.cursor.getCurrentString());
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
    betweenStringToNumberCompare
};