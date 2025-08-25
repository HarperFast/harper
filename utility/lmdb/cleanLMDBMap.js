'use strict';

const environmentUtility = require('./environmentUtility.js');
const harperLogger = require('../logging/harper_logger.js');
const LMDB_ERRORS = require('../errors/commonErrors.js').LMDB_ERRORS_ENUM;

module.exports = cleanLMDBMap;

/**
 * this function strips away the cached environments from global when a schema item is removed
 * @param msg
 */
async function cleanLMDBMap(msg) {
	try {
		if (global.lmdb_map !== undefined && msg.operation !== undefined) {
			let keys = Object.keys(global.lmdb_map);
			let cachedEnvironment = undefined;

			switch (msg.operation) {
				case 'drop_schema':
					for (let x = 0; x < keys.length; x++) {
						let key = keys[x];
						if (key.startsWith(`${msg.schema}.`) || key.startsWith(`txn.${msg.schema}.`)) {
							try {
								await environmentUtility.closeEnvironment(global.lmdb_map[key]);
							} catch (err) {
								if (err.message !== LMDB_ERRORS.ENV_REQUIRED) {
									throw err;
								}
							}
						}
					}
					break;
				case 'drop_table':
					// eslint-disable-next-line no-case-declarations
					let schemaTableName = `${msg.schema}.${msg.table}`;
					// eslint-disable-next-line no-case-declarations
					let txnSchemaTableName = `txn.${schemaTableName}`;
					try {
						await environmentUtility.closeEnvironment(global.lmdb_map[schemaTableName]);
						await environmentUtility.closeEnvironment(global.lmdb_map[txnSchemaTableName]);
					} catch (err) {
						if (err.message !== LMDB_ERRORS.ENV_REQUIRED) {
							throw err;
						}
					}
					break;
				case 'drop_attribute':
					cachedEnvironment = global.lmdb_map[`${msg.schema}.${msg.table}`];
					if (
						cachedEnvironment !== undefined &&
						typeof cachedEnvironment.dbis === 'object' &&
						cachedEnvironment.dbis[`${msg.attribute}`] !== undefined
					) {
						delete cachedEnvironment.dbis[`${msg.attribute}`];
					}
					break;
				default:
					break;
			}
		}
	} catch (e) {
		harperLogger.error(e);
	}
}
