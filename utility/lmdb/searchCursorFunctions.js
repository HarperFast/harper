'use strict';

/**
 * The internal iterator function for searchAll
 * @param {[String]} attributes
 * @param {String|Number} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function searchAll(attributes, found, cursor, results){
    let obj = Object.create(null);
    let value = JSON.parse(cursor.getCurrentString());

    for(let x = 0; x < attributes.length; x++){
        let attribute = attributes[x];
        obj[attribute] = value[attribute];
    }

    results.push(obj);
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
 * The internal iterator function for startsWith
 * @param {String} compare_value
 * @param {*} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function startsWith(compare_value, found, cursor, results){
    if(found.startsWith(compare_value)){
        results.push(cursor.getCurrentString());
    } else{
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
    if(found.endsWith(compare_value)){
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
    if(found.includes(compare_value)){
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
    searchAll,
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