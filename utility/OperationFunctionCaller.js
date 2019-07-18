"use strict";

const log = require('./logging/harper_logger');
const terms = require('./hdbTerms');
const {promisify} = require(`util`);

/**
 * Calls the operation function specified in the parameter with the input specified in the parameter.  Once complete,
 * calls the response function in the parameter with  the operation result as the first parameter.
 * @param operation_function_as_callback - The operation to be performed in the form of a callback function.
 * @param function_input - The input needed for the operation_function_as_callback function.
 * @param followup_async_func - The response function that will be called with the operation function response as an input.
 * @returns {Promise<void>}
 */
async function callOperationFunction(operation_function_as_callback, function_input, followup_async_func) {
    let op = promisify(operation_function_as_callback);
    let result = undefined;
    try {
        result = await op(function_input);
        //TODO: followup_async_func is meant to be a function that would prep a response for clustering, but may not be
        // necessary.
        if(followup_async_func) {
            return await followup_async_func(result);
        }
        return result;
    } catch(err) {
        log.error(`Error calling operation ${operation_function_as_callback}`);
        log.error(err);
        return null;
    }
}

module.exports = {
    callOperationFunction
};
