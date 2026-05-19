'use strict';

const harperBridge = require('./harperBridge/harperBridge').default;

/**
 * This is wrapper for write transactions, ensuring that all reads and writes within the callback occur atomically
 * @param schema
 * @param table
 * @param callback
 * @returns {Promise<any>}
 */
export function writeTransaction(schema: string, table: string, callback: any) {
	return harperBridge.writeTransaction(schema, table, callback);
}
