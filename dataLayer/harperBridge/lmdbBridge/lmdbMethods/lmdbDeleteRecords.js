'use strict';

const hdbUtils = require('../../../../utility/common_utils.js');
const deleteUtility = require('../../../../utility/lmdb/deleteUtility.js');
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const { getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const writeTransaction = require('../lmdbUtility/lmdbWriteTransaction.js');
const logger = require('../../../../utility/logging/harper_logger.js');

module.exports = lmdbDeleteRecords;

/**
 * Deletes a full table row at a certain hash.
 * @param deleteObj
 * @param writeToTxnLog {boolean}
 */
async function lmdbDeleteRecords(deleteObj, writeToTxnLog = true) {
	let schemaTable = global.hdb_schema[deleteObj.schema][deleteObj.table];
	let hash_attribute = schemaTable.hash_attribute;
	if (hdbUtils.isEmpty(hash_attribute)) {
		throw new Error(`could not retrieve hash attribute for schema:${deleteObj.schema} and table ${deleteObj.table}`);
	}

	//this would happen for SQL delete
	if (hdbUtils.isEmptyOrZeroLength(deleteObj.hash_values) && !hdbUtils.isEmptyOrZeroLength(deleteObj.records)) {
		//reintitialize hash_values since it is empty we are not sure if the variable has been set to empty array yet
		deleteObj.hash_values = [];
		for (let k = 0; k < deleteObj.records.length; k++) {
			let hashValue = deleteObj.records[k][hash_attribute];
			if (!hdbUtils.isEmpty(hashValue)) {
				deleteObj.hash_values.push(hashValue);
			}
		}
	}

	if (hdbUtils.isEmptyOrZeroLength(deleteObj.hash_values)) {
		return createDeleteResponse([], []);
	} else if (!Array.isArray(deleteObj.hash_values)) {
		throw new Error('hash_values must be an array');
	}

	//this is needed for clustering, right now clustering expects delete to have a records array and use that to get the hash_values.
	if (hdbUtils.isEmptyOrZeroLength(deleteObj.records)) {
		deleteObj.records = [];
		for (let x = 0; x < deleteObj.hash_values.length; x++) {
			deleteObj.records[x] = {
				[hash_attribute]: deleteObj.hash_values[x],
			};
		}
	}
	let envBasePath = getSchemaPath(deleteObj.schema, deleteObj.table);
	let environment = await environmentUtility.openEnvironment(envBasePath, deleteObj.table);

	let response = await deleteUtility.deleteRecords(
		environment,
		hash_attribute,
		deleteObj.hash_values,
		deleteObj.__origin?.timestamp
	);

	try {
		if (writeToTxnLog === true) {
			await writeTransaction(deleteObj, response);
		}
	} catch (e) {
		logger.error(`unable to write transaction due to ${e.message}`);
	}

	return createDeleteResponse(response.deleted, response.skipped, response.txn_time);
}

/**
 * creates the response object for deletes based on the deleted & skipped hashes
 * @param {[]} deleted - list of hash values successfully deleted
 * @param {[]} skipped - list  of hash values which did not get deleted
 * @param {number} txnTime - the transaction timestamp
 * @returns {{skipped_hashes: [], deleted_hashes: [], message: string}}
 */
function createDeleteResponse(deleted, skipped, txnTime) {
	let total = deleted.length + skipped.length;
	let plural = total === 1 ? 'record' : 'records';

	return {
		message: `${deleted.length} of ${total} ${plural} successfully deleted`,
		deleted_hashes: deleted,
		skipped_hashes: skipped,
		txn_time: txnTime,
	};
}
