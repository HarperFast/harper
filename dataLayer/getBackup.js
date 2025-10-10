'use strict';

const harperBridge = require('./harperBridge/harperBridge.js');
// eslint-disable-next-line no-unused-vars
const GetBackupObject = require('./GetBackupObject.js');
const hdbUtils = require('../utility/common_utils.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const envMgr = require('../utility/environment/environmentManager.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;

module.exports = getBackup;

/**
 *
 * @param {GetBackupObject} getBackupObject
 * @returns {Promise<void>}
 */
async function getBackup(getBackupObject) {
	if (hdbUtils.isEmpty(getBackupObject.schema)) {
		throw new Error(HDB_ERROR_MSGS.SCHEMA_REQUIRED_ERR);
	}

	if (hdbUtils.isEmpty(getBackupObject.table)) {
		throw new Error(HDB_ERROR_MSGS.TABLE_REQUIRED_ERR);
	}

	const invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(getBackupObject.schema, getBackupObject.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdbTerms.LOG_LEVELS.ERROR,
			invalidSchemaTableMsg,
			true
		);
	}

	return await harperBridge.getBackup(readAuditLogObject);
}
