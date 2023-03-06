'use strict';

const { getSchemaPath } = require('../lmdbUtility/initializePaths');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');

module.exports = {
	flush,
	resetReadTxn,
};

/**
 * This is wrapper for sync/flush to disk
 * @param schema
 * @param table
 * @returns {Promise<any>}
 */
async function flush(schema, table) {
	let environment = await environment_utility.openEnvironment(getSchemaPath(schema, table), table.toString());
	return environment.flushed;
}

/**
 * This is wrapper for resetting the current read transaction to ensure it is the very latest
 * @param schema
 * @param table
 * @returns {void}
 */
async function resetReadTxn(schema, table) {
	try {
		let environment = await environment_utility.openEnvironment(getSchemaPath(schema, table), table.toString());
		environment.resetReadTxn();
	} catch (error) {
		// if no environment, then the read txn can't be out of date!
	}
}
