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

	initializeTransaction(env, hash_attribute, write_attributes);

	let result = new InsertRecordsResponseObject();

	let puts = [];
	let keys = [];
	for (let index = 0; index < records.length; index++) {
		let record = records[index];
		setTimestamps(record, true, generate_timestamps);

		let promise = insertRecord(env, hash_attribute, write_attributes, record);
		let hash_value = record[hash_attribute];
		puts.push(promise);
		keys.push(hash_value);
	}

	return finalizeWrite(puts, keys, records, result);
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
	let hash_value = record[hash_attribute];
	return env.dbis[hash_attribute].ifNoExists(hash_value, () => {
		for (let x = 0; x < write_attributes.length; x++) {
			let attribute = write_attributes[x];

			//we do not process the write to the hash attribute as they are handled differently.  Also skip if the attribute does not exist on the object
			if (attribute === hash_attribute || record.hasOwnProperty(attribute) === false) {
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

			let values = common.getIndexedValues(value);
			if (values) {
				for (let i = 0, l = values.length; i < l; i++) {
					env.dbis[attribute].put(values[i], hash_value);
				}
			}
		}
		env.dbis[hash_attribute].put(hash_value, record, record[UPDATED_TIME_ATTRIBUTE_NAME]);
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
		let hash_value = record[hash_attribute];

		let promise;
		try {
			promise = updateUpsertRecord(env, hash_attribute, record, hash_value, result, true, generate_timestamps);
		} catch (e) {
			result.skipped_hashes.push(hash_value);
			remove_indices.push(index);
			continue;
		}
		puts.push(promise);
		keys.push(hash_value);
	}

	return finalizeWrite(puts, keys, records, result, remove_indices);
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

	initializeTransaction(env, hash_attribute, write_attributes);

	let result = new UpsertRecordsResponseObject();

	let puts = [];
	let keys = [];
	//iterate upsert records
	for (let index = 0; index < records.length; index++) {
		let record = records[index];
		let hash_value = undefined;
		if (hdb_utils.isEmpty(record[hash_attribute])) {
			hash_value = uuid.v4();
			record[hash_attribute] = hash_value;
		} else {
			hash_value = record[hash_attribute];
		}

		// do an upsert without requiring the record to previously existed
		let promise = updateUpsertRecord(env, hash_attribute, record, hash_value, result, false, generate_timestamps);
		puts.push(promise);
		keys.push(hash_value);
	}

	return finalizeWrite(puts, keys, records, result);
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
 * @param {string|number} hash_value - the hash attribute value
 * @param {UpdateRecordsResponseObject|UpsertRecordsResponseObject} result
 * @param {boolean} Require existing record
 * @param {boolean} Generate timestamps
 */
function updateUpsertRecord(
	env,
	hash_attribute,
	record,
	hash_value,
	result,
	must_exist = false,
	generate_timestamps = true
) {
	let primary_dbi = env.dbis[hash_attribute];
	// we prefetch the value to ensure we don't have any page faults inside the write transaction
	return primary_dbi.prefetch(hash_value).then(() =>
		primary_dbi.transaction(() => {
			let existing_record = primary_dbi.get(hash_value);
			let had_existing = existing_record;
			if (!existing_record) {
				if (must_exist) return false;
				existing_record = {};
			}
			setTimestamps(record, !had_existing, generate_timestamps);
			if (
				Number.isInteger(record[UPDATED_TIME_ATTRIBUTE_NAME]) &&
				existing_record[UPDATED_TIME_ATTRIBUTE_NAME] > record[UPDATED_TIME_ATTRIBUTE_NAME]
			) {
				// This is not an error condition in our world of last-record-wins
				// replication. If the existing record is newer than it just means the provided record
				// is, well... older. And newer records are supposed to "win" over older records, and that
				// is normal, non-error behavior.
				return false;
			}
			if (had_existing) result.original_records.push(existing_record);

			// iterate the entries from the record
			// for-in is about 5x as fast as for-of Object.entries, and this is extremely time sensitive since it is
			// inside a write transaction
			for (let key in record) {
				if (!record.hasOwnProperty(key) || key === hash_attribute) {
					continue;
				}
				let value = record[key];
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
				if (value === existing_value) {
					continue;
				}

				//if the update cleared out the attribute value we need to delete it from the index
				let values = common.getIndexedValues(existing_value);
				if (values) {
					for (let i = 0, l = values.length; i < l; i++) {
						dbi.remove(values[i], hash_value);
					}
				}
				values = common.getIndexedValues(value);
				if (values) {
					for (let i = 0, l = values.length; i < l; i++) {
						dbi.put(values[i], hash_value);
					}
				}
			}

			let merged_record = Object.assign({}, existing_record, record);
			primary_dbi.put(hash_value, merged_record, merged_record[UPDATED_TIME_ATTRIBUTE_NAME]);
			return true;
		})
	);
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
