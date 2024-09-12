'use strict';

//keep these 2 dependencies in this exact order, otherwise this will fail on OSX
const environment_utility = require('../../../utility/lmdb/environmentUtility');

const { insertRecords } = require('../../../utility/lmdb/writeUtility');
const lmdb_common = require('../../../utility/lmdb/commonUtility');
const lmdb_terms = require('../../../utility/lmdb/terms');
const hdb_common = require('../../../utility/common_utils');
const logger = require('../../../utility/logging/harper_logger');
const hdb_util = require('../../../utility/common_utils');
const fs = require('fs-extra');
const path = require('path');
const progress = require('cli-progress');
const assert = require('assert');
const pino = require('pino');
const env_mngr = require('../../../utility/environment/environmentManager');

module.exports = reindexUpgrade;

let BASE_PATH;
let SCHEMA_PATH;
let TMP_PATH;
let TRANSACTIONS_PATH;
let pino_logger;
let error_occurred = false;

/**
 * Used by upgrade to create new lmdb indices from existing lmdb-store indices.
 * Queries the existing table indices to build a new one in hdb/tmp. Once the full table
 * has been processed it will move the table from tmp to the schema folder.
 * If reindexing transactions will move to transactions folder.
 * @returns {Promise<string>}
 */
async function reindexUpgrade(delete_old_db = true) {
	//These variables need to be set within the reindex script so that they do not throw an error when the module is loaded
	// for a new install (i.e. the base path has not been set yet)
	BASE_PATH = env_mngr.getHdbBasePath();
	SCHEMA_PATH = path.join(BASE_PATH, 'schema');
	TMP_PATH = path.join(BASE_PATH, '4_0_0_upgrade_tmp');
	TRANSACTIONS_PATH = path.join(BASE_PATH, 'transactions');
	console.info('Reindexing upgrade started for schemas');
	logger.notify('Reindexing upgrade started for schemas');
	await processTables(SCHEMA_PATH, false, delete_old_db);

	//Confirm that transactions have been implemented for this instance before trying to reindex them so we
	// don't throw an error.
	const transactions_exist = await fs.pathExists(TRANSACTIONS_PATH);
	if (transactions_exist) {
		console.info('\n\nReindexing upgrade started for transaction logs');
		logger.notify('Reindexing upgrade started for transaction logs');
		await processTables(TRANSACTIONS_PATH, true, delete_old_db);
	}

	logger.notify('Reindexing upgrade complete');
	return 'Reindexing for 4.0.0 upgrade complete' + (error_occurred ? ', but errors occurred' : '');
}

/**
 * Gets all the tables in each schema. For each table a temp log is initiated and
 * processTable called. If no errors occur it will empty the tmp folder.
 * @param reindex_path
 * @param is_transaction_reindex
 * @returns {Promise<void>}
 */
async function processTables(reindex_path, is_transaction_reindex, delete_old_db) {
	// Get list of schema folders
	let schema_list = await fs.readdir(reindex_path);

	let schema_length_list = schema_list.length;
	for (let x = 0; x < schema_length_list; x++) {
		let schema_name = schema_list[x];
		let the_schema_path = path.join(reindex_path, schema_name.toString());
		if (schema_name === '.DS_Store') {
			continue;
		}

		// Get list of table folders
		let table_list = await fs.readdir(the_schema_path);
		let table_list_length = table_list.length;
		for (let y = 0; y < table_list_length; y++) {
			const table_name = table_list[y];
			if (table_name === '.DS_Store') {
				continue;
			}
			// the old environments were directories, and so we are only looking for directories
			if (!fs.statSync(path.join(the_schema_path, table_name)).isDirectory()) continue;

			try {
				// Each table gets its own log
				await initPinoLogger(schema_name, table_name, is_transaction_reindex);
				pino_logger.info(`Reindexing started for ${schema_name}.${table_name}`);
				logger.notify(
					`${is_transaction_reindex ? 'Transaction' : 'Schema'} reindexing started for ${schema_name}.${table_name}`
				);
				await processTable(schema_name, table_name, the_schema_path, is_transaction_reindex, delete_old_db);
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
		try {
			await fs.rm(TMP_PATH, { recursive: true });
		} catch (e) {}
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
const BATCH_LEVEL = 20;
/**
 * Opens the old and new environments and copies the records over. Once complete it will
 * validate that all records are in new environment and that the stats match.
 * @param schema
 * @param table
 * @param the_schema_path
 * @param is_transaction_reindex
 * @returns {Promise<void>}
 */
async function processTable(schema, table, the_schema_path, is_transaction_reindex, delete_old_db) {
	let old_env;
	try {
		//open the existing environment
		old_env = await environment_utility.openEnvironment(the_schema_path, table, is_transaction_reindex);
	} catch (err) {
		// If the environment/table is not a valid LMDB file, it is skipped.
		if (err.message === 'MDB_INVALID: File is not an LMDB file') {
			logger.notify(`${schema}.${table} file is not from the old environment and has been skipped`);
			console.info(`${schema}.${table} file is not from the old environment and has been skipped`);
			pino_logger.error(err);
			return;
		}

		throw err;
	}

	//find the name of the hash attribute
	let hash_attribute = getHashDBI(old_env.dbis);
	let primary_dbi = environment_utility.openDBI(old_env, hash_attribute);
	let all_dbi_names = Object.keys(old_env.dbis);
	//stat the hash attribute dbi
	let stats = environment_utility.statDBI(old_env, hash_attribute);
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

	//create new lmdb env
	let new_env = await environment_utility.createEnvironment(the_schema_path, table, false);
	//create hash attribute
	environment_utility.createDBI(new_env, hash_attribute, false, true);

	//create iterator for old env & loop the hash value
	let entries = [];
	try {
		for (let entry of primary_dbi.getRange({ start: false })) {
			entry.value = { ...entry.value }; // copy if it is frozen
			entries.push(entry);
			if (!is_transaction_reindex) {
				if (schema === 'system') {
					if (table === 'hdb_schema') {
						entry.key = entry.key.toString();
						entry.value.name = entry.value.name.toString();
					}
					if (table === 'hdb_table') {
						entry.key = entry.key.toString();
						entry.value.schema = entry.value.schema.toString();
						entry.value.name = entry.value.name.toString();
					}
					if (table === 'hdb_attribute') {
						entry.key = entry.key.toString();
						entry.value.schema = entry.value.schema.toString();
						entry.value.table = entry.value.table.toString();
						entry.value.attribute = entry.value.attribute.toString();
					}
				}
			}
			if (entries.length > BATCH_LEVEL) {
				await finishOutstanding();
			}
		}
		await finishOutstanding();
	} catch (e) {
		error_occurred = true;
		pino_logger.error(e);

		throw e;
	}
	async function finishOutstanding() {
		let results;
		let records = entries.map(({ value }) => value);
		if (is_transaction_reindex)
			results = await Promise.all(records.map((record) => insertTransaction(new_env, record)));
		else
			results = await insertRecords(
				new_env,
				hash_attribute,
				all_dbi_names.filter((name) => name !== '__blob__'),
				records,
				false
			);
		for (let i = 0, l = entries.length; i < l; i++) {
			let { key, value: record } = entries[i];
			pino_logger.info(`Record hash value: ${key} hash: ${hash_attribute}`);
			let success;
			if (is_transaction_reindex) success = results[i];
			else success = results.written_hashes.indexOf(key) > -1;
			//validate indices for the row
			assert(success, true);
			validateIndices(new_env, hash_attribute, record[hash_attribute], is_transaction_reindex);
			pino_logger.info(`Insert success, written hashes: ${results.written_hashes}`);

			//increment the progress bar by 1
			bar.increment();
		}
		entries = [];

		// For every 10% complete log in hdb_log
		let percent_complete = (bar.value / bar.total) * 100;
		if (percent_complete % 10 === 0) {
			logger.notify(`${schema}.${table} ${bar.value}/${bar.total} records inserted`);
		}
		pino_logger.info(`${bar.value}/${bar.total} records inserted`);
	}

	bar.stop();
	//stat old & new envs to make sure they both have the same number of rows
	let old_stats = environment_utility.statDBI(old_env, hash_attribute);
	let new_stats = environment_utility.statDBI(new_env, hash_attribute);
	pino_logger.info(`Old stats entry count: ${old_stats.entryCount}. New stats entry count: ${new_stats.entryCount}`);
	assert.deepStrictEqual(old_stats.entryCount, new_stats.entryCount);

	//close old & new environments, manually delete the global reference to the new env
	await environment_utility.closeEnvironment(old_env);
	await environment_utility.closeEnvironment(new_env);
	delete global.lmdb_map[`${schema}.${table}`];

	if (delete_old_db) {
		//delete old environment
		let old_table_dir = path.join(the_schema_path, table);
		let old_table_path = path.join(old_table_dir, 'data.mdb');
		let old_lock_path = path.join(old_table_dir, 'lock.mdb');
		await fs.unlink(old_table_path);
		await fs.unlink(old_lock_path);
		await fs.rmdir(old_table_dir);
		pino_logger.info(`Deleted old environment files from schema folder: ${old_table_path}, ${old_lock_path}`);
	}
	//stat the moved env & make sure stats match from before
	let env = await environment_utility.openEnvironment(the_schema_path, table);
	let stat = environment_utility.statDBI(env, hash_attribute);
	pino_logger.info(`New stats: ${JSON.stringify(new_stats)}. New stats after move: ${JSON.stringify(stat)}`);
	assert.deepStrictEqual(stat.entryCount, new_stats.entryCount);
	await environment_utility.closeEnvironment(env);
	delete global.lmdb_map[`${schema}.${table}`];
}

/**
 * Transaction logs are indexed differently to regular records so they need their own insert function.
 * They only get secondary indexes for user_name and hash_value.
 * @param txn_env
 * @param txn_object
 * @returns {Promise<*>}
 */
async function insertTransaction(txn_env, txn_object) {
	environment_utility.initializeDBIs(
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
		for (let hash_value of txn_object.hash_values) {
			txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE].put(hash_value, txn_timestamp);
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
		let indexed_values = lmdb_common.getIndexedValues(value);
		if (!indexed_values) return;
		for (let find_value of indexed_values) {
			found = env.dbis[key].doesExist(find_value, hash_value);
			if (!found) {
				pino_logger.info(`Validate indices did not find value in new DBI: ${find_value}. Hash: ${hash_value}`);
			}
			assert.deepStrictEqual(found, true);
		}
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
