import * as environmentUtil from '../../../../utility/lmdb/environmentUtility.ts';
import LMDBInsertTransactionObject from './LMDBInsertTransactionObject.ts';
import LMDBUpdateTransactionObject from './LMDBUpdateTransactionObject.ts';
import LMDBUpsertTransactionObject from './LMDBUpsertTransactionObject.ts';
import LMDBDeleteTransactionObject from './LMDBDeleteTransactionObject.ts';

import * as lmdbTerms from '../../../../utility/lmdb/terms.ts';
import * as hdbUtil from '../../../../utility/common_utils.ts';
import { CONFIG_PARAMS } from '../../../../utility/hdbTerms.ts';
import * as envMngr from '../../../../utility/environment/environmentManager.ts';

import { OPERATIONS_ENUM } from '../../../../utility/hdbTerms.ts';
import { getTransactionAuditStorePath } from './initializePaths.ts';

export default writeTransaction;

/**
 *
 * @param {InsertObject|UpdateObject|DeleteObject|UpsertObject} hdbOperation
 * @param {InsertRecordsResponseObject | UpdateRecordsResponseObject | UpdateRecordsResponseObject | DeleteRecordsResponseObject} lmdbResponse
 * @returns {Promise<void>}
 */
async function writeTransaction(hdbOperation, lmdbResponse) {
	if (envMngr.get(CONFIG_PARAMS.LOGGING_AUDITLOG) === false) {
		return;
	}

	let txnEnvBasePath = getTransactionAuditStorePath(hdbOperation.schema, hdbOperation.table);
	let txnEnv = await environmentUtil.openEnvironment(txnEnvBasePath, hdbOperation.table, true);

	let txnObject = createTransactionObject(hdbOperation, lmdbResponse);

	if (txnObject === undefined || txnObject.hash_values.length === 0) {
		return;
	}

	if (txnEnv !== undefined) {
		environmentUtil.initializeDBIs(
			txnEnv,
			lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP,
			lmdbTerms.TRANSACTIONS_DBIS
		);

		let txnTimestamp = txnObject.timestamp;
		return await txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].ifNoExists(txnTimestamp, () => {
			txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].put(txnTimestamp, txnObject);
			if (!hdbUtil.isEmpty(txnObject.user_name)) {
				txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].put(txnObject.user_name, txnTimestamp);
			}
			for (let x = 0; x < txnObject.hash_values.length; x++) {
				txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE].put(txnObject.hash_values[x], txnTimestamp);
			}
		});
	}
}

/**
 *
 * @param {InsertObject | UpdateObject | DeleteObject} hdbOperation
 * @param {InsertRecordsResponseObject | UpdateRecordsResponseObject | DeleteRecordsResponseObject} lmdbResponse
 * @returns {LMDBInsertTransactionObject|LMDBUpdateTransactionObject|LMDBDeleteTransactionObject}
 */
function createTransactionObject(hdbOperation, lmdbResponse) {
	let username = !hdbUtil.isEmpty(hdbOperation.hdb_user) ? hdbOperation.hdb_user?.username : undefined;
	if (hdbOperation.operation === OPERATIONS_ENUM.INSERT) {
		return new LMDBInsertTransactionObject(
			hdbOperation.records,
			username,
			lmdbResponse.txn_time,
			lmdbResponse.written_hashes,
			hdbOperation.__origin
		);
	}

	if (hdbOperation.operation === OPERATIONS_ENUM.UPDATE) {
		return new LMDBUpdateTransactionObject(
			hdbOperation.records,
			lmdbResponse.original_records,
			username,
			lmdbResponse.txn_time,
			lmdbResponse.written_hashes,
			hdbOperation.__origin
		);
	}

	if (hdbOperation.operation === OPERATIONS_ENUM.UPSERT) {
		return new LMDBUpsertTransactionObject(
			hdbOperation.records,
			lmdbResponse.original_records,
			username,
			lmdbResponse.txn_time,
			lmdbResponse.written_hashes,
			hdbOperation.__origin
		);
	}

	if (hdbOperation.operation === OPERATIONS_ENUM.DELETE) {
		return new LMDBDeleteTransactionObject(
			lmdbResponse.deleted,
			lmdbResponse.original_records,
			username,
			lmdbResponse.txn_time,
			hdbOperation.__origin
		);
	}
}
