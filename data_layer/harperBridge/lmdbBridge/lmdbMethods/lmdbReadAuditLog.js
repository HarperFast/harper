'use strict';

const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_utils = require('../../../../utility/lmdb/commonUtility');
const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const { getTransactionAuditStorePath } = require('../lmdbUtility/initializePaths');
const search_utility = require('../../../../utility/lmdb/searchUtility');
const LMDBTransactionObject = require('../lmdbUtility/LMDBTransactionObject');
const log = require('../../../../utility/logging/harper_logger');

module.exports = readAuditLog;

/**
 * function execute the read_transaction_log operation
 * @param {ReadAuditLogObject} read_audit_log_obj
 * @returns {Promise<[]>}
 */
async function readAuditLog(read_audit_log_obj) {
	let base_path = getTransactionAuditStorePath(read_audit_log_obj.schema, read_audit_log_obj.table);
	let env = await environment_utility.openEnvironment(base_path, read_audit_log_obj.table, true);
	let all_dbis = environment_utility.listDBIs(env);

	environment_utility.initializeDBIs(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, all_dbis);
	let hash_attribute;
	switch (read_audit_log_obj.search_type) {
		case hdb_terms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM.TIMESTAMP:
			return searchTransactionsByTimestamp(env, read_audit_log_obj.search_values);
		case hdb_terms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM.HASH_VALUE:
			//get the hash attribute
			hash_attribute = global.hdb_schema[read_audit_log_obj.schema][read_audit_log_obj.table].hash_attribute;
			return searchTransactionsByHashValues(env, read_audit_log_obj.search_values, hash_attribute);
		case hdb_terms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM.USERNAME:
			return searchTransactionsByUsername(env, read_audit_log_obj.search_values);
		default:
			return searchTransactionsByTimestamp(env);
	}
}

/**
 *
 * @param {lmdb.RootDatabase} env
 * @param {[number]} timestamps - this must be undefined or a 1 or 2 element numeric array, representing a start timestamp & end end timestamp (element 1 must be less than element 2).
 * If undefined or empty array is passed the function will iterate the entire transaction log.
 * If only 1 element is supplied the second will be set to now UTC and the transaction log will be traversed from the designated start time until now.
 * If 2 elements are supplied the transaction log will be read between the two timestamps
 */
function searchTransactionsByTimestamp(env, timestamps = [0, Date.now()]) {
	if (hdb_utils.isEmpty(timestamps[0])) {
		timestamps[0] = 0;
	}

	if (hdb_utils.isEmpty(timestamps[1])) {
		timestamps[1] = Date.now();
	}

	let timestamp_dbi = env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP];

	//advance the end_value by 1 key
	let next_value;
	for (let key of timestamp_dbi.getKeys({ start: timestamps[1] })) {
		if (key !== timestamps[1]) {
			next_value = key;
			break;
		}
	}

	return timestamp_dbi
		.getRange({ start: timestamps[0], end: next_value })
		.map(({ value }) => Object.assign(new LMDBTransactionObject(), value));
}

/**
 *
 * @param {lmdb.RootDatabase} env
 * @param {[string]} usernames
 */
function searchTransactionsByUsername(env, usernames = []) {
	let results = new Map();
	for (let x = 0; x < usernames.length; x++) {
		let username = usernames[x];

		let ids = [];
		for (let value of env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].getValues(username)) {
			ids.push(value);
		}

		results.set(username, batchSearchTransactions(env, ids));
	}

	return Object.fromEntries(results);
}

/**
 *
 * @param {lmdb.RootDatabase} env
 * @param {[string]} hash_values
 * @param {string} hash_attribute
 */
function searchTransactionsByHashValues(env, hash_values, hash_attribute) {
	let timestamp_hash_map = new Map();
	for (let x = 0, length = hash_values.length; x < length; x++) {
		let hash_value = hash_values[x];
		let hash_results = search_utility.equals(
			env,
			lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP,
			lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE,
			hash_value
		);

		for (let { value } of hash_results) {
			let number_key = Number(value);
			if (timestamp_hash_map.has(number_key)) {
				let entry = timestamp_hash_map.get(number_key);
				entry.push(hash_value.toString());
			} else {
				timestamp_hash_map.set(number_key, [hash_value.toString()]);
			}
		}
	}
	let ids = Array.from(timestamp_hash_map.keys());
	let txns = batchSearchTransactions(env, ids);

	let results_map = new Map();
	//iterate txns & pull out just the records related to the hash
	for (let x = 0; x < txns.length; x++) {
		let transaction = txns[x];
		let timestamp = transaction.timestamp;
		let hashes = timestamp_hash_map.get(timestamp);

		loopRecords(transaction, 'records', hash_attribute, hashes, results_map);

		loopRecords(transaction, 'original_records', hash_attribute, hashes, results_map);
	}

	return Object.fromEntries(results_map);
}

/**
 *
 * @param transaction
 * @param records_attribute
 * @param hash_attribute
 * @param hashes
 * @param results_map
 */
function loopRecords(transaction, records_attribute, hash_attribute, hashes, results_map) {
	let timestamp = transaction.timestamp;

	if (transaction[records_attribute]) {
		for (let y = 0; y < transaction[records_attribute].length; y++) {
			let record = transaction[records_attribute][y];
			let hash_value = record[hash_attribute].toString();
			if (hashes.indexOf(hash_value) >= 0) {
				if (results_map.has(hash_value)) {
					let txn_objects = results_map.get(hash_value);
					let txn_object = txn_objects[txn_objects.length - 1];

					if (txn_object.timestamp === timestamp) {
						txn_object[records_attribute] = [record];
					} else {
						let new_txn_object = new LMDBTransactionObject(
							transaction.operation,
							transaction.user_name,
							timestamp,
							undefined
						);
						new_txn_object[records_attribute] = [record];
						txn_objects.push(new_txn_object);
					}
				} else {
					let txn_object = new LMDBTransactionObject(
						transaction.operation,
						transaction.user_name,
						timestamp,
						undefined
					);
					txn_object[records_attribute] = [record];
					results_map.set(hash_value, [txn_object]);
				}
			}
		}
	}
}

/**
 *
 * @param env
 * @param ids
 * @returns {[LMDBTransactionObject]}
 */
function batchSearchTransactions(env, ids) {
	let results = [];
	try {
		//this sorts the ids numerically asc
		let timestamp_dbi = env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP];
		for (let x = 0; x < ids.length; x++) {
			try {
				let value = timestamp_dbi.get(ids[x]);
				if (value) {
					let txn_record = Object.assign(new LMDBTransactionObject(), value);
					results.push(txn_record);
				}
			} catch (e) {
				log.warn(e);
			}
		}
		return results;
	} catch (e) {
		throw e;
	}
}
