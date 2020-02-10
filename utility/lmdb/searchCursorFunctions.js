'use strict';

function parseRow(cursor, get_whole_row, attributes){
    let return_object = Object.create(null);
    let original_object = JSON.parse(cursor.getCurrentString());

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
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function searchAll(attributes, get_whole_row, found, cursor, results){
    let obj = parseRow(cursor, get_whole_row, attributes);

    results.push(obj);
}

/**
* The internal iterator function for searchAllToMap
 * @param {[String]} attributes
* @param {Boolean} get_whole_row
* @param {String|Number} found
* @param {lmdb.Cursor} cursor
* @param {Object} results
*/
function searchAllToMap(attributes, get_whole_row, found, cursor, results){
    let obj = parseRow(cursor, get_whole_row, attributes);

    results[found] = obj;
}

/**
 * The internal iterator function for iterateDBI
 * @param {*} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function iterateDBI(found, cursor, results){
    results.push([found, cursor.getCurrentString()]);
}

/**
 * The internal iterator function for startsWith, if we are executing a startswith on an int keyed dbi we do not want end the cursor if the value does not start with the compare_value,
 *  this is because the next value would be the next numeric value instead of the next lexographic value
 * @param {Boolean} int_key
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function startsWith(int_key, compare_value, found, cursor, results){
    let found_str = found.toString();
    if(found_str.startsWith(compare_value)){
        results.push(cursor.getCurrentString());
    } else if(int_key === false){
        cursor.goToLast();
    }
}

/**
 * The internal iterator function for endsWith
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function endsWith(compare_value, found, cursor, results){
    let found_str = found.toString();
    if(found_str.endsWith(compare_value)){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for contains
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function contains(compare_value, found, cursor, results){
    let found_str = found.toString();
    if(found_str.includes(compare_value)){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a string compare_value
 * @param {String} compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results

 */
function greaterThanStringCompare(compare_value, found, cursor, results) {
    if (found > compare_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function greaterThanStringToNumberCompare(compare_value, found, cursor, results) {
    let found_number = Number(found);
    if(found_number > compare_value){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a sring compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {String} compare_value
 */
function greaterThanEqualStringCompare(compare_value, found, cursor, results) {
    if (found >= compare_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function greaterThanEqualStringToNumberCompare(compare_value, found, cursor, results) {
    let found_number = Number(found);
    if(found_number >= compare_value){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for adding the value with no comparison check
 * @param {Number} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function addResult(compare_value, found, cursor, results) {
    results.push(cursor.getCurrentString());
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a string compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {String} compare_value
 */
function lessThanStringCompare(compare_value, found, cursor, results) {
    if (found < compare_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a numeric compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanStringToNumberCompare(compare_value, found, cursor, results) {
    let found_number = Number(found);
    if(found_number < compare_value){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than, used for int keyed dbis
 * @param {Number} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanNumericCompare(compare_value, found, cursor, results) {
    if(found < compare_value){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than equal, used for string keyed dbis and a string compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {String} compare_value
 */
function lessThanEqualStringCompare(compare_value, found, cursor, results) {
    if (found <= compare_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than equal, used for string keyed dbis and a number compare_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanEqualStringToNumberCompare(compare_value, found, cursor, results) {
    let found_number = Number(found);
    if(found_number <= compare_value){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for less than equal, used for int keyed dbis
 * @param {Number} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function lessThanEqualNumericCompare(compare_value, found, cursor, results) {
    if(found <= (compare_value - 1)){
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for between, used for string keyed dbis and string start/end values
 * @param {String} start_value
 * @param {String} end_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results

 */
function betweenStringCompare(start_value, end_value, found, cursor, results) {
    if (found >= start_value && found <= end_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for between, used for string keyed dbis and number start/end values
 * @param {Number} start_value
 * @param {Number} end_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function betweenStringToNumberCompare(start_value,end_value, found, cursor, results) {
    let found_number = Number(found);
    if (found_number >= start_value && found_number <= end_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 * The internal iterator function for between, used for int keyed dbis
 * @param {Number} end_value
 * @param {Number} start_value
 * @param {Number} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function betweenNumericCompare(end_value, start_value, found, cursor, results) {
    //if the found value is greater than the end_value we tell the cursor to go to the end of the dbi which closes the iterator
    if(found > end_value){
        cursor.goToLast();
    } else{
        //since we are starting at the start_value we don't need to do a compare since the dbi begins where we want
        results.push(cursor.getCurrentString());
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
    greaterThanEqualStringCompare,
    greaterThanEqualStringToNumberCompare,
    addResult,
    lessThanStringCompare,
    lessThanStringToNumberCompare,
    lessThanNumericCompare,
    lessThanEqualStringCompare,
    lessThanEqualStringToNumberCompare,
    lessThanEqualNumericCompare,
    betweenStringCompare,
    betweenStringToNumberCompare,
    betweenNumericCompare
};