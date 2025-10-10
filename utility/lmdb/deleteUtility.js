'use strict';

const environmentUtil = require('./environmentUtility.js');
const common = require('./commonUtility.js');
const LMDB_ERRORS = require('../errors/commonErrors.js').LMDB_ERRORS_ENUM;
const lmdbTerms = require('./terms.js');
const log = require('../logging/harper_logger.js');
const hdbUtils = require('../common_utils.js');
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const DeleteRecordsResponseObject = require('./DeleteRecordsResponseObject.js');
const hdbTerms = require('../hdbTerms.ts');
const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdbTerms;
const UPDATED_TIME_ATTRIBUTE_NAME = hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME;

/**
 *  deletes rows and their entries in all indices
 * @param {lmdb.RootDatabase} env - environment object used high level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} ids - list of ids to delete
 * @param {number} whenDeleted - The timestamp of the deletion
 * @returns {Promise<DeleteRecordsResponseObject>}
 */
async function deleteRecords(env, hash_attribute, ids, whenDeleted) {
	//validate
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	if (!Array.isArray(ids)) {
		if (ids === undefined) {
			throw new Error(LMDB_ERRORS.IDS_REQUIRED);
		}

		throw new Error(LMDB_ERRORS.IDS_MUST_BE_ITERABLE);
	}

	try {
		//open all dbis for this env
		let allDbis = environmentUtil.listDBIs(env);
		environmentUtil.initializeDBIs(env, hash_attribute, allDbis);
		let deleted = new DeleteRecordsResponseObject();

		//iterate records and process deletes
		let hashValue;
		let puts = [];
		let keys = [];
		for (let x = 0, length = ids.length; x < length; x++) {
			try {
				hashValue = ids[x];

				//attempt to fetch the hash attribute value, this is the row.
				let record = env.dbis[hash_attribute].get(hashValue);
				//if it doesn't exist we skip & move to the next id
				if (
					!record ||
					// of if the deletion timestamp is older than the current record, last-write wins
					(whenDeleted && record[UPDATED_TIME_ATTRIBUTE_NAME] > whenDeleted)
				) {
					deleted.skipped.push(hashValue);
					continue;
				}

				let promise = env.dbis[hash_attribute].ifVersion(hashValue, lmdb.IF_EXISTS, () => {
					//always just delete the hash_attribute entry upfront
					env.dbis[hash_attribute].remove(hashValue);

					//iterate & delete the non-hash attribute entries
					for (let y = 0; y < allDbis.length; y++) {
						let attribute = allDbis[y];
						if (!record.hasOwnProperty(attribute) || attribute === hash_attribute) {
							continue;
						}

						let dbi = env.dbis[attribute];
						let value = record[attribute];
						if (value !== null && value !== undefined) {
							try {
								let values = common.getIndexedValues(value);
								if (values) {
									for (let i = 0, l = values.length; i < l; i++) {
										dbi.remove(values[i], hashValue);
									}
								}
							} catch (e) {
								log.warn(`cannot delete from attribute: ${attribute}, ${value}:${hashValue}`);
							}
						}
					}
				});
				puts.push(promise);
				keys.push(hashValue);
				deleted.original_records.push(record);
			} catch (e) {
				log.warn(e);
				deleted.skipped.push(hashValue);
			}
		}

		let removeIndices = [];
		let putResults = await Promise.all(puts);
		for (let x = 0, length = putResults.length; x < length; x++) {
			if (putResults[x] === true) {
				deleted.deleted.push(keys[x]);
			} else {
				deleted.skipped.push(keys[x]);
				removeIndices.push(x);
			}
		}

		let offset = 0;
		for (let x = 0; x < removeIndices.length; x++) {
			let index = removeIndices[x];
			deleted.original_records.splice(index - offset, 1);
			//the offset needs to increase for every index we remove
			offset++;
		}

		deleted.txn_time = common.getNextMonotonicTime();

		return deleted;
	} catch (e) {
		throw e;
	}
}

module.exports = {
	deleteRecords,
};
