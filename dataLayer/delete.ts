'use strict';

import * as bulkDeleteValidator from '../validation/bulkDeleteValidator.js';
import * as deleteValidator from '../validation/deleteValidator.js';
import * as commonUtils from '../utility/common_utils.js';
import moment from 'moment';
import * as harperLogger from '../utility/logging/harper_logger.js';
import { promisify, callbackify } from 'util';
import * as terms from '../utility/hdbTerms.js';
import * as globalSchema from '../utility/globalSchema.js';
const pGlobalSchema = promisify(globalSchema.getTableSchema);
import harperBridge from './harperBridge/harperBridge.js';
import { DeleteResponseObject } from './DataLayerObjects.js';
import { handleHDBError, hdbErrors } from '../utility/errors/hdbError.js';
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
import * as DeleteAuditLogsBeforeResults from './harperBridge/lmdbBridge/lmdbMethods/DeleteAuditLogsBeforeResults.js';
import * as DeleteBeforeObject from './DeleteBeforeObject.js';

const SUCCESS_MESSAGE = 'records successfully deleted';

// Callbackified functions
const cbDeleteRecord = callbackify(deleteRecord);

export {
	cbDeleteRecord as delete,
	deleteRecord,
	deleteFilesBefore,
	deleteAuditLogsBefore,
};

/**
 * Deletes files that have a system date before the date parameter.
 * Note this does not technically delete the values from the database.
 * This serves only to remove files for devices that have a small amount of disk space.
 *
 * @param deleteObj - the request passed from chooseOperation.
 */
async function deleteFilesBefore(deleteObj: any): Promise<any> {
	let validation = bulkDeleteValidator.default(deleteObj, 'date');
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	commonUtils.transformReq(deleteObj);

	let parsedDate = moment(deleteObj.date, moment.ISO_8601);
	if (!parsedDate.isValid()) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.INVALID_DATE,
			HTTP_STATUS_CODES.BAD_REQUEST,
			terms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.INVALID_DATE,
			true
		);
	}

	let invalidSchemaTableMsg = commonUtils.checkSchemaTableExist(deleteObj.schema, deleteObj.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			terms.LOG_LEVELS.ERROR,
			invalidSchemaTableMsg,
			true
		);
	}

	let results = await harperBridge.deleteRecordsBefore(deleteObj);
	await pGlobalSchema(deleteObj.schema, deleteObj.table);
	harperLogger.info(`Finished deleting files before ${deleteObj.date}`);
	if (results && results.message) {
		return results.message;
	}
}

/**
 * Deletes audit logs which are older than a specific date
 *
 * @param {DeleteBeforeObject} deleteObj - the request passed from chooseOperation.
 *
 * @deprecated This has been deprecated in favor of deleteTransactionLogsBefore.
 */
async function deleteAuditLogsBefore(deleteObj: DeleteBeforeObject): Promise<DeleteAuditLogsBeforeResults> {
	let validation = bulkDeleteValidator.default(deleteObj, 'timestamp');
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	commonUtils.transformReq(deleteObj);

	if (isNaN(deleteObj.timestamp as number)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.INVALID_VALUE('Timestamp'),
			HTTP_STATUS_CODES.BAD_REQUEST,
			terms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.INVALID_VALUE('Timestamp'),
			true
		);
	}

	let invalidSchemaTableMsg = commonUtils.checkSchemaTableExist(deleteObj.schema, deleteObj.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			terms.LOG_LEVELS.ERROR,
			invalidSchemaTableMsg,
			true
		);
	}

	const results = await harperBridge.deleteTransactionLogsBefore(deleteObj);
	await pGlobalSchema(deleteObj.schema, deleteObj.table);
	harperLogger.info(`Finished deleting audit logs before ${deleteObj.timestamp}`);

	return new DeleteAuditLogsBeforeResults(results.start_timestamp, results.end_timestamp, results.transactions_deleted);
}

/**
 * Calls the harper bridge to delete records.
 * @param deleteObject
 * @returns {Promise<string>}
 */
async function deleteRecord(deleteObject: any): Promise<any> {
	if (deleteObject.ids) deleteObject.hash_values = deleteObject.ids;
	let validation = deleteValidator.default(deleteObject);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	commonUtils.transformReq(deleteObject);

	let invalidSchemaTableMsg = commonUtils.checkSchemaTableExist(deleteObject.schema, deleteObject.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			terms.LOG_LEVELS.ERROR,
			invalidSchemaTableMsg,
			true
		);
	}

	try {
		await pGlobalSchema(deleteObject.schema, deleteObject.table);
		let deleteResultObject = await harperBridge.deleteRecords(deleteObject);

		if (commonUtils.isEmptyOrZeroLength(deleteResultObject.message)) {
			deleteResultObject.message = `${deleteResultObject.deleted_hashes.length} of ${deleteObject.hash_values.length} ${SUCCESS_MESSAGE}`;
		}
		return deleteResultObject;
	} catch (err: any) {
		if (err.message === terms.SEARCH_NOT_FOUND_MESSAGE) {
			let returnMsg = new DeleteResponseObject();
			returnMsg.message = terms.SEARCH_NOT_FOUND_MESSAGE;
			returnMsg.skipped_hashes = deleteObject.hash_values.length;
			returnMsg.deleted_hashes = [];
			return returnMsg;
		}

		throw err;
	}
}
