'use strict';

const log = require('./logging/harper_logger.js');
const terms = require('./hdbTerms.ts');

/**
 * Calls the operation function specified in the parameter with the input specified in the parameter.  Once complete,
 * calls the response function in the parameter with  the operation result as the first parameter.
 * @param promisifiedFunction - The operation which is in async/await format
 * @param functionInput - The input needed for the operationFunctionAsCallback function.
 * @param followupAsyncFunc - The response function that will be called with the operation function response as an input.  The function is expected to be promisifed, callbacks not supported.
 * @returns {Promise<{}>}
 */
async function callOperationFunctionAsAwait(
	promisifiedFunction,
	functionInput,
	followupAsyncFunc,
) {
	if (!promisifiedFunction || typeof promisifiedFunction !== 'function') {
		throw new Error('Invalid function parameter');
	}
	let result = undefined;
	try {
		result = await promisifiedFunction(functionInput);

		if (followupAsyncFunc) {
			//TODO: Passing result twice seems silly, why is this a thing?
			await followupAsyncFunc(functionInput, result);
		}

		// The result from insert, update, or upsert contains a properties new_attributes/txnTime. It is used by postOperationHandler to propagate
		// attribute metadata. After the property has been used we no longer need it and do not want the API returning it,
		// therefore we delete it from the result.
		if (
			functionInput.operation === terms.OPERATIONS_ENUM.INSERT ||
			functionInput.operation === terms.OPERATIONS_ENUM.UPDATE ||
			functionInput.operation === terms.OPERATIONS_ENUM.UPSERT
		) {
			delete result.new_attributes;
			delete result.txn_time;
		} else if (functionInput.operation === terms.OPERATIONS_ENUM.DELETE) {
			delete result.txn_time;
		}

		return result;
	} catch (err) {
		// This specific check was added to avoid an error message in the log which could make the error look worse than it
		// seems when scanning a log.  In reality a schema already existing isn't really an error, just a failure.
		if (err.message && typeof err.message === 'string' && err.message.includes('already exists')) {
			log.info(err.message);
			throw err;
		}
		// This check is here to make sure a new HdbError is logged correctly
		if (err.http_resp_msg) {
			log.error(`Error calling operation: ${promisifiedFunction.name}`);
			log.error(err.http_resp_msg);
			throw err;
		}
		log.error(`Error calling operation: ${promisifiedFunction.name}`);
		log.error(err);
		throw err;
	}
}

module.exports = {
	callOperationFunctionAsAwait,
};
