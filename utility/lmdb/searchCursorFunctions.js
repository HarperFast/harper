'use strict';

/**
 * @param {[]} attributes
 * @param {*} found
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
 * @param {*} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function iterateDBI(found, cursor, results){
    results.push([found, cursor.getCurrentString()]);
}

/**
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
 *
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {String} compare_value
 */
function greaterThanStringCompare(compare_value, found, cursor, results) {
    if (found > compare_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 *
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
 *
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
 *
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
 *
 * @param {Number} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 * @param {Number} compare_value
 */
function addResult(compare_value, found, cursor, results) {
    results.push(cursor.getCurrentString());
}

/**
 *
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
 *
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
 *
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
 *
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
 *
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
 *
 * @param {Number} start_value
 * @param {Number} end_value
 * @param {String} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function betweenStringToNumberCompare(start_value, end_value, found, cursor, results) {
    let found_number = Number(found);
    if (found_number >= start_value && found_number <= end_value) {
        results.push(cursor.getCurrentString());
    }
}

/**
 *
 * @param {Number} end_value
 * @param {Number} found
 * @param {lmdb.Cursor} cursor
 * @param {[]} results
 */
function betweenNumericCompare(end_value, found, cursor, results) {
    //if the found value is greater than the end_value we tell the cursor to go to the end of the dbi which closes the iterator
    if(found > end_value){
        cursor.gotToLast();
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
    lessThanEqualStringCompare,
    lessThanEqualStringToNumberCompare,
    betweenStringCompare,
    betweenStringToNumberCompare,
    betweenNumericCompare
};