'use strict';

const environment_util = require('./environmentUtility');
const common = require('./commonUtility');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const lmdb_terms = require('./terms');
const log = require('../logging/harper_logger');
const hdb_utils = require('../common_utils');
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb-store');
const DeleteRecordsResponseObject = require('./DeleteRecordsResponseObject');

/**
 *  deletes rows and their entries in all indices
 * @param {lmdb.RootDatabase} env - environment object used high level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} ids - list of ids to delete
 * @returns {Promise<DeleteRecordsResponseObject>}
 */
async function deleteRecords(env, hash_attribute, ids) {
	//validate
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	if (!Array.isArray(ids)) {
		if (ids === undefined) {
			throw new Error(LMDB_ERRORS.IDS_REQUIRED);
		}

		throw new Error(LMDB_ERRORS.IDS_MUST_BE_ARRAY);
	}

	try {
		//open all dbis for this env
		let all_dbis = environment_util.listDBIs(env);
		environment_util.initializeDBIs(env, hash_attribute, all_dbis);
		let deleted = new DeleteRecordsResponseObject();

		//iterate records and process deletes
		let cast_hash_value;
		let puts = [];
		let keys = [];
		for (let x = 0, length = ids.length; x < length; x++) {
			try {
				cast_hash_value = hdb_utils.autoCast(ids[x]);

				//attempt to fetch the hash attribute value, this is the row.
				let record = env.dbis[hash_attribute].get(cast_hash_value);
				//if it doesn't exist we skip & move to the next id
				if (!record) {
					deleted.skipped.push(cast_hash_value);
					continue;
				}

				let promise = env.dbis[hash_attribute].ifVersion(cast_hash_value, 1, () => {
					//always just delete the hash_attribute entry upfront
					env.dbis[hash_attribute].remove(cast_hash_value);

					//iterate & delete the non-hash attribute entries
					for (let y = 0; y < all_dbis.length; y++) {
						let attribute = all_dbis[y];
						if (
							!record.hasOwnProperty(attribute) ||
							attribute === hash_attribute ||
							attribute === lmdb_terms.BLOB_DBI_NAME
						) {
							continue;
						}

						let dbi = env.dbis[attribute];
						let value = record[attribute];
						if (value !== null && value !== undefined) {
							if (common.checkIsBlob(value)) {
								env.dbis[lmdb_terms.BLOB_DBI_NAME].remove(`${attribute}/${cast_hash_value}`);
							} else {
								try {
									let converted_key = common.convertKeyValueToWrite(value);
									dbi.remove(converted_key, cast_hash_value);
								} catch (e) {
									log.warn(`cannot delete from attribute: ${attribute}, ${value}:${cast_hash_value}`);
								}
							}
						}
					}
				});
				puts.push(promise);
				keys.push(cast_hash_value);
				deleted.original_records.push(record);
			} catch (e) {
				log.warn(e);
				deleted.skipped.push(cast_hash_value);
			}
		}

		let remove_indices = [];
		let put_results = await Promise.all(puts);
		for (let x = 0, length = put_results.length; x < length; x++) {
			if (put_results[x] === true) {
				deleted.deleted.push(keys[x]);
			} else {
				deleted.skipped.push(keys[x]);
				remove_indices.push(x);
			}
		}

		let offset = 0;
		for (let x = 0; x < remove_indices.length; x++) {
			let index = remove_indices[x];
			deleted.original_records.splice(index - offset, 1);
			//the offset needs to increase for every index we remove
			offset++;
		}

		deleted.txn_time = common.getMicroTime();

		return deleted;
	} catch (e) {
		throw e;
	}
}

module.exports = {
	deleteRecords,
};
