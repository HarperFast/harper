'use strict';;
import { database } from '../../../../resources/databases.js';

export {
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
	let rootStore = database({ database: schema, table });
	return rootStore.transaction(callback);
}
