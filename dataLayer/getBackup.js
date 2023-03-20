'use strict';

const harperBridge = require('./harperBridge/harperBridge');
// eslint-disable-next-line no-unused-vars
const GetBackupObject = require('./GetBackupObject');
const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const env_mgr = require('../utility/environment/environmentManager');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

module.exports = getBackup;

/**
 *
 * @param {GetBackupObject} get_backup_object
 * @returns {Promise<void>}
 */
async function getBackup(get_backup_object) {
	if (hdb_utils.isEmpty(get_backup_object.schema)) {
		throw new Error(HDB_ERROR_MSGS.SCHEMA_REQUIRED_ERR);
	}

	if (hdb_utils.isEmpty(get_backup_object.table)) {
		throw new Error(HDB_ERROR_MSGS.TABLE_REQUIRED_ERR);
	}

	const invalid_schema_table_msg = hdb_utils.checkSchemaTableExist(get_backup_object.schema, get_backup_object.table);
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

	return await harperBridge.getBackup(read_audit_log_object);
}
