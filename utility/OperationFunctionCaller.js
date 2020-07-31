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
    if(!operation_function_as_callback || typeof operation_function_as_callback !== 'function') {
        throw new Error('Invalid function parameter');
    }
    let op = promisify(operation_function_as_callback);
    return await callOperationFunctionAsAwait(op, function_input, followup_async_func);
}

/**
 * Calls the operation function specified in the parameter with the input specified in the parameter.  Once complete,
 * calls the response function in the parameter with  the operation result as the first parameter.
 * @param promisified_function - The operation which is in async/await format
 * @param function_input - The input needed for the operation_function_as_callback function.
 * @param followup_async_func - The response function that will be called with the operation function response as an input.  The function is expected to be promisifed, callbacks not supported.
 * @param orig_req - The original request which may need to be accessed to propagate data.
 * @returns {Promise<void>}
 */
async function callOperationFunctionAsAwait(promisified_function, function_input, followup_async_func, orig_req) {
    if(!promisified_function || typeof promisified_function !== 'function') {
        throw new Error('Invalid function parameter');
    }
    let result = undefined;
    try {
        result = await promisified_function(function_input);
        //TODO: followup_async_func is meant to be a function that would prep a response for clustering, but may not be
        // necessary.
        if (followup_async_func) {
            //TODO: Passing result twice seems silly, why is this a thing?
            await followup_async_func(function_input, result, orig_req);
        }

        // The result from insert or update contains a properties new_attributes/txn_time. It is used by postOperationHandler to propagate
        // attribute metadata across the cluster. After the property has been used we no longer need it and do not want the API returning it,
        // therefore we delete it from the result.
        if (function_input.operation === terms.OPERATIONS_ENUM.INSERT || function_input.operation === terms.OPERATIONS_ENUM.UPDATE) {
            delete result.new_attributes;
            delete result.txn_time;
        } else if (function_input.operation === terms.OPERATIONS_ENUM.DELETE){
            delete result.txn_time;
        }

        return result;
    } catch(err) {
        // This specific check was added to avoid an error message in the log which could make the error look worse than it
        // seems when scanning a log.  In reality a schema already existing isn't really an error, just a failure.
        if(err.message && err.message.includes('already exists')) {
            log.info(err.message);
            throw err;
        }
        log.error(`Error calling operation: ${promisified_function.name}`);
        log.error(err);
        throw err;
    }
}

module.exports = {
    callOperationFunctionAsCallback,
    callOperationFunctionAsAwait
};
