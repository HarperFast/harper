'use strict';;
import { getSchemaPath } from '../lmdbUtility/initializePaths.js';
import * as environmentUtility from '../../../../utility/lmdb/environmentUtility.js';

export {
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
	let environment = await environmentUtility.openEnvironment(getSchemaPath(schema, table), table.toString());
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
		let environment = await environmentUtility.openEnvironment(getSchemaPath(schema, table), table.toString());
		environment.resetReadTxn();
	} catch {
		// if no environment, then the read txn can't be out of date!
	}
}
