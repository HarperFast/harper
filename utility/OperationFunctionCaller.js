"use strict";

const log = require('./logging/harper_logger');
const terms = require('./hdbTerms');
const {promisify} = require(`util`);

/**
 * Calls the operation function specified in the parameter with the input specified in the parameter.  Once complete,
 * calls the response function in the parameter with  the operation result as the first parameter.
 * @param operation_function_as_callback - The operation to be performed in the form of a callback function.
 * @param function_input - The input needed for the operation_function_as_callback function.
 * @param followup_async_func - The response function that will be called with the operation function response as an input.  The function is expected to be promisifed, callbacks not supported.
 * @returns {Promise<void>}
 */
async function callOperationFunctionAsCallback(operation_function_as_callback, function_input, followup_async_func) {
    if(!operation_function_as_callback || !(typeof operation_function_as_callback === 'function')) {
        throw new Error('Invalid function parameter');
    }
    let op = promisify(operation_function_as_callback);
    let result = await callOperationFunctionAsAwait(op, function_input, followup_async_func);
    return result;
}

async function callOperationFunctionAsAwait(promisified_function, function_input, followup_async_func) {
    if(!promisified_function || !(typeof promisified_function === 'function')) {
        throw new Error('Invalid function parameter');
    }
    let result = undefined;
    try {
        result = await promisified_function(function_input);
        //TODO: followup_async_func is meant to be a function that would prep a response for clustering, but may not be
        // necessary.
        if(followup_async_func) {
            //TODO: Passing result twice seems silly, why is this a thing?
            return await followup_async_func(function_input, result, result);
        }
        return result;
    } catch(err) {
        log.error(`Error calling operation: ${promisified_function.name}`);
        log.error(err);
        throw err;
    }
}

module.exports = {
    callOperationFunctionAsCallback,
    callOperationFunctionAsAwait
};
