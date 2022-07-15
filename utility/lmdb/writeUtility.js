'use strict';

const environment_util = require('./environmentUtility');
const InsertRecordsResponseObject = require('./InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('./UpdateRecordsResponseObject');
const UpsertRecordsResponseObject = require('./UpsertRecordsResponseObject');
const common = require('./commonUtility');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const lmdb_terms = require('./terms');
const hdb_terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');
const uuid = require('uuid');
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdb_terms;

const CREATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME;

/**
 * inserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @param {Boolean} generate_timestamps - defines if timestamps should be created
 * @returns {Promise<InsertRecordsResponseObject>}
 */
async function insertRecords(env, hash_attribute, write_attributes, records, generate_timestamps = true) {
	validateWrite(env, hash_attribute, write_attributes, records);

	try {
		initializeTransaction(env, hash_attribute, write_attributes);

		let result = new InsertRecordsResponseObject();

		let puts = [];
		let keys = [];
		for (let index = 0; index < records.length; index++) {
			let record = records[index];
			setTimestamps(record, true, generate_timestamps);

			let promise = insertRecord(env, hash_attribute, write_attributes, record);
			let cast_hash_value = record[hash_attribute];
			puts.push(promise);
			keys.push(cast_hash_value);
		}

		return await finalizeWrite(puts, keys, records, result);
	} catch (e) {
		throw e;
	}
}

/**
 *
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Object} record - the record to insert
 * @returns {Promise<boolean>}
 */
function insertRecord(env, hash_attribute, write_attributes, record) {
	let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);
	record[hash_attribute] = cast_hash_value;
	return env.dbis[hash_attribute].ifNoExists(cast_hash_value, () => {
		for (let x = 0; x < write_attributes.length; x++) {
			let attribute = write_attributes[x];

			//we do not process the write to the hash attribute as they are handled differently.  Also skip if the attribute does not exist on the object
			if (attribute === hash_attribute ||
				record.hasOwnProperty(attribute) === false
			) {
				continue;
			}

			let value = record[attribute];
			if (typeof value === 'function') {
				let value_results = value([[{}]]);
				if (Array.isArray(value_results)) {
					value = value_results[0][hdb_terms.FUNC_VAL];
					record[attribute] = value;
				}
			}

			value = hdb_utils.autoCast(value);
			value = value === undefined ? null : value;
			record[attribute] = value;
			if (value !== null && value !== undefined) {
				//LMDB has a 1978 byte limit for keys, but we try to retain plenty of padding so we don't have to calculate encoded byte length
				if (common.primitiveCheck(value)) {
					if (value.length > MAX_SEARCH_KEY_LENGTH) {
						value = value.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER;
					}
					env.dbis[attribute].put(value, cast_hash_value);
				}
			}
		}
		env.dbis[hash_attribute].put(cast_hash_value, record, record[UPDATED_TIME_ATTRIBUTE_NAME]);
	});
}

/**
 * removes skipped records
 * @param {[{}]}records
 * @param {[number]}remove_indices
 */
function removeSkippedRecords(records, remove_indices = []) {
	//remove the skipped entries from the records array
	let offset = 0;
	for (let x = 0; x < remove_indices.length; x++) {
		let index = remove_indices[x];
		records.splice(index - offset, 1);
		//the offset needs to increase for every index we remove
		offset++;
	}
}

/**
 * auto sets the createdtime & updatedtime stamps on a record
 * @param {Object} record
 * @param {Boolean} is_insert
 * @param {Boolean} generate_timestamps - defines if we should create timestamps for this record
 */
function setTimestamps(record, is_insert, generate_timestamps = true) {
	let timestamp = Date.now();

	if (generate_timestamps === true || !Number.isInteger(record[UPDATED_TIME_ATTRIBUTE_NAME])) {
		record[UPDATED_TIME_ATTRIBUTE_NAME] = timestamp;
	}

	if (is_insert === true) {
		if (generate_timestamps === true || !Number.isInteger(record[CREATED_TIME_ATTRIBUTE_NAME])) {
			record[CREATED_TIME_ATTRIBUTE_NAME] = timestamp;
		}
	} else {
		delete record[CREATED_TIME_ATTRIBUTE_NAME];
	}
}

/**
 * makes sure all needed dbis are opened / created & starts the transaction
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @returns {*}
 */
function initializeTransaction(env, hash_attribute, write_attributes) {
	//dbis must be opened / created before starting the transaction
	if (write_attributes.indexOf(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME) < 0) {
		write_attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
	}

	if (write_attributes.indexOf(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME) < 0) {
		write_attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
	}

	environment_util.initializeDBIs(env, hash_attribute, write_attributes);
}

/**
 * updates records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @param {boolean} generate_timestamps
 * @returns {Promise<UpdateRecordsResponseObject>}
 */
async function updateRecords(env, hash_attribute, write_attributes, records, generate_timestamps = true) {
	//validate
	validateWrite(env, hash_attribute, write_attributes, records);

	initializeTransaction(env, hash_attribute, write_attributes);

	let result = new UpdateRecordsResponseObject();

	//iterate update records
	let remove_indices = [];
	let puts = [];
	let keys = [];
	for (let index = 0; index < records.length; index++) {
		let record = records[index];
		setTimestamps(record, false, generate_timestamps);

		let cast_hash_value = hdb_utils.autoCast(record[hash_attribute]);

		let promise;
		try {
			promise = //env.dbis[hash_attribute].ifVersion(cast_hash_value, record[UPDATED_TIME_ATTRIBUTE_NAME], () => {
				updateUpsertRecord(env, hash_attribute, record, cast_hash_value, result);
			//}, { ifLessThan: true });
		} catch (e) {
			result.skipped_hashes.push(cast_hash_value);
			remove_indices.push(index);
			continue;
		}
		puts.push(promise);
		keys.push(cast_hash_value);
	}

	return await finalizeWrite(puts, keys, records, result, remove_indices);
}

/**
 * upserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @param {boolean} generate_timestamps
 * @returns {Promise<UpdateRecordsResponseObject>}
 */
async function upsertRecords(env, hash_attribute, write_attributes, records, generate_timestamps = true) {
	//validate
	try {
		validateWrite(env, hash_attribute, write_attributes, records);
	} catch (err) {
		throw handleHDBError(err, err.message, hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST);
	}

	try {
		initializeTransaction(env, hash_attribute, write_attributes);

		let result = new UpsertRecordsResponseObject();

		let puts = [];
		let keys = [];
		//iterate upsert records
		for (let index = 0; index < records.length; index++) {
			let record = records[index];
			let is_insert = false;
			let hash_value = undefined;
			let existing_record = undefined;
			if (hdb_utils.isEmpty(record[hash_attribute])) {
				hash_value = uuid.v4();
				record[hash_attribute] = hash_value;
				is_insert = true;
			} else {
				hash_value = hdb_utils.autoCast(record[hash_attribute]);
				//grab existing record
				existing_record = env.dbis[hash_attribute].get(hash_value);
			}

			let promise;
			//if the existing record doesn't exist we initialize it as an empty object & flag the record as an insert
			if (hdb_utils.isEmpty(existing_record)) {
				is_insert = true;
				setTimestamps(record, is_insert, generate_timestamps);
				promise = insertRecord(env, hash_attribute, write_attributes, record);
			} else {
				setTimestamps(record, is_insert, generate_timestamps);
				promise = //env.dbis[hash_attribute].ifVersion(hash_value, 1, () => {
					updateUpsertRecord(env, hash_attribute, record, hash_value, result);
				//});
			}

			puts.push(promise);
			keys.push(hash_value);
		}

		return await finalizeWrite(puts, keys, records, result);
	} catch (e) {
		throw e;
	}
}

async function finalizeWrite(puts, keys, records, result, remove_indices = []) {
	let put_results = await Promise.all(puts);
	for (let x = 0, length = put_results.length; x < length; x++) {
		if (put_results[x] === true) {
			result.written_hashes.push(keys[x]);
		} else {
			result.skipped_hashes.push(keys[x]);
			remove_indices.push(x);
		}
	}

	result.txn_time = common.getMicroTime();

	removeSkippedRecords(records, remove_indices);
	return result;
}

/**
 * central function used by updateRecords & upsertRecords to write a row to lmdb
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {{}} record - the record to process
 * @param {string|number} cast_hash_value - the hash attribute value cast to it's data type
 * @param {UpdateRecordsResponseObject|UpsertRecordsResponseObject} result
 */
function updateUpsertRecord(env, hash_attribute, record, cast_hash_value, result) {
	let existing_record = env.dbis[hash_attribute].get(cast_hash_value);
	if (
		Number.isInteger(record[UPDATED_TIME_ATTRIBUTE_NAME]) &&
		existing_record[UPDATED_TIME_ATTRIBUTE_NAME] > record[UPDATED_TIME_ATTRIBUTE_NAME]
	) {
		throw new Error('existing record is newer than updating record');
	}
	result.original_records.push(existing_record);

	//iterate the entries from the record
	for (let [key, value] of Object.entries(record)) {
		if (key === hash_attribute) {
			continue;
		}
		let dbi = env.dbis[key];
		if (dbi === undefined) {
			continue;
		}

		let existing_value = existing_record[key];

		//
		if (typeof value === 'function') {
			let value_results = value([[existing_record]]);
			if (Array.isArray(value_results)) {
				value = value_results[0][hdb_terms.FUNC_VAL];
				record[key] = value;
			}
		}
		value = hdb_utils.autoCast(value);
		value = value === undefined ? null : value;
		record[key] = value;
		existing_value = hdb_utils.autoCast(existing_value);
		if (value === existing_value) {
			continue;
		}

		//if the update cleared out the attribute value we need to delete it from the index
		if (existing_value !== null && existing_value !== undefined) {
			if (common.primitiveCheck(existing_value)) {
				if (existing_value.length > MAX_SEARCH_KEY_LENGTH) {
					existing_value = existing_value.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER;
				}
				dbi.remove(existing_value, cast_hash_value);
			}
		}

		if (value !== null && value !== undefined) {
			//LMDB has a 1978 byte limit for keys, but we try to retain plenty of padding so we don't have to calculate encoded byte length
			if (common.primitiveCheck(value)) {
				if (value.length > MAX_SEARCH_KEY_LENGTH) {
					value = value.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER;
				}
				dbi.put(value, cast_hash_value);
			}
		}
	}

	let merged_record = Object.assign({}, existing_record, record);
	// TODO: Don't return this promise once this is embedded in ifVersion
	return env.dbis[hash_attribute].put(cast_hash_value, merged_record, merged_record[UPDATED_TIME_ATTRIBUTE_NAME]);
}

/**
 * common validation function for env, hash_attribute & fetch_attributes
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 */
function validateBasic(env, hash_attribute, write_attributes) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	if (!Array.isArray(write_attributes)) {
		if (write_attributes === undefined) {
			throw new Error(LMDB_ERRORS.WRITE_ATTRIBUTES_REQUIRED);
		}

		throw new Error(LMDB_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY);
	}
}

/**
 * validates the parameters for LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 */
function validateWrite(env, hash_attribute, write_attributes, records) {
	validateBasic(env, hash_attribute, write_attributes);

	if (!Array.isArray(records)) {
		if (records === undefined) {
			throw new Error(LMDB_ERRORS.RECORDS_REQUIRED);
		}

		throw new Error(LMDB_ERRORS.RECORDS_MUST_BE_ARRAY);
	}
}

module.exports = {
	insertRecords,
	updateRecords,
	upsertRecords,
};
