'use strict';

//keep these 2 dependencies in this exact order, otherwise this will fail on OSX
const new_environment_utility = require('../../../utility/lmdb/environmentUtility');
const old_environment_utility = require('../../lmdb/nodeLMDB/environmentUtility');

const { insertRecords } = require('../../../utility/lmdb/writeUtility');
const lmdb_common = require('../../../utility/lmdb/commonUtility');
const lmdb_terms = require('../../../utility/lmdb/terms');
const hdb_common = require('../../../utility/common_utils');
const hdb_terms = require('../../../utility/hdbTerms');
const { STORAGE_TYPES_ENUM } = require('../../../utility/hdbTerms');
const logger = require('../../../utility/logging/harper_logger');
const hdb_util = require('../../../utility/common_utils');
const fs = require('fs-extra');
const path = require('path');
const progress = require('cli-progress');
const assert = require('assert');
const pino = require('pino');
const minimist = require('minimist');
const env_mngr = require('../../../utility/environment/environmentManager');
env_mngr.initSync();

module.exports = reindexUpgrade;

let BASE_PATH;
let SCHEMA_PATH;
let TMP_PATH;
let TRANSACTIONS_PATH;
let pino_logger;
let error_occurred = false;
let data_store_type = undefined;

/**
 * Used by upgrade to create new lmdb-store indices from existing node-lmdb indices.
 * Queries the existing table indices to build a new one in hdb/tmp. Once the full table
 * has been processed it will move the table from tmp to the schema folder.
 * If reindexing transactions will move to transactions folder.
 * @returns {Promise<string>}
 */
async function reindexUpgrade() {
	//we need to check to see if the instance is using FS instead of LMDB - if so, we can skip the reindex step
	if (getDataStoreType() === STORAGE_TYPES_ENUM.FILE_SYSTEM) {
		console.info('\n\nHDB using FS datastore - no need to run LMDB reindexing');
		return 'Reindexing skipped for FS datastore instance of HDB';
	}
	//These variables need to be set within the reindex script so that they do not throw an error when the module is loaded
	// for a new install (i.e. the base path has not been set yet)
	BASE_PATH = env_mngr.getHdbBasePath();
	SCHEMA_PATH = path.join(BASE_PATH, 'schema');
	TMP_PATH = path.join(BASE_PATH, '3_0_0_upgrade_tmp');
	TRANSACTIONS_PATH = path.join(BASE_PATH, 'transactions');
	console.info('Reindexing upgrade started for schemas');
	logger.notify('Reindexing upgrade started for schemas');
	await getSchemaTable(SCHEMA_PATH, false);

	//We need to confirm that transactions have been implemented for this instance before trying to reindex them so we
	// don't throw an error.
	const transactions_exist = await fs.pathExists(TRANSACTIONS_PATH);
	if (transactions_exist) {
		console.info('\n\nReindexing upgrade started for transaction logs');
		logger.notify('Reindexing upgrade started for transaction logs');
		await getSchemaTable(TRANSACTIONS_PATH, true);
	}
	logger.notify('Reindexing upgrade complete');
	return 'Reindexing for 3.0.0 upgrade complete';
}

/**
 * Gets all the tables in each schema. For each table a temp log is initiated and
 * processTable called. If no errors occur it will empty the tmp folder.
 * @param reindex_path
 * @param is_transaction_reindex
 * @returns {Promise<void>}
 */
async function getSchemaTable(reindex_path, is_transaction_reindex) {
	// Get list of schema folders
	let schema_list = await fs.readdir(reindex_path);

	let schema_length_list = schema_list.length;
	for (let x = 0; x < schema_length_list; x++) {
		let schema_name = schema_list[x];
		let the_schema_path = path.join(reindex_path, schema_name.toString());
		if (schema_name === '.DS_Store') {
			continue;
		}

		// Create temp schema folder
		let tmp_schema_path = path.join(TMP_PATH, schema_name.toString());
		await fs.emptyDir(tmp_schema_path);

		// Get list of table folders
		let table_list = await fs.readdir(the_schema_path);
		let table_list_length = table_list.length;
		for (let y = 0; y < table_list_length; y++) {
			const table_name = table_list[y];
			if (table_name === '.DS_Store') {
				continue;
			}

			try {
				// Each table gets its own log
				await initPinoLogger(schema_name, table_name, is_transaction_reindex);
				pino_logger.info(`Reindexing started for ${schema_name}.${table_name}`);
				logger.notify(
					`${is_transaction_reindex ? 'Transaction' : 'Schema'} reindexing started for ${schema_name}.${table_name}`
				);
				await processTable(schema_name, table_name, the_schema_path, is_transaction_reindex, tmp_schema_path);
				pino_logger.info(`Reindexing completed for ${schema_name}.${table_name}`);
				logger.notify(`Reindexing completed for ${schema_name}.${table_name}`);
			} catch (err) {
				error_occurred = true;
				err.schema_path = the_schema_path;
				err.table_name = table_name;
				logger.error(
					'There was an error with the reindex upgrade, check the logs in hdb/3_0_0_upgrade_tmp for more details'
				);
				logger.error(err);
				pino_logger.error(err);
				console.error(err);
			}
		}
	}

	// If no errors occurred clean out the tmp folder after reindex.
	if (!error_occurred) {
		await fs.remove(TMP_PATH);
	}
}

/**
 * Creates a log for each table that gets re-indexed.
 * @param schema
 * @param table
 * @param is_transaction_reindex
 * @returns {Promise<undefined>}
 */
async function initPinoLogger(schema, table, is_transaction_reindex) {
	let reindex_suffix = is_transaction_reindex ? 'transaction_reindex' : 'schema_reindex';
	let log_name = `${schema}_${table}_${reindex_suffix}.log`;
	let log_destination = path.join(TMP_PATH, log_name);
	await fs.ensureDir(TMP_PATH);
	await fs.writeFile(log_destination, '');
	pino_logger = pino(
		{
			level: 'debug',
			formatters: {
				bindings() {
					return undefined;
				},
			},
		},
		log_destination
	);
}

/**
 * Opens the old and new environments and copies the records over. Once complete it will
 * validate that all records are in new environment and that the stats match.
 * @param schema
 * @param table
 * @param the_schema_path
 * @param is_transaction_reindex
 * @param tmp_schema_path
 * @returns {Promise<void>}
 */
async function processTable(schema, table, the_schema_path, is_transaction_reindex, tmp_schema_path) {
	let old_env;
	try {
		//open the existing environment with the "old" environment utility
		old_env = await old_environment_utility.openEnvironment(the_schema_path, table, is_transaction_reindex);
	} catch (err) {
		// If the environment/table is not of the NODE LMDB type it is skipped.
		if (err.message === 'MDB_INVALID: File is not an LMDB file') {
			logger.notify(`${schema}.${table} file is not from the old environment and has been skipped`);
			console.info(`${schema}.${table} file is not from the old environment and has been skipped`);
			pino_logger.error(err);
			return;
		}

		throw err;
	}

	//find the name of the hash attribute
	let hash = getHashDBI(old_env.dbis);
	let all_dbi_names = Object.keys(old_env.dbis);
	//stat the hash attribute dbi
	let stats = old_environment_utility.statDBI(old_env, hash);
	pino_logger.info(`Old environment stats: ${JSON.stringify(stats)}`);

	//initialize the progress bar for this table
	let bar = new progress.SingleBar({
		format: `${schema}.${table} |{bar}| {percentage}% || {value}/{total} records`,
		barCompleteChar: '\u2588',
		barIncompleteChar: '\u2591',
		hideCursor: true,
		clearOnComplete: false,
	});
	bar.start(stats.entryCount, 0, {});

	//create lmdb-store env
	let new_env = await new_environment_utility.createEnvironment(tmp_schema_path, table, false);
	//create hash attribute
	new_environment_utility.createDBI(new_env, hash, false, true);

	//create iterator for old env & loop the hash value
	let txn = undefined;
	try {
		txn = new old_environment_utility.TransactionCursor(old_env, hash);
		for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
			let record = JSON.parse(txn.cursor.getCurrentString());
			let hash_value = hdb_common.autoCast(record[hash]);
			pino_logger.info(`Record hash value: ${hash_value} hash: ${hash}`);

			let results;
			let success = false;
			if (is_transaction_reindex) {
				// Transaction logs are indexed differently to regular records so they need their own insert function.
				results = await insertTransaction(new_env, record);
				success = results;
			} else {
				results = await insertRecords(new_env, hash, all_dbi_names, [record], false);
				success = results.written_hashes.indexOf(hash_value) > -1;
			}

			//validate indices for the row
			assert(success, true);
			validateIndices(new_env, hash, record[hash], is_transaction_reindex);
			pino_logger.info(`Insert success, written hashes: ${results.written_hashes}`);

			//increment the progress bar by 1
			bar.increment();

			// For every 10% complete log in hdb_log
			let percent_complete = (bar.value / bar.total) * 100;
			if (percent_complete % 10 === 0) {
				logger.notify(`${schema}.${table} ${bar.value}/${bar.total} records inserted`);
			}
			pino_logger.info(`${bar.value}/${bar.total} records inserted`);
		}
		txn.close();
	} catch (e) {
		error_occurred = true;
		if (txn !== undefined) {
			txn.close();
		}
		pino_logger.error(e);

		throw e;
	}

	bar.stop();
	//stat old & new envs to make sure they both have the same number of rows
	let old_stats = old_environment_utility.statDBI(old_env, hash);
	let new_stats = new_environment_utility.statDBI(new_env, hash);
	pino_logger.info(`Old stats entry count: ${old_stats.entryCount}. New stats entry count: ${new_stats.entryCount}`);
	assert.deepStrictEqual(old_stats.entryCount, new_stats.entryCount);

	//close old & new environments, manually delete the global reference to the new env
	old_environment_utility.closeEnvironment(old_env);
	new_environment_utility.closeEnvironment(new_env);
	delete global.lmdb_map[`${schema}.${table}`];

	//move environment to correct location
	let table_path = path.join(the_schema_path, table.toString());
	await fs.move(path.join(tmp_schema_path, table.toString()), table_path, { overwrite: true });
	pino_logger.info(`Moving environment to schema folder: ${table_path}`);

	//stat the moved env & make sure stats match from before
	let env = await new_environment_utility.openEnvironment(the_schema_path, table);
	let stat = new_environment_utility.statDBI(env, hash);
	pino_logger.info(`New stats: ${JSON.stringify(new_stats)}. New stats after move: ${JSON.stringify(stat)}`);
	assert.deepStrictEqual(stat, new_stats);
	new_environment_utility.closeEnvironment(env);
}

/**
 * Transaction logs are indexed differently to regular records so they need their own insert function.
 * They only get secondary indexes for user_name and hash_value.
 * @param txn_env
 * @param txn_object
 * @returns {Promise<*>}
 */
async function insertTransaction(txn_env, txn_object) {
	new_environment_utility.initializeDBIs(
		txn_env,
		lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP,
		lmdb_terms.TRANSACTIONS_DBIS
	);
	let txn_timestamp = txn_object.timestamp;
	return txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].ifNoExists(txn_timestamp, () => {
		txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].put(txn_timestamp, txn_object);
		if (!hdb_util.isEmpty(txn_object.user_name)) {
			txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].put(txn_object.user_name, txn_timestamp);
		}
		for (let x = 0; x < txn_object.hash_values.length; x++) {
			txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE].put(txn_object.hash_values[x], txn_timestamp);
		}
	});
}

/**
 * For each entry we call validate.
 * @param env
 * @param hash
 * @param hash_value
 * @param is_transaction_reindex
 */
function validateIndices(env, hash, hash_value, is_transaction_reindex) {
	let hash_dbi = env.dbis[hash];

	let record = hash_dbi.get(hash_value);
	assert.deepStrictEqual(typeof record, 'object');

	let entries;
	if (is_transaction_reindex) {
		// For transaction log we only create indices from user_name and hash_values, which means we only need to check for those two.
		let tmp_obj = {
			[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME]: record.user_name,
			[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE]: record.hash_values,
		};
		entries = Object.entries(tmp_obj);
	} else {
		entries = Object.entries(record);
	}

	for (const [key, value] of entries) {
		if (key !== hash && env.dbis[key] !== undefined && !hdb_common.isEmptyOrZeroLength(value)) {
			// When validating transaction indices we need to validate each index created for timestamp hash.
			if (is_transaction_reindex && key === 'hash_value') {
				for (let j = 0, length = value.length; j < length; j++) {
					let value_value = value[j];
					validateIndex(env, key, value_value, hash_value);
				}
			} else {
				validateIndex(env, key, value, hash_value);
			}
		}
	}
}

/**
 * Validates that the entry is in the new index
 * @param env
 * @param key
 * @param value
 * @param hash_value
 */
function validateIndex(env, key, value, hash_value) {
	try {
		let found = false;
		if (lmdb_common.checkIsBlob(value)) {
			let blob_key = `${key}/${hash_value}`;
			let entry = env.dbis[lmdb_terms.BLOB_DBI_NAME].get(blob_key);
			found = entry !== undefined;
			if (!found) {
				pino_logger.info(`Validate indices did not find blob value in new DBI: ${value}. Hash: ${hash_value}`);
			}
		} else {
			let find_value = lmdb_common.convertKeyValueToWrite(value);
			found = env.dbis[key].doesExist(find_value, hash_value);
			if (!found) {
				pino_logger.info(`Validate indices did not find value in new DBI: ${find_value}. Hash: ${hash_value}`);
			}
		}
		assert.deepStrictEqual(found, true);
	} catch (e) {
		error_occurred = true;
		pino_logger.error(e);
		console.error(e);
	}
}

/**
 * Gets the hash of a DBIS.
 * @param dbis
 * @returns {string}
 */
function getHashDBI(dbis) {
	let hash_attribute;
	for (const [key, value] of Object.entries(dbis)) {
		if (value.__dbi_defintion__.is_hash_attribute === true) {
			hash_attribute = key;
			break;
		}
	}
	return hash_attribute;
}

/**
 * evaluates what data store type HDB is using, default is LMDB.  first will check the system.user directory, chosen because it will always hold data post install.  if it has a file named data.mdb we are lmdb, otherwise fs.
 * if there is no user folder then we check if there is a data_store argument from the command line, used for install.
 */
function getDataStoreType() {
	if (data_store_type !== undefined) {
		return data_store_type;
	}

	//set lmdb as the default
	data_store_type = hdb_terms.STORAGE_TYPES_ENUM.LMDB;
	let readdir_results = undefined;
	try {
		let user_path = path.join(
			env_mngr.getHdbBasePath(),
			hdb_terms.SCHEMA_DIR_NAME,
			hdb_terms.SYSTEM_SCHEMA_NAME,
			hdb_terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME
		);
		readdir_results = fs.readdirSync(user_path);
		let is_lmdb = false;
		for (let x = 0; x < readdir_results.length; x++) {
			//LMDB will have a file called data.mdb
			if (readdir_results[x] === 'data.mdb') {
				is_lmdb = true;
				break;
			}
		}

		if (is_lmdb === true) {
			data_store_type = hdb_terms.STORAGE_TYPES_ENUM.LMDB;
		}
	} catch (e) {
		//if there is no user folder we check if the command line is stating file system
		// eslint-disable-next-line no-magic-numbers
		const ARGS = minimist(process.argv.slice(2));
		if (ARGS['data_store'] === hdb_terms.STORAGE_TYPES_ENUM.FILE_SYSTEM) {
			data_store_type = hdb_terms.STORAGE_TYPES_ENUM.FILE_SYSTEM;
		}
	}

	return data_store_type;
}
