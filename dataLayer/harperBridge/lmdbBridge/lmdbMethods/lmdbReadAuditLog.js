'use strict';

const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const lmdbTerms = require('../../../../utility/lmdb/terms.js');
const lmdbUtils = require('../../../../utility/lmdb/commonUtility.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const hdbUtils = require('../../../../utility/common_utils.js');
const { getTransactionAuditStorePath } = require('../lmdbUtility/initializePaths.js');
const searchUtility = require('../../../../utility/lmdb/searchUtility.js');
const LMDBTransactionObject = require('../lmdbUtility/LMDBTransactionObject.js');
const log = require('../../../../utility/logging/harper_logger.js');

module.exports = readAuditLog;

/**
 * function execute the readTransactionLog operation
 * @param {ReadAuditLogObject} readAuditLogObj
 * @returns {Promise<[]>}
 */
async function readAuditLog(readAuditLogObj) {
	let basePath = getTransactionAuditStorePath(readAuditLogObj.schema, readAuditLogObj.table);
	let env = await environmentUtility.openEnvironment(basePath, readAuditLogObj.table, true);
	let allDbis = environmentUtility.listDBIs(env);

	environmentUtility.initializeDBIs(env, lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, allDbis);
	let hash_attribute;
	switch (readAuditLogObj.search_type) {
		case hdbTerms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM.TIMESTAMP:
			return searchTransactionsByTimestamp(env, readAuditLogObj.search_values);
		case hdbTerms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM.HASH_VALUE:
			//get the hash attribute
			hash_attribute = global.hdb_schema[readAuditLogObj.schema][readAuditLogObj.table].hash_attribute;
			return searchTransactionsByHashValues(env, readAuditLogObj.search_values, hash_attribute);
		case hdbTerms.READ_AUDIT_LOG_SEARCH_TYPES_ENUM.USERNAME:
			return searchTransactionsByUsername(env, readAuditLogObj.search_values);
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
	if (hdbUtils.isEmpty(timestamps[0])) {
		timestamps[0] = 0;
	}

	if (hdbUtils.isEmpty(timestamps[1])) {
		timestamps[1] = Date.now();
	}

	let timestampDbi = env.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP];

	//advance the endValue by 1 key
	let nextValue;
	for (let key of timestampDbi.getKeys({ start: timestamps[1] })) {
		if (key !== timestamps[1]) {
			nextValue = key;
			break;
		}
	}

	return timestampDbi
		.getRange({ start: timestamps[0], end: nextValue })
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
		for (let value of env.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].getValues(username)) {
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
	let timestampHashMap = new Map();
	for (let x = 0, length = hash_values.length; x < length; x++) {
		let hashValue = hash_values[x];
		let hashResults = searchUtility.equals(
			env,
			lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP,
			lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE,
			hashValue
		);

		for (let { value } of hashResults) {
			let numberKey = Number(value);
			if (timestampHashMap.has(numberKey)) {
				let entry = timestampHashMap.get(numberKey);
				entry.push(hashValue.toString());
			} else {
				timestampHashMap.set(numberKey, [hashValue.toString()]);
			}
		}
	}
	let ids = Array.from(timestampHashMap.keys());
	let txns = batchSearchTransactions(env, ids);

	let resultsMap = new Map();
	//iterate txns & pull out just the records related to the hash
	for (let x = 0; x < txns.length; x++) {
		let transaction = txns[x];
		let timestamp = transaction.timestamp;
		let hashes = timestampHashMap.get(timestamp);

		loopRecords(transaction, 'records', hash_attribute, hashes, resultsMap);

		loopRecords(transaction, 'original_records', hash_attribute, hashes, resultsMap);
	}

	return Object.fromEntries(resultsMap);
}

/**
 *
 * @param transaction
 * @param recordsAttribute
 * @param hash_attribute
 * @param hashes
 * @param resultsMap
 */
function loopRecords(transaction, recordsAttribute, hash_attribute, hashes, resultsMap) {
	let timestamp = transaction.timestamp;

	if (transaction[recordsAttribute]) {
		for (let y = 0; y < transaction[recordsAttribute].length; y++) {
			let record = transaction[recordsAttribute][y];
			let hashValue = record[hash_attribute].toString();
			if (hashes.indexOf(hashValue) >= 0) {
				if (resultsMap.has(hashValue)) {
					let txnObjects = resultsMap.get(hashValue);
					let txnObject = txnObjects[txnObjects.length - 1];

					if (txnObject.timestamp === timestamp) {
						txnObject[recordsAttribute] = [record];
					} else {
						let newTxnObject = new LMDBTransactionObject(
							transaction.operation,
							transaction.user_name,
							timestamp,
							undefined
						);
						newTxnObject[recordsAttribute] = [record];
						txnObjects.push(newTxnObject);
					}
				} else {
					let txnObject = new LMDBTransactionObject(transaction.operation, transaction.user_name, timestamp, undefined);
					txnObject[recordsAttribute] = [record];
					resultsMap.set(hashValue, [txnObject]);
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
		let timestampDbi = env.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP];
		for (let x = 0; x < ids.length; x++) {
			try {
				let value = timestampDbi.get(ids[x]);
				if (value) {
					let txnRecord = Object.assign(new LMDBTransactionObject(), value);
					results.push(txnRecord);
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
