'use strict';

import bulkDeleteValidator from '../validation/bulkDeleteValidator.ts';
import deleteValidator from '../validation/deleteValidator.ts';
import * as commonUtils from '../utility/common_utils.ts';
import moment from 'moment';
import harperLogger from '../utility/logging/harper_logger.ts';
import { promisify, callbackify } from 'util';
import * as terms from '../utility/hdbTerms.ts';
import * as globalSchema from '../utility/globalSchema.ts';
const pGlobalSchema = promisify(globalSchema.getTableSchema);
import harperBridge from './harperBridge/harperBridge.ts';
import { DeleteResponseObject } from './DataLayerObjects.ts';
import { handleHDBError } from '../utility/errors/hdbError.ts';
import { HDB_ERROR_MSGS, HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';

import DeleteAuditLogsBeforeResults from './harperBridge/lmdbBridge/lmdbMethods/DeleteAuditLogsBeforeResults.js';

const SUCCESS_MESSAGE = 'records successfully deleted';

// Callbackified functions

/**
 * Deletes files that have a system date before the date parameter.
 * Note this does not technically delete the values from the database.
 * This serves only to remove files for devices that have a small amount of disk space.
 *
 * @param deleteObj - the request passed from chooseOperation.
 */
export async function deleteFilesBefore(deleteObj: any) {
	let validation = bulkDeleteValidator(deleteObj, 'date');
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
export async function deleteAuditLogsBefore(deleteObj: any) {
	let validation = bulkDeleteValidator(deleteObj, 'timestamp');
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	commonUtils.transformReq(deleteObj);

	if (isNaN(deleteObj.timestamp)) {
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
export async function deleteRecord(deleteObject: any) {
	if (deleteObject.ids) deleteObject.hash_values = deleteObject.ids;
	let validation = deleteValidator(deleteObject);
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
	} catch (err) {
		if (err.message === terms.SEARCH_NOT_FOUND_MESSAGE) {
			let returnMsg = new DeleteResponseObject();
			returnMsg.message = terms.SEARCH_NOT_FOUND_MESSAGE;
			returnMsg.skipped_hashes = [deleteObject.hash_values.length];
			returnMsg.deleted_hashes = [];
			return returnMsg;
		}

		throw err;
	}
}

export const delete_ = callbackify(deleteRecord);
