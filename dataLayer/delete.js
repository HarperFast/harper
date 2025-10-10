'use strict';

const bulkDeleteValidator = require('../validation/bulkDeleteValidator.js');
const deleteValidator = require('../validation/deleteValidator.js');
const commonUtils = require('../utility/common_utils.js');
const moment = require('moment');
const harperLogger = require('../utility/logging/harper_logger.js');
const { promisify, callbackify } = require('util');
const terms = require('../utility/hdbTerms.ts');
const globalSchema = require('../utility/globalSchema.js');
const pGlobalSchema = promisify(globalSchema.getTableSchema);
const harperBridge = require('./harperBridge/harperBridge.js');
const { DeleteResponseObject } = require('./DataLayerObjects.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;

const SUCCESS_MESSAGE = 'records successfully deleted';

// Callbackified functions
const cbDeleteRecord = callbackify(deleteRecord);

module.exports = {
	delete: cbDeleteRecord,
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
async function deleteFilesBefore(deleteObj) {
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
 */
async function deleteAuditLogsBefore(deleteObj) {
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

	let results = await harperBridge.deleteAuditLogsBefore(deleteObj);
	await pGlobalSchema(deleteObj.schema, deleteObj.table);
	harperLogger.info(`Finished deleting audit logs before ${deleteObj.timestamp}`);

	return results;
}

/**
 * Calls the harper bridge to delete records.
 * @param deleteObject
 * @returns {Promise<string>}
 */
async function deleteRecord(deleteObject) {
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
			returnMsg.skipped_hashes = deleteObject.hash_values.length;
			returnMsg.deleted_hashes = 0;
			return returnMsg;
		}

		throw err;
	}
}
