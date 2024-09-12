'use strict';

const assert = require('assert');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../utility/lmdb/searchUtility');

module.exports = verifyTxn;

/**
 *
 * @param txn_schema_path
 * @param table
 * @param timestamp_expected
 * @param hash_value_expected
 * @param user_name_expected
 * @returns {Promise<void>}
 */
async function verifyTxn(
	txn_schema_path,
	table,
	timestamp_expected = Object.create(null),
	hash_value_expected = Object.create(null),
	user_name_expected = Object.create(null)
) {
	let env = await environment_utility.openEnvironment(txn_schema_path, table, true);
	let transaction = env.useReadTransaction();
	transaction.database = env;

	let results = search_utility.iterateDBI(transaction, 'timestamp');
	assert.deepStrictEqual(results, timestamp_expected);

	results = search_utility.iterateDBI(transaction, 'hash_value');
	assert.deepStrictEqual(results, hash_value_expected);

	results = search_utility.iterateDBI(transaction, 'user_name');
	assert.deepStrictEqual(results, user_name_expected);
	transaction.done();
}
