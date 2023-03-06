'use strict';

const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const { getTransactionAuditStorePath } = require('../lmdbUtility/initializePaths');
// eslint-disable-next-line no-unused-vars
const DeleteBeforeObject = require('../../../DeleteBeforeObject');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const hdb_utils = require('../../../../utility/common_utils');
const DeleteAuditLogsBeforeResults = require('./DeleteAuditLogsBeforeResults');
const promisify = require('util').promisify;
const p_settimeout = promisify(setTimeout);

const BATCH_SIZE = 10000;
const SLEEP_TIME_MS = 100;

module.exports = deleteAuditLogsBefore;

/**
 *
 * @param {DeleteBeforeObject} delete_audit_logs_obj
 */
async function deleteAuditLogsBefore(delete_audit_logs_obj) {
	let schema_path = getTransactionAuditStorePath(delete_audit_logs_obj.schema, delete_audit_logs_obj.table);
	let env = await environment_utility.openEnvironment(schema_path, delete_audit_logs_obj.table, true);
	let all_dbis = environment_utility.listDBIs(env);
	environment_utility.initializeDBIs(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, all_dbis);

	let chunk_results;
	let total_results = new DeleteAuditLogsBeforeResults();

	do {
		chunk_results = await deleteTransactions(env, delete_audit_logs_obj.timestamp);
		if (total_results.start_timestamp === undefined) {
			total_results.start_timestamp = chunk_results.start_timestamp;
		}

		if (chunk_results.end_timestamp !== undefined) {
			total_results.end_timestamp = chunk_results.end_timestamp;
		}

		total_results.transactions_deleted += chunk_results.transactions_deleted;

		//we do a pause on delete so it opens access to the txn environment for other processes.
		await p_settimeout(SLEEP_TIME_MS);
	} while (chunk_results.transactions_deleted > 0);

	return total_results;
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
		let timestamp_dbi = env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP];

		let promise;
		for (let { key, value: txn_record } of timestamp_dbi.getRange({ start: false })) {
			if (key >= timestamp) {
				break;
			}

			if (results.start_timestamp === undefined) {
				results.start_timestamp = key;
			}

			//delete the transaction record
			promise = timestamp_dbi.remove(key);

			//delete user index entry
			let user_name = txn_record[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME];
			if (!hdb_utils.isEmpty(user_name)) {
				promise = env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].remove(user_name, key);
			}

			//delete each hash value entry
			for (let k = 0; k < txn_record.hash_values.length; k++) {
				promise = env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE].remove(txn_record.hash_values[k], key);
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
