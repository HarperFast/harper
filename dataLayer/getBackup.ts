/**
 * This file is used by `utility/operation_authorization.js` to define the permissions.
 */

'use strict';

import harperBridge from './harperBridge/harperBridge.ts';
// eslint-disable-next-line no-unused-vars
import GetBackupObject from './GetBackupObject.ts';
import * as hdbUtils from '../utility/common_utils.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import { handleHDBError } from '../utility/errors/hdbError.ts';
import { HDB_ERROR_MSGS, HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';

/**
 *
 * @param {GetBackupObject} getBackupObject
 * @returns {Promise<void>}
 */
export default async function getBackup(getBackupObject: any) {
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

	return harperBridge.getBackup(getBackupObject);
}
