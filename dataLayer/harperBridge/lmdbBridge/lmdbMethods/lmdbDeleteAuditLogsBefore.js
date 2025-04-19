'use strict';

const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const { getTransactionAuditStorePath } = require('../lmdbUtility/initializePaths.js');
// eslint-disable-next-line no-unused-vars
const DeleteBeforeObject = require('../../../DeleteBeforeObject.js');
const lmdbTerms = require('../../../../utility/lmdb/terms.js');
const hdbUtils = require('../../../../utility/common_utils.js');
const DeleteAuditLogsBeforeResults = require('./DeleteAuditLogsBeforeResults.js');
const promisify = require('util').promisify;
const pSettimeout = promisify(setTimeout);

const BATCH_SIZE = 10000;
const SLEEP_TIME_MS = 100;

module.exports = deleteAuditLogsBefore;

/**
 *
 * @param {DeleteBeforeObject} deleteAuditLogsObj
 */
async function deleteAuditLogsBefore(deleteAuditLogsObj) {
	let schemaPath = getTransactionAuditStorePath(deleteAuditLogsObj.schema, deleteAuditLogsObj.table);
	let env = await environmentUtility.openEnvironment(schemaPath, deleteAuditLogsObj.table, true);
	let allDbis = environmentUtility.listDBIs(env);
	environmentUtility.initializeDBIs(env, lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, allDbis);

	let chunkResults;
	let totalResults = new DeleteAuditLogsBeforeResults();

	do {
		chunkResults = await deleteTransactions(env, deleteAuditLogsObj.timestamp);
		if (totalResults.start_timestamp === undefined) {
			totalResults.start_timestamp = chunkResults.start_timestamp;
		}

		if (chunkResults.end_timestamp !== undefined) {
			totalResults.end_timestamp = chunkResults.end_timestamp;
		}

		totalResults.transactions_deleted += chunkResults.transactions_deleted;

		//we do a pause on delete so it opens access to the txn environment for other processes.
		await pSettimeout(SLEEP_TIME_MS);
	} while (chunkResults.transactions_deleted > 0);

	return totalResults;
}

/**
 *
 * @param env
 * @param {number} timestamp
 * @returns {Promise<DeleteAuditLogsBeforeResults>}
 */
async function deleteTransactions(env, timestamp) {
	let results = new DeleteAuditLogsBeforeResults();
	try {
		let timestampDbi = env.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP];

		let promise;
		for (let { key, value: txnRecord } of timestampDbi.getRange({ start: false })) {
			if (key >= timestamp) {
				break;
			}

			if (results.start_timestamp === undefined) {
				results.start_timestamp = key;
			}

			//delete the transaction record
			promise = timestampDbi.remove(key);

			//delete user index entry
			let userName = txnRecord[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME];
			if (!hdbUtils.isEmpty(userName)) {
				promise = env.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].remove(userName, key);
			}

			//delete each hash value entry
			for (let k = 0; k < txnRecord.hash_values.length; k++) {
				promise = env.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE].remove(txnRecord.hash_values[k], key);
			}

			results.transactions_deleted++;
			results.end_timestamp = key;
			if (results.transactions_deleted > BATCH_SIZE) {
				break;
			}
		}
		// we wait for the last promise to finish
		await promise;

		return results;
	} catch (e) {
		throw e;
	}
}
