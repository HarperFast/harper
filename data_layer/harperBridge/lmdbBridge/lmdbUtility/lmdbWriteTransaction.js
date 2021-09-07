'use strict';

const path = require('path');
const environment_util = require('../../../../utility/lmdb/environmentUtility');
const LMDBInsertTransactionObject = require('./LMDBInsertTransactionObject');
const LMDBUpdateTransactionObject = require('./LMDBUpdateTransactionObject');
const LMDBUpsertTransactionObject = require('./LMDBUpsertTransactionObject');
const LMDBDeleteTransactionObject = require('./LMDBDeleteTransactionObject');

const lmdb_terms = require('../../../../utility/lmdb/terms');
const hdb_util = require('../../../../utility/common_utils');
const { HDB_SETTINGS_NAMES } = require('../../../../utility/hdbTerms');
const env_mngr = require('../../../../utility/environment/environmentManager');
if (!env_mngr.isInitialized()) {
	env_mngr.initSync();
}

const DISABLE_TRANSACTION_LOG = getDisableTxnLogSetting();

const OPERATIONS_ENUM = require('../../../../utility/hdbTerms').OPERATIONS_ENUM;
const { getTransactionStorePath } = require('./initializePaths');

module.exports = writeTransaction;

/**
 *
 * @param {InsertObject|UpdateObject|DeleteObject|UpsertObject} hdb_operation
 * @param {InsertRecordsResponseObject | UpdateRecordsResponseObject | UpdateRecordsResponseObject | DeleteRecordsResponseObject} lmdb_response
 * @returns {Promise<void>}
 */
async function writeTransaction(hdb_operation, lmdb_response) {
	if (DISABLE_TRANSACTION_LOG === true) {
		return;
	}

	let txn_env_base_path = path.join(getTransactionStorePath(), hdb_operation.schema.toString());
	let txn_env = await environment_util.openEnvironment(txn_env_base_path, hdb_operation.table, true);

	let txn_object = createTransactionObject(hdb_operation, lmdb_response);

	if (txn_object === undefined || txn_object.hash_values.length === 0) {
		return;
	}

	if (txn_env !== undefined) {
		environment_util.initializeDBIs(
			txn_env,
			lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP,
			lmdb_terms.TRANSACTIONS_DBIS
		);

		try {
			let txn_timestamp = txn_object.timestamp;
			return await txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].ifNoExists(txn_timestamp, () => {
				txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].put(txn_timestamp, txn_object);
				if (!hdb_util.isEmpty(txn_object.user_name)) {
					txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].put(txn_object.user_name, txn_timestamp);
				}
				for (let x = 0; x < txn_object.hash_values.length; x++) {
					txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE].put(txn_object.hash_values[x], txn_timestamp);
				}
			});
		} catch (e) {
			throw e;
		}
	}
}

/**
 *
 * @param {InsertObject | UpdateObject | DeleteObject} hdb_operation
 * @param {InsertRecordsResponseObject | UpdateRecordsResponseObject | DeleteRecordsResponseObject} lmdb_response
 * @returns {LMDBInsertTransactionObject|LMDBUpdateTransactionObject|LMDBDeleteTransactionObject}
 */
function createTransactionObject(hdb_operation, lmdb_response) {
	let username = !hdb_util.isEmpty(hdb_operation.hdb_user) ? hdb_operation.hdb_user.username : undefined;
	if (hdb_operation.operation === OPERATIONS_ENUM.INSERT) {
		return new LMDBInsertTransactionObject(
			hdb_operation.records,
			username,
			lmdb_response.txn_time,
			lmdb_response.written_hashes,
			hdb_operation.__origin
		);
	}

	if (hdb_operation.operation === OPERATIONS_ENUM.UPDATE) {
		return new LMDBUpdateTransactionObject(
			hdb_operation.records,
			lmdb_response.original_records,
			username,
			lmdb_response.txn_time,
			lmdb_response.written_hashes,
			hdb_operation.__origin
		);
	}

	if (hdb_operation.operation === OPERATIONS_ENUM.UPSERT) {
		return new LMDBUpsertTransactionObject(
			hdb_operation.records,
			lmdb_response.original_records,
			username,
			lmdb_response.txn_time,
			lmdb_response.written_hashes,
			hdb_operation.__origin
		);
	}

	if (hdb_operation.operation === OPERATIONS_ENUM.DELETE) {
		return new LMDBDeleteTransactionObject(
			lmdb_response.deleted,
			lmdb_response.original_records,
			username,
			lmdb_response.txn_time,
			hdb_operation.__origin
		);
	}
}

function getDisableTxnLogSetting() {
	let disable_txn_setting = env_mngr.get(HDB_SETTINGS_NAMES.DISABLE_TRANSACTION_LOG_KEY);

	return (
		!hdb_util.isEmptyOrZeroLength(disable_txn_setting) &&
		(disable_txn_setting === true || disable_txn_setting.toString().toLowerCase() === 'true')
	);
}
