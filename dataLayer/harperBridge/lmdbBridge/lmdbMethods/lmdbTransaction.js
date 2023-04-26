'use strict';

const { getSchemaPath } = require('../lmdbUtility/initializePaths');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const { database } = require('../../../../resources/tableLoader');

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
	let root_store = database({ database: schema, table });
	return root_store.transaction(callback);
}
