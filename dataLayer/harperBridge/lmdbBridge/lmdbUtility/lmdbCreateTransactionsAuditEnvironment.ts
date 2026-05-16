import fs from 'fs-extra';
import * as environmentUtility from '../../../../utility/lmdb/environmentUtility.ts';
import { getTransactionAuditStorePath } from '../lmdbUtility/initializePaths.ts';
import * as lmdbTerms from '../../../../utility/lmdb/terms.ts';
// eslint-disable-next-line no-unused-vars
const CreateTableObject =
	require('../../../CreateTableObject.ts').default ||
	require('../../../CreateTableObject.ts').default ||
	require('../../../CreateTableObject.ts');

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
