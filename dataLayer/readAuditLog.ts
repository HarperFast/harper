'use strict';

import harperBridge from './harperBridge/harperBridge.js';
// eslint-disable-next-line no-unused-vars
import * as ReadAuditLogObject from './ReadAuditLogObject.js';
import * as hdbUtils from '../utility/common_utils.js';
import * as hdbTerms from '../utility/hdbTerms.js';
import * as envMgr from '../utility/environment/environmentManager.js';
import { handleHDBError, hdbErrors } from '../utility/errors/hdbError.js';
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;

const SEARCH_TYPES = Object.values(hdbTerms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM);
const LOG_NOT_ENABLED_ERR = 'To use this operation audit log must be enabled in harperdb-config.yaml';

export default readAuditLog;

/**
 *
 * @param {ReadAuditLogObject} readAuditLogObject
 * @returns {Promise<void>}
 */
async function readAuditLog(readAuditLogObject: any): Promise<any> {
	const database = readAuditLogObject.database || readAuditLogObject.schema;
	if (hdbUtils.isEmpty(database)) {
		throw new Error(HDB_ERROR_MSGS.SCHEMA_REQUIRED_ERR);
	}

	if (hdbUtils.isEmpty(readAuditLogObject.table)) {
		throw new Error(HDB_ERROR_MSGS.TABLE_REQUIRED_ERR);
	}

	if (!envMgr.get(hdbTerms.CONFIG_PARAMS.LOGGING_AUDITLOG)) {
		throw handleHDBError(
			new Error(),
			LOG_NOT_ENABLED_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdbTerms.LOG_LEVELS.ERROR,
			LOG_NOT_ENABLED_ERR,
			true
		);
	}

	const invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(database, readAuditLogObject.table);
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

	if (!hdbUtils.isEmpty(readAuditLogObject.search_type) && SEARCH_TYPES.indexOf(readAuditLogObject.search_type) < 0) {
		throw new Error(`Invalid searchType '${readAuditLogObject.search_type}'`);
	}

	return await harperBridge.readAuditLog(readAuditLogObject);
}
