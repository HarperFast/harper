'use strict';

const environmentUtil = require('./environmentUtility.js');
const InsertRecordsResponseObject = require('./InsertRecordsResponseObject.js');
const UpdateRecordsResponseObject = require('./UpdateRecordsResponseObject.js');
const UpsertRecordsResponseObject = require('./UpsertRecordsResponseObject.js');
const common = require('./commonUtility.js');
const LMDB_ERRORS = require('../errors/commonErrors.js').LMDB_ERRORS_ENUM;
const lmdbTerms = require('./terms.js');
const hdbTerms = require('../hdbTerms.ts');
const hdbUtils = require('../common_utils.js');
const uuid = require('uuid');
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdbTerms;
const envMngr = require('../environment/environmentManager.js');
envMngr.initSync();

const LMDB_PREFETCH_WRITES = envMngr.get(hdbTerms.CONFIG_PARAMS.STORAGE_PREFETCHWRITES);

const CREATED_TIME_ATTRIBUTE_NAME = hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME;
const UPDATED_TIME_ATTRIBUTE_NAME = hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME;

/**
 * inserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 * @param {boolean|number} timestamp
 * @returns {Promise<InsertRecordsResponseObject>}
 */
async function insertRecords(env, hash_attribute, writeAttributes, records, timestamp = common.getNextMonotonicTime()) {
	validateWrite(env, hash_attribute, writeAttributes, records);

	initializeTransaction(env, hash_attribute, writeAttributes);

	let result = new InsertRecordsResponseObject();

	let puts = [];
	let keys = [];
	for (let index = 0; index < records.length; index++) {
		let record = records[index];
		setTimestamps(record, true, timestamp);

		let promise = insertRecord(env, hash_attribute, writeAttributes, record);
		let hashValue = record[hash_attribute];
		puts.push(promise);
		keys.push(hashValue);
	}

	return finalizeWrite(puts, keys, records, result, timestamp);
}

/**
 *
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 * @param  {Object} record - the record to insert
 * @returns {Promise<boolean>}
 */
function insertRecord(env, hash_attribute, writeAttributes, record) {
	let hashValue = record[hash_attribute];
	return env.dbis[hash_attribute].ifNoExists(hashValue, () => {
		for (let x = 0; x < writeAttributes.length; x++) {
			let attribute = writeAttributes[x];

			//we do not process the write to the hash attribute as they are handled differently.  Also skip if the attribute does not exist on the object
			if (attribute === hash_attribute || record.hasOwnProperty(attribute) === false) {
				continue;
			}

			let value = record[attribute];
			if (typeof value === 'function') {
				let valueResults = value([[{}]]);
				if (Array.isArray(valueResults)) {
					value = valueResults[0][hdbTerms.FUNC_VAL];
					record[attribute] = value;
				}
			}

			let values = common.getIndexedValues(value);
			let dbi = env.dbis[attribute];
			if (values) {
				if (LMDB_PREFETCH_WRITES)
					dbi.prefetch(
						values.map((v) => ({ key: v, value: hashValue })),
						noop
					);
				for (let i = 0, l = values.length; i < l; i++) {
					dbi.put(values[i], hashValue);
				}
			}
		}
		if (LMDB_PREFETCH_WRITES) env.dbis[hash_attribute].prefetch([hashValue], noop);
		env.dbis[hash_attribute].put(hashValue, record, record[UPDATED_TIME_ATTRIBUTE_NAME]);
	});
}

/**
 * removes skipped records
 * @param {[{}]}records
 * @param {[number]}removeIndices
 */
function removeSkippedRecords(records, removeIndices = []) {
	//remove the skipped entries from the records array
	let offset = 0;
	for (let x = 0; x < removeIndices.length; x++) {
		let index = removeIndices[x];
		records.splice(index - offset, 1);
		//the offset needs to increase for every index we remove
		offset++;
	}
}

/**
 * auto sets the createdtime & updatedtime stamps on a record
 * @param {Object} record
 * @param {Boolean} isInsert
 * @param {number} timestamp - timestamp for this record (if omitted, don't set)
 */
function setTimestamps(record, isInsert, timestamp) {
	let generateTimestamp = timestamp > 0;
	if (generateTimestamp || !Number.isInteger(record[UPDATED_TIME_ATTRIBUTE_NAME])) {
		record[UPDATED_TIME_ATTRIBUTE_NAME] = timestamp || (timestamp = common.getNextMonotonicTime());
	}

	if (isInsert === true) {
		if (generateTimestamp || !Number.isInteger(record[CREATED_TIME_ATTRIBUTE_NAME])) {
			record[CREATED_TIME_ATTRIBUTE_NAME] = timestamp || common.getNextMonotonicTime();
		}
	} else {
		delete record[CREATED_TIME_ATTRIBUTE_NAME];
	}
}

/**
 * makes sure all needed dbis are opened / created & starts the transaction
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 * @returns {*}
 */
function initializeTransaction(env, hash_attribute, writeAttributes) {
	//dbis must be opened / created before starting the transaction
	if (writeAttributes.indexOf(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME) < 0) {
		writeAttributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
	}

	if (writeAttributes.indexOf(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME) < 0) {
		writeAttributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
	}

	environmentUtil.initializeDBIs(env, hash_attribute, writeAttributes);
}

/**
 * updates records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @param {boolean|number} timestamp
 * @returns {Promise<UpdateRecordsResponseObject>}
 */
async function updateRecords(env, hash_attribute, writeAttributes, records, timestamp = common.getNextMonotonicTime()) {
	//validate
	validateWrite(env, hash_attribute, writeAttributes, records);

	initializeTransaction(env, hash_attribute, writeAttributes);

	let result = new UpdateRecordsResponseObject();

	//iterate update records
	let removeIndices = [];
	let puts = [];
	let keys = [];
	for (let index = 0; index < records.length; index++) {
		let record = records[index];
		let hashValue = record[hash_attribute];

		let promise;
		try {
			promise = updateUpsertRecord(env, hash_attribute, record, hashValue, result, true, timestamp);
		} catch (e) {
			result.skipped_hashes.push(hashValue);
			removeIndices.push(index);
			continue;
		}
		puts.push(promise);
		keys.push(hashValue);
	}

	return finalizeWrite(puts, keys, records, result, timestamp, removeIndices);
}

/**
 * upserts records into LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to update
 * @param {boolean|number} timestamp
 * @returns {Promise<UpdateRecordsResponseObject>}
 */
async function upsertRecords(env, hash_attribute, writeAttributes, records, timestamp = common.getNextMonotonicTime()) {
	//validate
	try {
		validateWrite(env, hash_attribute, writeAttributes, records);
	} catch (err) {
		throw handleHDBError(err, err.message, hdbErrors.HTTP_STATUS_CODES.BAD_REQUEST);
	}

	initializeTransaction(env, hash_attribute, writeAttributes);

	let result = new UpsertRecordsResponseObject();

	let puts = [];
	let keys = [];
	//iterate upsert records
	for (let index = 0; index < records.length; index++) {
		let record = records[index];
		let hashValue = undefined;
		if (hdbUtils.isEmpty(record[hash_attribute])) {
			hashValue = uuid.v4();
			record[hash_attribute] = hashValue;
		} else {
			hashValue = record[hash_attribute];
		}

		// do an upsert without requiring the record to previously existed
		let promise = updateUpsertRecord(env, hash_attribute, record, hashValue, result, false, timestamp);
		puts.push(promise);
		keys.push(hashValue);
	}

	return finalizeWrite(puts, keys, records, result, timestamp);
}

async function finalizeWrite(puts, keys, records, result, timestamp, removeIndices = []) {
	let putResults = await Promise.all(puts);
	for (let x = 0, length = putResults.length; x < length; x++) {
		if (putResults[x] === true) {
			result.written_hashes.push(keys[x]);
		} else {
			result.skipped_hashes.push(keys[x]);
			removeIndices.push(x);
		}
	}

	result.txn_time = timestamp || common.getNextMonotonicTime();

	removeSkippedRecords(records, removeIndices);
	return result;
}

/**
 * central function used by updateRecords & upsertRecords to write a row to lmdb
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {{}} record - the record to process
 * @param {string|number} hashValue - the hash attribute value
 * @param {UpdateRecordsResponseObject|UpsertRecordsResponseObject} result
 * @param {boolean} Require existing record
 * @param {number} timestamp
 */
function updateUpsertRecord(env, hash_attribute, record, hashValue, result, mustExist = false, timestamp) {
	let primaryDbi = env.dbis[hash_attribute];
	let existingEntry = primaryDbi.getEntry(hashValue);
	let existingRecord = existingEntry?.value;
	let hadExisting = existingRecord;
	if (!existingRecord) {
		if (mustExist) return false;
		existingRecord = {};
	}
	setTimestamps(record, !hadExisting, timestamp);
	if (
		Number.isInteger(record[UPDATED_TIME_ATTRIBUTE_NAME]) &&
		existingRecord[UPDATED_TIME_ATTRIBUTE_NAME] > record[UPDATED_TIME_ATTRIBUTE_NAME]
	) {
		// This is not an error condition in our world of last-record-wins
		// replication. If the existing record is newer than it just means the provided record
		// is, well... older. And newer records are supposed to "win" over older records, and that
		// is normal, non-error behavior.
		return false;
	}
	if (hadExisting) result.original_records.push(existingRecord);
	let completion;
	const doPut = () => {
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

			let existingValue = existingRecord[key];

			if (typeof value === 'function') {
				let valueResults = value([[existingRecord]]);
				if (Array.isArray(valueResults)) {
					value = valueResults[0][hdbTerms.FUNC_VAL];
					record[key] = value;
				}
			}
			if (value === existingValue) {
				continue;
			}

			//if the update cleared out the attribute value we need to delete it from the index
			let values = common.getIndexedValues(existingValue);
			if (values) {
				if (LMDB_PREFETCH_WRITES)
					dbi.prefetch(
						values.map((v) => ({ key: v, value: hashValue })),
						noop
					);
				for (let i = 0, l = values.length; i < l; i++) {
					dbi.remove(values[i], hashValue);
				}
			}
			values = common.getIndexedValues(value);
			if (values) {
				if (LMDB_PREFETCH_WRITES)
					dbi.prefetch(
						values.map((v) => ({ key: v, value: hashValue })),
						noop
					);
				for (let i = 0, l = values.length; i < l; i++) {
					dbi.put(values[i], hashValue);
				}
			}
		}
		// there is no point in prefetching the main record since it was already retrieved for the merge
		let mergedRecord = { ...existingRecord, ...record };
		primaryDbi.put(hashValue, mergedRecord, mergedRecord[UPDATED_TIME_ATTRIBUTE_NAME]);
	};
	// use optimistic locking to only commit if the existing record state still holds true.
	// this is superior to using an async transaction since it doesn't require JS execution
	// during the write transaction.
	if (existingEntry) completion = primaryDbi.ifVersion(hashValue, existingEntry.version, doPut);
	else completion = primaryDbi.ifNoExists(hashValue, doPut);
	return completion.then((success) => {
		if (!success) {
			// try again
			return updateUpsertRecord(env, hash_attribute, record, hashValue, result, mustExist, timestamp);
		}
		return true;
	});
}

/**
 * common validation function for env, hash_attribute & fetchAttributes
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 */
function validateBasic(env, hash_attribute, writeAttributes) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	if (!Array.isArray(writeAttributes)) {
		if (writeAttributes === undefined) {
			throw new Error(LMDB_ERRORS.WRITE_ATTRIBUTES_REQUIRED);
		}

		throw new Error(LMDB_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY);
	}
}

/**
 * validates the parameters for LMDB
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 * @param  {Array.<Object>} records - object array records to insert
 */
function validateWrite(env, hash_attribute, writeAttributes, records) {
	validateBasic(env, hash_attribute, writeAttributes);

	if (!Array.isArray(records)) {
		if (records === undefined) {
			throw new Error(LMDB_ERRORS.RECORDS_REQUIRED);
		}

		throw new Error(LMDB_ERRORS.RECORDS_MUST_BE_ARRAY);
	}
}

function noop() {
	// prefetch callback
}

module.exports = {
	insertRecords,
	updateRecords,
	upsertRecords,
};
