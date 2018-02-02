"use strict"

module.export = {
    isEmpty:isEmpty,
    isEmptyOrZeroLength:isEmptyOrZeroLength
}

function isEmpty(value) {
    return (value === undefined || value === null);
}

function isEmptyOrZeroLength(value) {
    return (isEmpty(value) || value.length === 0);
}