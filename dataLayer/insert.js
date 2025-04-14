'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */
const insertValidator = require('../validation/insertValidator');
const hdb_utils = require('../utility/common_utils');
const util = require('util');
// Leave this unused signalling import here. Due to circular dependencies we bring it in early to load it before the bridge
const harperBridge = require('./harperBridge/harperBridge');
const global_schema = require('../utility/globalSchema');
const log = require('../utility/logging/harper_logger');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

const p_global_schema = util.promisify(global_schema.getTableSchema);

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
 * @param {Object} write_object
 * @returns {Promise<{table_schema, hashes: any[], attributes: string[]}>}
 */
async function validation(write_object) {
	// Need to validate these outside of the validator as the getTableSchema call will fail with
	// invalid values.

	if (hdb_utils.isEmpty(write_object)) {
		throw new Error('invalid update parameters defined.');
	}
	if (hdb_utils.isEmptyOrZeroLength(write_object.schema)) {
		throw new Error('invalid database specified.');
	}
	if (hdb_utils.isEmptyOrZeroLength(write_object.table)) {
		throw new Error('invalid table specified.');
	}

	let schema_table = await p_global_schema(write_object.schema, write_object.table);

	//validate insert_object for required attributes
	let validator = insertValidator(write_object);
	if (validator) {
		throw validator;
	}

	if (!Array.isArray(write_object.records)) {
		throw new Error('records must be an array');
	}

	let hash_attribute = schema_table.hash_attribute;
	let dups = new Set();
	let attributes = {};

	let is_update = false;
	if (write_object.operation === 'update') {
		is_update = true;
	}

	write_object.records.forEach((record) => {
		if (is_update && hdb_utils.isEmptyOrZeroLength(record[hash_attribute])) {
			log.error('a valid hash attribute must be provided with update record:', record);
			throw new Error('a valid hash attribute must be provided with update record');
		}

		if (
			!hdb_utils.isEmptyOrZeroLength(record[hash_attribute]) &&
			(record[hash_attribute] === 'null' || record[hash_attribute] === 'undefined')
		) {
			log.error(`a valid hash value must be provided with ${write_object.operation} record:`, record);
			throw new Error(`"${record[hash_attribute]}" is not a valid hash attribute value`);
		}

		if (
			!hdb_utils.isEmpty(record[hash_attribute]) &&
			record[hash_attribute] !== '' &&
			dups.has(hdb_utils.autoCast(record[hash_attribute]))
		) {
			record.skip = true;
		}

		dups.add(hdb_utils.autoCast(record[hash_attribute]));

		for (let attr in record) {
			attributes[attr] = 1;
		}
	});

	//in case the hash_attribute was not on the object(s) for inserts where they want to auto-key we manually add the hash_attribute to attributes
	attributes[hash_attribute] = 1;

	return {
		schema_table: schema_table,
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
 * Inserts data specified in the insert_object parameter.
 * @param insert_object
 */
async function insertData(insert_object) {
	if (insert_object.operation !== 'insert') {
		throw new Error('invalid operation, must be insert');
	}

	let validator = insertValidator(insert_object);
	if (validator) {
		throw handleHDBError(new Error(), validator.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	hdb_utils.transformReq(insert_object);

	let invalid_schema_table_msg = hdb_utils.checkSchemaTableExist(insert_object.schema, insert_object.table);
	if (invalid_schema_table_msg) {
		throw handleHDBError(new Error(), invalid_schema_table_msg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let bridge_insert_result = await harperBridge.createRecords(insert_object);

	return returnObject(
		INSERT_ACTION,
		bridge_insert_result.written_hashes,
		insert_object,
		bridge_insert_result.skipped_hashes,
		bridge_insert_result.new_attributes,
		bridge_insert_result.txn_time
	);
}

/**
 * Updates the data in the update_object parameter.
 * @param update_object - The data that will be updated in the database
 */
async function updateData(update_object) {
	if (update_object.operation !== 'update') {
		throw new Error('invalid operation, must be update');
	}

	let validator = insertValidator(update_object);
	if (validator) {
		throw handleHDBError(new Error(), validator.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	hdb_utils.transformReq(update_object);

	let invalid_schema_table_msg = hdb_utils.checkSchemaTableExist(update_object.schema, update_object.table);
	if (invalid_schema_table_msg) {
		throw handleHDBError(new Error(), invalid_schema_table_msg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let bridge_update_result = await harperBridge.updateRecords(update_object);
	if (!hdb_utils.isEmpty(bridge_update_result.existing_rows)) {
		return returnObject(
			bridge_update_result.update_action,
			[],
			update_object,
			bridge_update_result.hashes,
			undefined,
			bridge_update_result.txn_time
		);
	}

	return returnObject(
		UPDATE_ACTION,
		bridge_update_result.written_hashes,
		update_object,
		bridge_update_result.skipped_hashes,
		bridge_update_result.new_attributes,
		bridge_update_result.txn_time
	);
}

/**
 * Upsert the data in the upsert_object parameter.
 * @param upsert_object - Represents the data that will be upserted in the database
 */
async function upsertData(upsert_object) {
	if (upsert_object.operation !== 'upsert') {
		throw handleHDBError(new Error(), 'invalid operation, must be upsert', HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
	}

	let validator = insertValidator(upsert_object);
	if (validator) {
		throw handleHDBError(new Error(), validator.message, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	hdb_utils.transformReq(upsert_object);

	let invalid_schema_table_msg = hdb_utils.checkSchemaTableExist(upsert_object.schema, upsert_object.table);
	if (invalid_schema_table_msg) {
		throw handleHDBError(new Error(), invalid_schema_table_msg, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	let bridge_upsert_result = await harperBridge.upsertRecords(upsert_object);

	return returnObject(
		UPSERT_ACTION,
		bridge_upsert_result.written_hashes,
		upsert_object,
		[],
		bridge_upsert_result.new_attributes,
		bridge_upsert_result.txn_time
	);
}

/**
 * Constructs return object for insert, update, and upsert.
 * @param action
 * @param written_hashes
 * @param object
 * @param skipped - not included for upsert ops
 * @param new_attributes
 * @param txn_time
 * @returns {{ message: string, new_attributes: *, txn_time: * }}
 */

function returnObject(action, written_hashes, object, skipped, new_attributes, txn_time) {
	let return_object = {
		message: `${action} ${written_hashes.length} of ${written_hashes.length + skipped.length} records`,
		new_attributes,
		txn_time: txn_time,
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
	hdb_utils.transformReq(object);
	return harperBridge.flush(object.schema, object.table);
}
