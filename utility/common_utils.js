"use strict"
const path = require('path');

module.exports = {
    isEmpty:isEmpty,
    isEmptyOrZeroLength:isEmptyOrZeroLength,
    arrayHasEmptyValues:arrayHasEmptyValues,
    arrayHasEmptyOrZeroLengthValues:arrayHasEmptyOrZeroLengthValues,
    buildFolderPath: buildFolderPath,
    isBoolean: isBoolean
};

/**
 * Test if the passed value is null or undefined.  This will not check string length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmpty(value) {
    return (value === undefined || value === null);
}

/**
 * Test if the passed value is null, undefined, or zero length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmptyOrZeroLength(value) {
    return (isEmpty(value) || value.length === 0);
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param values_list - An array of values
 * @returns {boolean}
 */
function arrayHasEmptyValues(values_list) {
    if(isEmpty(values_list)) {
        return true;
    }
    for(let val=0; val<values_list.length; val++) {
        if(isEmpty(values_list[val])) {
            return true;
        }
    }
    return false;
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param values_list - An array of values
 * @returns {boolean}
 */
function arrayHasEmptyOrZeroLengthValues(values_list) {
    if(isEmptyOrZeroLength(values_list)) {
        return true;
    }
    for(let val=0; val<values_list.length; val++) {
        if(isEmptyOrZeroLength(values_list[val])) {
            return true;
        }
    }
    return false;
}

/**
 * takes an array of strings and joins them with the folder separator to return a path
 * @param path_elements
 */
function buildFolderPath(...path_elements){
    try {
        return path_elements.join(path.sep);
    } catch(e){
        console.error(path_elements);
    }
}

/**
 * takes a value and checks if it is a boolean value (true/false)
 * @param value
 * @returns {boolean}
 */
function isBoolean(value){
    if(isEmpty(value)){
        return false;
    }

    if(value === true || value === false){
        return true;
    }

    return false;
}