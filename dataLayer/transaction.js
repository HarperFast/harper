'use strict';

const harperBridge = require('./harperBridge/harperBridge.js');

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
function writeTransaction(schema, table, callback) {
	return harperBridge.writeTransaction(schema, table, callback);
}
