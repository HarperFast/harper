'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */
const insertValidator = require('../validation/insertValidator.js');
const hdbUtils = require('../utility/common_utils.js');
const util = require('util');
// Leave this unused signalling import here. Due to circular dependencies we bring it in early to load it before the bridge
const harperBridge = require('./harperBridge/harperBridge.js');
const globalSchema = require('../utility/globalSchema.js');
const log = require('../utility/logging/harper_logger.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;

const pGlobalSchema = util.promisify(globalSchema.getTableSchema);

const UPDATE_ACTION = 'updated';
const INSERT_ACTION = 'inserted';
const UPSERT_ACTION = 'upserted';

module.exports = {
	insert: insertData,
	update: updateData,
	upsert: upsertData,
	validation,
	flush,
};

//IMPORTANT - This validation function is the async version of the code in harperBridge/bridgeUtility/insertUpdateValidate.js
// make sure any changes below are also made there. This is to resolve a circular dependency.
/**
 *  Takes an insert/update object and validates attributes, also looks for dups and get a list of all attributes from the record set
 * @param {Object} writeObject
 * @returns {Promise<{tableSchema, hashes: any[], attributes: string[]}>}
 */
async function validation(writeObject) {
	// Need to validate these outside of the validator as the getTableSchema call will fail with
	// invalid values.

	if (hdbUtils.isEmpty(writeObject)) {
		throw new Error('invalid update parameters defined.');
	}
	if (hdbUtils.isEmptyOrZeroLength(writeObject.schema)) {
		throw new Error('invalid database specified.');
	}
	if (hdbUtils.isEmptyOrZeroLength(writeObject.table)) {
		throw new Error('invalid table specified.');
	}

	let schemaTable = await pGlobalSchema(writeObject.schema, writeObject.table);

	//validate insertObject for required attributes
	let validator = insertValidator(writeObject);
	if (validator) {
		throw validator;
	}

	if (!Array.isArray(writeObject.records)) {
		throw new Error('records must be an array');
	}

	let hash_attribute = schemaTable.hash_attribute;
	let dups = new Set();
	let attributes = {};

	let isUpdate = false;
	if (writeObject.operation === 'update') {
		isUpdate = true;
	}

	writeObject.records.forEach((record) => {
		if (isUpdate && hdbUtils.isEmptyOrZeroLength(record[hash_attribute])) {
			log.error('a valid hash attribute must be provided with update record:', record);
			throw new Error('a valid hash attribute must be provided with update record');
		}

		if (
			!hdbUtils.isEmptyOrZeroLength(record[hash_attribute]) &&
			(record[hash_attribute] === 'null' || record[hash_attribute] === 'undefined')
		) {
			log.error(`a valid hash value must be provided with ${writeObject.operation} record:`, record);
			throw new Error(`"${record[hash_attribute]}" is not a valid hash attribute value`);
		}

		if (
			!hdbUtils.isEmpty(record[hash_attribute]) &&
			record[hash_attribute] !== '' &&
			dups.has(hdbUtils.autoCast(record[hash_attribute]))
		) {
			record.skip = true;
		}

		dups.add(hdbUtils.autoCast(record[hash_attribute]));

		for (let attr in record) {
			attributes[attr] = 1;
		}
	});

	//in case the hash_attribute was not on the object(s) for inserts where they want to auto-key we manually add the hash_attribute to attributes
	attributes[hash_attribute] = 1;

	return {
		schema_table: schemaTable,
		hashes: Array.from(dups),
		attributes: Object.keys(attributes),
	};
}

/** NOTE **
 * Due to circular dependencies between insert.js and schema.js, specifically around createNewAttribute, there
 * is duplicate insertData code in fsCreateAttribute. If you change something here related to insertData, you should
 * do the same in fsCreateAttribute.js
 */

/**
 * Inserts data specified in the insertObject parameter.
 * @param insertObject
 */
async function insertData(insertObject) {
	if (insertObject.operation !== 'insert') {
		throw new Error('invalid operation, must be insert');
	}

	let validator = insertValidator(insertObject);
	if (validator) {
		throw handleHDBError(new Error(), validator.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	hdbUtils.transformReq(insertObject);

	let invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(insertObject.schema, insertObject.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(new Error(), invalidSchemaTableMsg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let bridgeInsertResult = await harperBridge.createRecords(insertObject);

	return returnObject(
		INSERT_ACTION,
		bridgeInsertResult.written_hashes,
		insertObject,
		bridgeInsertResult.skipped_hashes,
		bridgeInsertResult.new_attributes,
		bridgeInsertResult.txn_time
	);
}

/**
 * Updates the data in the updateObject parameter.
 * @param updateObject - The data that will be updated in the database
 */
async function updateData(updateObject) {
	if (updateObject.operation !== 'update') {
		throw new Error('invalid operation, must be update');
	}

	let validator = insertValidator(updateObject);
	if (validator) {
		throw handleHDBError(new Error(), validator.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	hdbUtils.transformReq(updateObject);

	let invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(updateObject.schema, updateObject.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(new Error(), invalidSchemaTableMsg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let bridgeUpdateResult = await harperBridge.updateRecords(updateObject);
	if (!hdbUtils.isEmpty(bridgeUpdateResult.existing_rows)) {
		return returnObject(
			bridgeUpdateResult.update_action,
			[],
			updateObject,
			bridgeUpdateResult.hashes,
			undefined,
			bridgeUpdateResult.txn_time
		);
	}

	return returnObject(
		UPDATE_ACTION,
		bridgeUpdateResult.written_hashes,
		updateObject,
		bridgeUpdateResult.skipped_hashes,
		bridgeUpdateResult.new_attributes,
		bridgeUpdateResult.txn_time
	);
}

/**
 * Upsert the data in the upsertObject parameter.
 * @param upsertObject - Represents the data that will be upserted in the database
 */
async function upsertData(upsertObject) {
	if (upsertObject.operation !== 'upsert') {
		throw handleHDBError(new Error(), 'invalid operation, must be upsert', HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
	}

	let validator = insertValidator(upsertObject);
	if (validator) {
		throw handleHDBError(new Error(), validator.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	hdbUtils.transformReq(upsertObject);

	let invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(upsertObject.schema, upsertObject.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(new Error(), invalidSchemaTableMsg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let bridgeUpsertResult = await harperBridge.upsertRecords(upsertObject);

	return returnObject(
		UPSERT_ACTION,
		bridgeUpsertResult.written_hashes,
		upsertObject,
		[],
		bridgeUpsertResult.new_attributes,
		bridgeUpsertResult.txn_time
	);
}

/**
 * Constructs return object for insert, update, and upsert.
 * @param action
 * @param written_hashes
 * @param object
 * @param skipped - not included for upsert ops
 * @param new_attributes
 * @param txnTime
 * @returns {{ message: string, new_attributes: *, txn_time: * }}
 */

function returnObject(action, written_hashes, object, skipped, new_attributes, txnTime) {
	let return_object = {
		message: `${action} ${written_hashes.length} of ${written_hashes.length + skipped.length} records`,
		new_attributes,
		txn_time: txnTime,
	};

	if (action === INSERT_ACTION) {
		return_object.inserted_hashes = written_hashes;
		return_object.skipped_hashes = skipped;
		return return_object;
	}

	if (action === UPSERT_ACTION) {
		return_object.upserted_hashes = written_hashes;
		return return_object;
	}

	return_object.update_hashes = written_hashes;
	return_object.skipped_hashes = skipped;
	return return_object;
}

function flush(object) {
	hdbUtils.transformReq(object);
	return harperBridge.flush(object.schema, object.table);
}
