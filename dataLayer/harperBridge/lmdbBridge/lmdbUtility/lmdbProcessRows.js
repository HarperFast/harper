'use strict';

// eslint-disable-next-line no-unused-vars
const InsertObject = require('../../../InsertObject');
const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const uuid = require('uuid');
const { handleHDBError, hdb_errors } = require('../../../../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

module.exports = processRows;

/**
 * parses the records and validates the hash value for each row as well as adding updated/created time stamps
 * @param {InsertObject} insert_obj
 * @param {Array.<String>} attributes
 * @param {String} hash_attribute
 */
function processRows(insert_obj, attributes, hash_attribute) {
	for (let x = 0; x < attributes.length; x++) {
		validateAttribute(attributes[x]);
	}

	let { records } = insert_obj;

	// Iterates through array of record objects and validates their hash
	for (let x = 0; x < records.length; x++) {
		let record = records[x];
		validateHash(record, hash_attribute, insert_obj.operation);
	}
}
processRows.validateAttribute = validateAttribute;

/**
 * Validates that attribute is under max size and is not null, undefined or empty.
 * @param attribute
 */
function validateAttribute(attribute) {
	if (Buffer.byteLength(String(attribute)) > hdb_terms.INSERT_MAX_CHARACTER_SIZE) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ATTR_NAME_LENGTH_ERR(attribute),
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (hdb_utils.isEmptyOrZeroLength(attribute) || hdb_utils.isEmpty(attribute.trim())) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.ATTR_NAME_NULLISH_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
}

/**
 * Validates hash value exists and under max char size. If the operation is 'insert' and the hash doesn't exist it
 * will create one.
 * @param record
 * @param hash_attribute
 * @param operation
 */
function validateHash(record, hash_attribute, operation) {
	if (!record.hasOwnProperty(hash_attribute) || hdb_utils.isEmptyOrZeroLength(record[hash_attribute])) {
		if (operation === hdb_terms.OPERATIONS_ENUM.INSERT || operation === hdb_terms.OPERATIONS_ENUM.UPSERT) {
			record[hash_attribute] = uuid.v4();
			//return here since the rest of the validations do not apply
			return;
		}

		log.error('Update transaction aborted due to record with no hash value:', record);
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.RECORD_MISSING_HASH_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (Buffer.byteLength(String(record[hash_attribute])) > hdb_terms.INSERT_MAX_CHARACTER_SIZE) {
		log.error(record);
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.HASH_VAL_LENGTH_ERR,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
}
