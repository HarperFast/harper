'use strict';

const hdb_utils = require('../../../../utility/common_utils');
const delete_utility = require('../../../../utility/lmdb/deleteUtility');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const { getSchemaPath } = require('../lmdbUtility/initializePaths');
const write_transaction = require('../lmdbUtility/lmdbWriteTransaction');
const logger = require('../../../../utility/logging/harper_logger');

module.exports = lmdbDeleteRecords;

/**
 * Deletes a full table row at a certain hash.
 * @param delete_obj
 * @param write_to_txn_log {boolean}
 */
async function lmdbDeleteRecords(delete_obj, write_to_txn_log = true) {
	let schema_table = global.hdb_schema[delete_obj.schema][delete_obj.table];
	let hash_attribute = schema_table.hash_attribute;
	if (hdb_utils.isEmpty(hash_attribute)) {
		throw new Error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
	}

	try {
		//this would happen for SQL delete
		if (hdb_utils.isEmptyOrZeroLength(delete_obj.hash_values) && !hdb_utils.isEmptyOrZeroLength(delete_obj.records)) {
			//reintitialize hash_values since it is empty we are not sure if the variable has been set to empty array yet
			delete_obj.hash_values = [];
			for (let k = 0; k < delete_obj.records.length; k++) {
				let hash_value = delete_obj.records[k][hash_attribute];
				if (!hdb_utils.isEmpty(hash_value)) {
					delete_obj.hash_values.push(hash_value);
				}
			}
		}

		if (hdb_utils.isEmptyOrZeroLength(delete_obj.hash_values)) {
			return createDeleteResponse([], []);
		} else if (!Array.isArray(delete_obj.hash_values)) {
			throw new Error('hash_values must be an array');
		}

		//this is needed for clustering, right now clustering expects delete to have a records array and use that to get the hash_values.
		if (hdb_utils.isEmptyOrZeroLength(delete_obj.records)) {
			delete_obj.records = [];
			for (let x = 0; x < delete_obj.hash_values.length; x++) {
				delete_obj.records[x] = {
					[hash_attribute]: delete_obj.hash_values[x],
				};
			}
		}
		let env_base_path = getSchemaPath(delete_obj.schema, delete_obj.table);
		let environment = await environment_utility.openEnvironment(env_base_path, delete_obj.table);

		let response = await delete_utility.deleteRecords(
			environment,
			hash_attribute,
			delete_obj.hash_values,
			delete_obj.__origin?.timestamp
		);

		try {
			if (write_to_txn_log === true) {
				await write_transaction(delete_obj, response);
			}
		} catch (e) {
			logger.error(`unable to write transaction due to ${e.message}`);
		}

		return createDeleteResponse(response.deleted, response.skipped, response.txn_time);
	} catch (err) {
		throw err;
	}
}

/**
 * creates the response object for deletes based on the deleted & skipped hashes
 * @param {[]} deleted - list of hash values successfully deleted
 * @param {[]} skipped - list  of hash values which did not get deleted
 * @param {number} txn_time - the transaction timestamp
 * @returns {{skipped_hashes: [], deleted_hashes: [], message: string}}
 */
function createDeleteResponse(deleted, skipped, txn_time) {
	let total = deleted.length + skipped.length;
	let plural = total === 1 ? 'record' : 'records';

	return {
		message: `${deleted.length} of ${total} ${plural} successfully deleted`,
		deleted_hashes: deleted,
		skipped_hashes: skipped,
		txn_time: txn_time,
	};
}
