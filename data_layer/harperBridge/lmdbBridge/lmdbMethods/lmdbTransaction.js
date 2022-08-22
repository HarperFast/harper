'use strict';

const path = require('path');
const { getBaseSchemaPath } = require('../lmdbUtility/initializePaths');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');

module.exports = {
	writeTransaction,
};

/**
 * This is wrapper for write transactions, ensuring that all reads and writes within the callback occur atomically
 * @param schema
 * @param table
 * @param callback
 * @returns {Promise<any>}
 */
async function writeTransaction(schema, table, callback) {
	let env_base_path = path.join(getBaseSchemaPath(), schema);
	let environment = await environment_utility.openEnvironment(env_base_path, table);
	return environment.transaction(callback);
}
