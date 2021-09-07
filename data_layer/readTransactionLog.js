'use strict';

const harperBridge = require('./harperBridge/harperBridge');
// eslint-disable-next-line no-unused-vars
const ReadTransactionLogObject = require('./ReadTransactionLogObject');
const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const { HDB_ERROR_MSGS } = require('../utility/errors/commonErrors');

const SEARCH_TYPES = Object.values(hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM);

module.exports = readTransactionLog;

/**
 *
 * @param {ReadTransactionLogObject} read_transaction_log_object
 * @returns {Promise<void>}
 */
async function readTransactionLog(read_transaction_log_object) {
	if (hdb_utils.isEmpty(read_transaction_log_object.schema)) {
		throw new Error(HDB_ERROR_MSGS.SCHEMA_REQUIRED_ERR);
	}

	if (hdb_utils.isEmpty(read_transaction_log_object.table)) {
		throw new Error(HDB_ERROR_MSGS.TABLE_REQUIRED_ERR);
	}

	if (
		!hdb_utils.isEmpty(read_transaction_log_object.search_type) &&
		SEARCH_TYPES.indexOf(read_transaction_log_object.search_type) < 0
	) {
		throw new Error(`Invalid search_type '${read_transaction_log_object.search_type}'`);
	}

	return await harperBridge.readTransactionLog(read_transaction_log_object);
}
