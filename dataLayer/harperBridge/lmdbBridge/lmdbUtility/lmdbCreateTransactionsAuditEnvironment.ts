'use strict';;
import fs from 'fs-extra';
import * as environmentUtility from '../../../../utility/lmdb/environmentUtility.js';
import { getTransactionAuditStorePath } from '../lmdbUtility/initializePaths.js';
import * as lmdbTerms from '../../../../utility/lmdb/terms.js';
import * as CreateTableObject from '../../../CreateTableObject.js';
export default createTransactionsAuditEnvironment;

/**
 * Creates the environment to hold transactions
 * @param {CreateTableObject} tableCreateObj
 * @returns {Promise<lmdb.RootDatabase>}
 */
async function createTransactionsAuditEnvironment(tableCreateObj) {
	let env;
	try {
		//create transactions environment for table
		let transactionPath = getTransactionAuditStorePath(tableCreateObj.schema, tableCreateObj.table);
		await fs.mkdirp(transactionPath);
		env = await environmentUtility.createEnvironment(transactionPath, tableCreateObj.table, true);
	} catch (e) {
		e.message = `unable to create transactions audit environment for ${tableCreateObj.schema}.${tableCreateObj.table} due to: ${e.message}`;
		throw e;
	}

	try {
		//create dbis for transactions environment
		environmentUtility.createDBI(env, lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, false, true);
		environmentUtility.createDBI(env, lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE, true, false);
		environmentUtility.createDBI(env, lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME, true, false);
	} catch (e) {
		e.message = `unable to create dbi for ${tableCreateObj.schema}.${tableCreateObj.table} due to: ${e.message}`;
		throw e;
	}
	return env;
}
