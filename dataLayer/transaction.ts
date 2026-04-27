'use strict';

import harperBridge from './harperBridge/harperBridge.js';

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
function writeTransaction(schema: string, table: string, callback: () => any): Promise<any> {
	return harperBridge.writeTransaction(schema, table, callback);
}
