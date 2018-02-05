"use strict"

module.exports = {
    isEmpty:isEmpty,
    isEmptyOrZeroLength:isEmptyOrZeroLength,
    listHasEmptyValues:listHasEmptyValues,
    listHasEmptyOrZeroLengthValues:listHasEmptyOrZeroLengthValues
}

function isEmpty(value) {
    return (value === undefined || value === null);
}

function isEmptyOrZeroLength(value) {
    return (isEmpty(value) || value.length === 0);
}

function listHasEmptyValues(values_list) {
    for(let val=0; val<values_lsit.length; val++) {
        if(isEmpty(val)) {
            return true;
        }
    }
    return false;
}

function listHasEmptyOrZeroLengthValues(values_list) {
    for(let val=0; val<values_lsit.length; val++) {
        if(isEmptyOrZeroLength(val)) {
            return true;
        }
    }
    return false;
}