'use strict';

//keep these 2 dependencies in this exact order, otherwise this will fail on OSX
const environmentUtility = require('../../../utility/lmdb/environmentUtility.js');

const { insertRecords } = require('../../../utility/lmdb/writeUtility.js');
const lmdbCommon = require('../../../utility/lmdb/commonUtility.js');
const lmdbTerms = require('../../../utility/lmdb/terms.js');
const hdbCommon = require('../../../utility/common_utils.js');
const logger = require('../../../utility/logging/harper_logger.js');
const hdbUtil = require('../../../utility/common_utils.js');
const fs = require('fs-extra');
const path = require('path');
const progress = require('cli-progress');
const assert = require('assert');
const pino = require('pino');
const envMngr = require('../../../utility/environment/environmentManager.js');

module.exports = reindexUpgrade;

let BASE_PATH;
let SCHEMA_PATH;
let TMP_PATH;
let TRANSACTIONS_PATH;
let pinoLogger;
let errorOccurred = false;

/**
 * Used by upgrade to create new lmdb indices from existing lmdb-store indices.
 * Queries the existing table indices to build a new one in hdb/tmp. Once the full table
 * has been processed it will move the table from tmp to the schema folder.
 * If reindexing transactions will move to transactions folder.
 * @returns {Promise<string>}
 */
async function reindexUpgrade(deleteOldDb = true) {
	//These variables need to be set within the reindex script so that they do not throw an error when the module is loaded
	// for a new install (i.e. the base path has not been set yet)
	BASE_PATH = envMngr.getHdbBasePath();
	SCHEMA_PATH = path.join(BASE_PATH, 'schema');
	TMP_PATH = path.join(BASE_PATH, '4_0_0_upgrade_tmp');
	TRANSACTIONS_PATH = path.join(BASE_PATH, 'transactions');
	console.info('Reindexing upgrade started for schemas');
	logger.notify('Reindexing upgrade started for schemas');
	await processTables(SCHEMA_PATH, false, deleteOldDb);

	//Confirm that transactions have been implemented for this instance before trying to reindex them so we
	// don't throw an error.
	const transactionsExist = await fs.pathExists(TRANSACTIONS_PATH);
	if (transactionsExist) {
		console.info('\n\nReindexing upgrade started for transaction logs');
		logger.notify('Reindexing upgrade started for transaction logs');
		await processTables(TRANSACTIONS_PATH, true, deleteOldDb);
	}

	logger.notify('Reindexing upgrade complete');
	return 'Reindexing for 4.0.0 upgrade complete' + (errorOccurred ? ', but errors occurred' : '');
}

/**
 * Gets all the tables in each schema. For each table a temp log is initiated and
 * processTable called. If no errors occur it will empty the tmp folder.
 * @param reindexPath
 * @param isTransactionReindex
 * @returns {Promise<void>}
 */
async function processTables(reindexPath, isTransactionReindex, deleteOldDb) {
	// Get list of schema folders
	let schemaList = await fs.readdir(reindexPath);

	let schemaLengthList = schemaList.length;
	for (let x = 0; x < schemaLengthList; x++) {
		let schemaName = schemaList[x];
		let theSchemaPath = path.join(reindexPath, schemaName.toString());
		if (schemaName === '.DS_Store') {
			continue;
		}

		// Get list of table folders
		let tableList = await fs.readdir(theSchemaPath);
		let tableListLength = tableList.length;
		for (let y = 0; y < tableListLength; y++) {
			const tableName = tableList[y];
			if (tableName === '.DS_Store') {
				continue;
			}
			// the old environments were directories, and so we are only looking for directories
			if (!fs.statSync(path.join(theSchemaPath, tableName)).isDirectory()) continue;

			try {
				// Each table gets its own log
				await initPinoLogger(schemaName, tableName, isTransactionReindex);
				pinoLogger.info(`Reindexing started for ${schemaName}.${tableName}`);
				logger.notify(
					`${isTransactionReindex ? 'Transaction' : 'Schema'} reindexing started for ${schemaName}.${tableName}`
				);
				await processTable(schemaName, tableName, theSchemaPath, isTransactionReindex, deleteOldDb);
				pinoLogger.info(`Reindexing completed for ${schemaName}.${tableName}`);
				logger.notify(`Reindexing completed for ${schemaName}.${tableName}`);
			} catch (err) {
				errorOccurred = true;
				err.schema_path = theSchemaPath;
				err.table_name = tableName;
				logger.error(
					'There was an error with the reindex upgrade, check the logs in hdb/3_0_0_upgrade_tmp for more details'
				);
				logger.error(err);
				pinoLogger.error(err);
				console.error(err);
			}
		}
	}
	// If no errors occurred clean out the tmp folder after reindex.
	if (!errorOccurred) {
		try {
			await fs.rm(TMP_PATH, { recursive: true });
		} catch (e) {}
	}
}

/**
 * Creates a log for each table that gets re-indexed.
 * @param schema
 * @param table
 * @param isTransactionReindex
 * @returns {Promise<undefined>}
 */
async function initPinoLogger(schema, table, isTransactionReindex) {
	let reindexSuffix = isTransactionReindex ? 'transaction_reindex' : 'schema_reindex';
	let logName = `${schema}_${table}_${reindexSuffix}.log`;
	let logDestination = path.join(TMP_PATH, logName);
	await fs.ensureDir(TMP_PATH);
	await fs.writeFile(logDestination, '');
	pinoLogger = pino(
		{
			level: 'debug',
			formatters: {
				bindings() {
					return undefined;
				},
			},
		},
		logDestination
	);
}
const BATCH_LEVEL = 20;
/**
 * Opens the old and new environments and copies the records over. Once complete it will
 * validate that all records are in new environment and that the stats match.
 * @param schema
 * @param table
 * @param theSchemaPath
 * @param isTransactionReindex
 * @returns {Promise<void>}
 */
async function processTable(schema, table, theSchemaPath, isTransactionReindex, deleteOldDb) {
	let oldEnv;
	try {
		//open the existing environment
		oldEnv = await environmentUtility.openEnvironment(theSchemaPath, table, isTransactionReindex);
	} catch (err) {
		// If the environment/table is not a valid LMDB file, it is skipped.
		if (err.message === 'MDB_INVALID: File is not an LMDB file') {
			logger.notify(`${schema}.${table} file is not from the old environment and has been skipped`);
			console.info(`${schema}.${table} file is not from the old environment and has been skipped`);
			pinoLogger.error(err);
			return;
		}

		throw err;
	}

	//find the name of the hash attribute
	let hash_attribute = getHashDBI(oldEnv.dbis);
	let primaryDbi = environmentUtility.openDBI(oldEnv, hash_attribute);
	let allDbiNames = Object.keys(oldEnv.dbis);
	//stat the hash attribute dbi
	let stats = environmentUtility.statDBI(oldEnv, hash_attribute);
	pinoLogger.info(`Old environment stats: ${JSON.stringify(stats)}`);

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
	let newEnv = await environmentUtility.createEnvironment(theSchemaPath, table, false);
	//create hash attribute
	environmentUtility.createDBI(newEnv, hash_attribute, false, true);

	//create iterator for old env & loop the hash value
	let entries = [];
	try {
		for (let entry of primaryDbi.getRange({ start: false })) {
			entry.value = { ...entry.value }; // copy if it is frozen
			entries.push(entry);
			if (!isTransactionReindex) {
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
		errorOccurred = true;
		pinoLogger.error(e);

		throw e;
	}
	async function finishOutstanding() {
		let results;
		let records = entries.map(({ value }) => value);
		if (isTransactionReindex)
			results = await Promise.all(records.map((record) => insertTransaction(newEnv, record)));
		else
			results = await insertRecords(
				newEnv,
				hash_attribute,
				allDbiNames.filter((name) => name !== '__blob__'),
				records,
				false
			);
		for (let i = 0, l = entries.length; i < l; i++) {
			let { key, value: record } = entries[i];
			pinoLogger.info(`Record hash value: ${key} hash: ${hash_attribute}`);
			let success;
			if (isTransactionReindex) success = results[i];
			else success = results.written_hashes.indexOf(key) > -1;
			//validate indices for the row
			assert(success, true);
			validateIndices(newEnv, hash_attribute, record[hash_attribute], isTransactionReindex);
			pinoLogger.info(`Insert success, written hashes: ${results.written_hashes}`);

			//increment the progress bar by 1
			bar.increment();
		}
		entries = [];

		// For every 10% complete log in hdbLog
		let percentComplete = (bar.value / bar.total) * 100;
		if (percentComplete % 10 === 0) {
			logger.notify(`${schema}.${table} ${bar.value}/${bar.total} records inserted`);
		}
		pinoLogger.info(`${bar.value}/${bar.total} records inserted`);
	}

	bar.stop();
	//stat old & new envs to make sure they both have the same number of rows
	let oldStats = environmentUtility.statDBI(oldEnv, hash_attribute);
	let newStats = environmentUtility.statDBI(newEnv, hash_attribute);
	pinoLogger.info(`Old stats entry count: ${oldStats.entryCount}. New stats entry count: ${newStats.entryCount}`);
	assert.deepStrictEqual(oldStats.entryCount, newStats.entryCount);

	//close old & new environments, manually delete the global reference to the new env
	await environmentUtility.closeEnvironment(oldEnv);
	await environmentUtility.closeEnvironment(newEnv);
	delete global.lmdb_map[`${schema}.${table}`];

	if (deleteOldDb) {
		//delete old environment
		let oldTableDir = path.join(theSchemaPath, table);
		let oldTablePath = path.join(oldTableDir, 'data.mdb');
		let oldLockPath = path.join(oldTableDir, 'lock.mdb');
		await fs.unlink(oldTablePath);
		await fs.unlink(oldLockPath);
		await fs.rmdir(oldTableDir);
		pinoLogger.info(`Deleted old environment files from schema folder: ${oldTablePath}, ${oldLockPath}`);
	}
	//stat the moved env & make sure stats match from before
	let env = await environmentUtility.openEnvironment(theSchemaPath, table);
	let stat = environmentUtility.statDBI(env, hash_attribute);
	pinoLogger.info(`New stats: ${JSON.stringify(newStats)}. New stats after move: ${JSON.stringify(stat)}`);
	assert.deepStrictEqual(stat.entryCount, newStats.entryCount);
	await environmentUtility.closeEnvironment(env);
	delete global.lmdb_map[`${schema}.${table}`];
}

/**
 * Transaction logs are indexed differently to regular records so they need their own insert function.
 * They only get secondary indexes for userName and hashValue.
 * @param txnEnv
 * @param txnObject
 * @returns {Promise<*>}
 */
async function insertTransaction(txnEnv, txnObject) {
	environmentUtility.initializeDBIs(
		txnEnv,
		lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP,
		lmdbTerms.TRANSACTIONS_DBIS
	);
	let txnTimestamp = txnObject.timestamp;
	return txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].ifNoExists(txnTimestamp, () => {
		txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP].put(txnTimestamp, txnObject);
		if (!hdbUtil.isEmpty(txnObject.user_name)) {
			txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME].put(txnObject.user_name, txnTimestamp);
		}
		for (let hashValue of txnObject.hash_values) {
			txnEnv.dbis[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE].put(hashValue, txnTimestamp);
		}
	});
}

/**
 * For each entry we call validate.
 * @param env
 * @param hash
 * @param hashValue
 * @param isTransactionReindex
 */
function validateIndices(env, hash, hashValue, isTransactionReindex) {
	let hashDbi = env.dbis[hash];

	let record = hashDbi.get(hashValue);
	assert.deepStrictEqual(typeof record, 'object');

	let entries;
	if (isTransactionReindex) {
		// For transaction log we only create indices from userName and hash_values, which means we only need to check for those two.
		let tmpObj = {
			[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME]: record.user_name,
			[lmdbTerms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE]: record.hash_values,
		};
		entries = Object.entries(tmpObj);
	} else {
		entries = Object.entries(record);
	}

	for (const [key, value] of entries) {
		if (key !== hash && env.dbis[key] !== undefined && !hdbCommon.isEmptyOrZeroLength(value)) {
			// When validating transaction indices we need to validate each index created for timestamp hash.
			if (isTransactionReindex && key === 'hash_value') {
				for (let j = 0, length = value.length; j < length; j++) {
					let valueValue = value[j];
					validateIndex(env, key, valueValue, hashValue);
				}
			} else {
				validateIndex(env, key, value, hashValue);
			}
		}
	}
}

/**
 * Validates that the entry is in the new index
 * @param env
 * @param key
 * @param value
 * @param hashValue
 */
function validateIndex(env, key, value, hashValue) {
	try {
		let found = false;
		let indexedValues = lmdbCommon.getIndexedValues(value);
		if (!indexedValues) return;
		for (let findValue of indexedValues) {
			found = env.dbis[key].doesExist(findValue, hashValue);
			if (!found) {
				pinoLogger.info(`Validate indices did not find value in new DBI: ${findValue}. Hash: ${hashValue}`);
			}
			assert.deepStrictEqual(found, true);
		}
	} catch (e) {
		errorOccurred = true;
		pinoLogger.error(e);
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
