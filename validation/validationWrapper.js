/**
 * validationWrapper.js
 *
 * This module is meant as a wrapper for calls to the validate module.  This wrapper serves 2 purposes:
 * it decouples the validate() call from the validate module, and it ensures a consistent "Error" return object
 * so we can rely on it for logging and reporting.
 *
 * There are a few cases where the validate module is called directly for functions like isBoolean.
 * These are rare enough for it not to be worth creating wrapper functions for those as well.
 */

const validate = require('validate.js');

module.exports = {
    validateObject,
    validateObjectAsync
};

function validateObject(object, file_constraints) {
    if(!object || !file_constraints) {
        return new Error('validateObject parameters were null');
    }

    let validate_result = validate(object, file_constraints, {format: 'flat'});
    if (!validate_result) return null;
    return new Error(validate_result);
}

async function validateObjectAsync(object, file_constraints) {
    if(!object || !file_constraints) {
        return new Error('validateObject parameters were null');
    }

    let validate_result = undefined;
    try {
        validate_result = await validate.async(object, file_constraints, {format: 'flat'});
    } catch(err) {
        return new Error(validate_result);
    }
    // If no error, just return null so this will behave as the non async version.
    return null;
}