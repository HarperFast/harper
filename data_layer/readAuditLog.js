'use strict';

const harperBridge = require('./harperBridge/harperBridge');
// eslint-disable-next-line no-unused-vars
const ReadAuditLogObject = require('./ReadAuditLogObject');
const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const env_mgr = require('../utility/environment/environmentManager');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const SEARCH_TYPES = Object.values(hdb_terms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM);
const LOG_NOT_ENABLED_ERR = 'To use this operation audit log must be enabled in harperdb.conf';

module.exports = readAuditLog;

/**
 *
 * @param {ReadAuditLogObject} read_audit_log_object
 * @returns {Promise<void>}
 */
async function readAuditLog(read_audit_log_object) {
	if (hdb_utils.isEmpty(read_audit_log_object.schema)) {
		throw new Error(HDB_ERROR_MSGS.SCHEMA_REQUIRED_ERR);
	}

	if (hdb_utils.isEmpty(read_audit_log_object.table)) {
		throw new Error(HDB_ERROR_MSGS.TABLE_REQUIRED_ERR);
	}

	if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.LOGGING_AUDITLOG)) {
		throw handleHDBError(
			new Error(),
			LOG_NOT_ENABLED_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdb_terms.LOG_LEVELS.ERROR,
			LOG_NOT_ENABLED_ERR,
			true
		);
	}

	const invalid_schema_table_msg = hdb_utils.checkSchemaTableExist(
		read_audit_log_object.schema,
		read_audit_log_object.table
	);
	if (invalid_schema_table_msg) {
		throw handleHDBError(
			new Error(),
			invalid_schema_table_msg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdb_terms.LOG_LEVELS.ERROR,
			invalid_schema_table_msg,
			true
		);
	}

	if (
		!hdb_utils.isEmpty(read_audit_log_object.search_type) &&
		SEARCH_TYPES.indexOf(read_audit_log_object.search_type) < 0
	) {
		throw new Error(`Invalid search_type '${read_audit_log_object.search_type}'`);
	}

	return await harperBridge.readAuditLog(read_audit_log_object);
}
