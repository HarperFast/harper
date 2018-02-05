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

function listHasEmptyOrZeroLengthValues(values_list) {
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