'use strict';

const lmdb = require('lmdb');
const fs = require('fs-extra');
const path = require('path');
const common = require('./commonUtility.js');
const log = require('../logging/harper_logger.js');
const LMDB_ERRORS = require('../errors/commonErrors.js').LMDB_ERRORS_ENUM;
const DBIDefinition = require('./DBIDefinition.js');
const OpenDBIObject = require('./OpenDBIObject.js');
const OpenEnvironmentObject = require('./OpenEnvironmentObject.js');
const lmdbTerms = require('./terms.js');
const hdbTerms = require('../hdbTerms.ts');
const { table, resetDatabases } = require('../../resources/databases.ts');
const envMngr = require('../environment/environmentManager.js');

const INTERNAL_DBIS_NAME = lmdbTerms.INTERNAL_DBIS_NAME;
const DBI_DEFINITION_NAME = lmdbTerms.DBI_DEFINITION_NAME;
const MDB_LEGACY_FILE_NAME = 'data.mdb';
const MDB_LEGACY_LOCK_FILE_NAME = 'lock.mdb';
const MDB_FILE_EXTENSION = '.mdb';
const MDB_LOCK_FILE_SUFFIX = '-lock';

/**
 * This class is used to create the transaction & cursor objects needed to perform search on a dbi as well as a function to close both objects after use
 */
class TransactionCursor {
	/**
	 * create the TransactionCursor object
	 * @param {lmdb.RootDatabase} env - environment object to create the transaction & cursor from
	 * @param {String} attribute - name of the attribute to create the cursor against
	 * @param {Boolean} [writeCursor] - optional, dictates if the cursor created will be a readOnly cursor or not
	 */
	constructor(env, attribute, writeCursor = false) {
		this.dbi = openDBI(env, attribute);
		this.key_type = this.dbi[lmdbTerms.DBI_DEFINITION_NAME].key_type;
		this.is_hash_attribute = this.dbi[lmdbTerms.DBI_DEFINITION_NAME].is_hash_attribute;
		this.txn = env.beginTxn({ readOnly: writeCursor === false });
		this.cursor = new lmdb.Cursor(this.txn, this.dbi);
	}

	/**
	 * function to close the read cursor & abort the transaction
	 */
	close() {
		this.cursor.close();
		this.txn.abort();
	}

	/**
	 * function to close the read cursor & abort the transaction
	 */
	commit() {
		this.cursor.close();
		this.txn.commit();
	}
}

/***  VALIDATION FUNCTIONS ***/

/**
 * validates the basePath & envName exist.  checks basePath is a valid path
 * @param {String} basePath - top level path the environment folder and the .mdb file live under
 * @param {String} envName - name of environment
 */
function pathEnvNameValidation(basePath, envName) {
	if (basePath === undefined) {
		throw new Error(LMDB_ERRORS.BASE_PATH_REQUIRED);
	}

	if (envName === undefined) {
		throw new Error(LMDB_ERRORS.ENV_NAME_REQUIRED);
	}
}

/**
 * checks the environment file exists and returns its path
 * @param {String} basePath - top level path the environment folder and the .mdb file live under
 * @param {String} envName - name of environment
 * @returns {Promise<string>}
 */
async function validateEnvironmentPath(basePath, envName, allowV3 = true) {
	//verify the basePath is valid
	try {
		await fs.access(basePath);
	} catch (e) {
		if (e.code === 'ENOENT') {
			throw new Error(LMDB_ERRORS.INVALID_BASE_PATH);
		}
		throw e;
	}
	try {
		let standardPath = path.join(basePath, envName + MDB_FILE_EXTENSION);
		await fs.access(standardPath, fs.constants.R_OK | fs.constants.F_OK);
		return standardPath; // success with standard path
	} catch (e) {
		if (e.code === 'ENOENT') {
			if (allowV3) {
				try {
					await fs.access(path.join(basePath, envName, MDB_LEGACY_FILE_NAME), fs.constants.R_OK | fs.constants.F_OK);
					return path.join(basePath, envName);
				} catch (e2) {
					if (e2.code === 'ENOENT') {
						throw new Error(LMDB_ERRORS.INVALID_ENVIRONMENT);
					}
				}
			} else throw new Error(LMDB_ERRORS.INVALID_ENVIRONMENT);
		}

		throw e;
	}
}

/**
 * validates the env & dbiName variables exist
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} dbiName - name of the dbi (KV store)
 */
function validateEnvDBIName(env, dbiName) {
	common.validateEnv(env);

	if (dbiName === undefined) {
		throw new Error(LMDB_ERRORS.DBI_NAME_REQUIRED);
	}
}

/***  ENVIRONMENT FUNCTIONS ***/

/**
 * creates a new environment
 * @param basePath - base path the environment will reside in
 * @param envName - name of the environment
 * @param {Boolean} isTxn - defines if is a transactions environment
 * @returns {Promise<lmdb.RootDatabase>} - LMDB environment object
 */
async function createEnvironment(basePath, envName, isTxn = false, isV3 = false) {
	pathEnvNameValidation(basePath, envName);
	let dbName = path.basename(basePath);

	envName = envName.toString();
	let schemasConfig = envMngr.get(hdbTerms.CONFIG_PARAMS.DATABASES);
	if (!schemasConfig) envMngr.setProperty(hdbTerms.CONFIG_PARAMS.DATABASES, (schemasConfig = {}));
	if (!schemasConfig[dbName]) schemasConfig[dbName] = {};
	schemasConfig[dbName].path = basePath;
	try {
		await validateEnvironmentPath(basePath, envName, isV3);
		//if no error is thrown the environment already exists so we return the handle to that environment
		return openEnvironment(basePath, envName, isTxn);
	} catch (e) {
		if (e.message === LMDB_ERRORS.INVALID_ENVIRONMENT) {
			let environmentPath = path.join(basePath, envName);
			await fs.mkdirp(isV3 ? environmentPath : basePath);
			let envInit = new OpenEnvironmentObject(isV3 ? environmentPath : environmentPath + MDB_FILE_EXTENSION, false);
			let env = lmdb.open(envInit);

			env.dbis = Object.create(null);
			//next we create an internal dbi to track the named databases
			let dbiInit = new OpenDBIObject(false);
			env.openDB(INTERNAL_DBIS_NAME, dbiInit);

			//add environment to global variable to cache reference to environment & named databases
			if (global.lmdb_map === undefined) {
				global.lmdb_map = Object.create(null);
			}
			let fullName = getCachedEnvironmentName(basePath, envName, isTxn);
			env[lmdbTerms.ENVIRONMENT_NAME_KEY] = fullName;
			global.lmdb_map[fullName] = env;

			return env;
		}
		throw e;
	}
}

async function copyEnvironment(basePath, envName, destinationPath, compactEnvironment = true) {
	pathEnvNameValidation(basePath, envName);
	envName = envName.toString();
	let environmentPath = path.join(basePath, envName);
	return table({
		table: envName,
		database: path.parse(basePath).name,
		path: environmentPath,
		attributes: [{ name: 'id', isPrimaryKey: true }],
	});
}

/**
 * opens an environment
 * @returns {lmdb.RootDatabase} - lmdb environment object
 * @param {String} basePath - the base pase under which the envrinment resides
 * @param {String} envName -  the name of the environment
 * @param {Boolean} isTxn - defines if is a transactions environemnt
 */
async function openEnvironment(basePath, envName, isTxn = false) {
	pathEnvNameValidation(basePath, envName);
	envName = envName.toString();
	let fullName = getCachedEnvironmentName(basePath, envName, isTxn);

	if (global.lmdb_map === undefined) {
		global.lmdb_map = Object.create(null);
	}

	if (global.lmdb_map[fullName] !== undefined) {
		return global.lmdb_map[fullName];
	}
	let envPath = await validateEnvironmentPath(basePath, envName);
	let standardPath = path.join(basePath, envName + MDB_FILE_EXTENSION);
	let readOnly = envPath != standardPath; // legacy database, only open in read only mode
	let envInit = new OpenEnvironmentObject(envPath, readOnly);
	let env = lmdb.open(envInit);

	env.dbis = Object.create(null);

	let dbis = listDBIs(env);
	for (let x = 0; x < dbis.length; x++) {
		openDBI(env, dbis[x]);
	}
	env[lmdbTerms.ENVIRONMENT_NAME_KEY] = fullName;
	global.lmdb_map[fullName] = env;

	return env;
}

/**
 * deletes the environment from the file system & removes the reference from global
 * @param {String} basePath - top level path the environment folder and the .mdb file live under
 * @param {String} envName - name of environment
 * @param {Boolean} isTxn - defines if is a transactions environemnt
 */
async function deleteEnvironment(basePath, envName, isTxn = false) {
	pathEnvNameValidation(basePath, envName);
	envName = envName.toString();
	let standardPath = path.join(basePath, envName + MDB_FILE_EXTENSION);
	let dataPath = await validateEnvironmentPath(basePath, envName);

	if (global.lmdb_map !== undefined) {
		let fullName = getCachedEnvironmentName(basePath, envName, isTxn);
		if (global.lmdb_map[fullName]) {
			let env = global.lmdb_map[fullName];
			await closeEnvironment(env);
			delete global.lmdb_map[fullName];
		}
	}
	await fs.remove(dataPath);
	await fs.remove(
		dataPath === standardPath
			? dataPath + MDB_LOCK_FILE_SUFFIX
			: path.join(path.dirname(dataPath), MDB_LEGACY_LOCK_FILE_NAME)
	); // I suspect we may have problems with this on Windows
}

/**
 * takes an environment and closes it
 * @param {lmdb.RootDatabase} env
 */
async function closeEnvironment(env) {
	//make sure env is actually a reference to the lmdb environment class so we don't blow anything up
	common.validateEnv(env);
	let environmentName = env[lmdbTerms.ENVIRONMENT_NAME_KEY];
	//we need to close the environment to release the file from the process
	await env.close();
	if (environmentName !== undefined && global.lmdb_map !== undefined) {
		delete global.lmdb_map[environmentName];
	}
}

/**
 * creates a composite name for the environment based on the parent folder name & the environment name.
 * This forces uniqueness when same environment names live under different parent folders
 * @param {String} basePath
 * @param {String} envName
 * @param {Boolean} isTxn - defines if is a transactions environemnt
 * @returns {string}
 */
function getCachedEnvironmentName(basePath, envName, isTxn = false) {
	let schemaName = path.basename(basePath);
	let fullName = `${schemaName}.${envName}`;
	if (isTxn === true) {
		fullName = `txn.${fullName}`;
	}
	return fullName;
}

/***  DBI FUNCTIONS ***/

/**
 * lists dbis in a map with their defintition as the value
 * @param {lmdb.RootDatabase} env - environment object used high level to interact with all data in an environment
 * @returns {{String, DBIDefinition}}
 */
function listDBIDefinitions(env) {
	common.validateEnv(env);

	let dbis = Object.create(null);

	let dbi = openDBI(env, INTERNAL_DBIS_NAME);
	for (let { key, value } of dbi.getRange({ start: false })) {
		if (key !== INTERNAL_DBIS_NAME) {
			try {
				dbis[key] = Object.assign(new DBIDefinition(), value);
			} catch (e) {
				log.warn(`an internal error occurred: unable to parse DBI Definition for ${key}`);
			}
		}
	}
	return dbis;
}

/**
 * lists all dbis in an environment
 * @param {lmdb.RootDatabase} env - environment object used high level to interact with all data in an environment
 * @returns {[String]}
 */
function listDBIs(env) {
	common.validateEnv(env);

	let dbis = [];

	let dbi = openDBI(env, INTERNAL_DBIS_NAME);

	for (let { key } of dbi.getRange({ start: false })) {
		if (key !== INTERNAL_DBIS_NAME) {
			dbis.push(key);
		}
	}
	return dbis;
}

/**
 * fetches an individual dbi definition from the internal dbi
 * @param {lmdb.RootDatabase} env
 * @param dbiName
 * @returns {undefined|DBIDefinition}
 */
function getDBIDefinition(env, dbiName) {
	let dbi = openDBI(env, INTERNAL_DBIS_NAME);

	let found = dbi.getEntry(dbiName);
	let dbiDefinition = new DBIDefinition();

	if (found === undefined) {
		return;
	}

	try {
		dbiDefinition = Object.assign(dbiDefinition, found.value);
	} catch (e) {
		log.warn(`an internal error occurred: unable to parse DBI Definition for ${found}`);
	}

	return dbiDefinition;
}

/**
 * creates a new named database in an environment
 * @param {lmdb.RootDatabase} env - environment object used high level to interact with all data in an environment
 * @param {String} dbiName - name of the dbi (KV store)
 * @param {Boolean} [dupSort] - optional, determines if the dbi allows duplicate keys or not
 * @param {Boolean} isHashAttribute - defines if the dbi being created is the hash_attribute fro the environment / table
 * @returns {*} - reference to the dbi
 */
function createDBI(env, dbiName, dupSort, isHashAttribute = !dupSort) {
	validateEnvDBIName(env, dbiName);
	dbiName = dbiName.toString();
	if (dbiName === INTERNAL_DBIS_NAME) {
		throw new Error(LMDB_ERRORS.CANNOT_CREATE_INTERNAL_DBIS_NAME);
	}
	/*if (isHashAttribute) return; // should already be created
	return env.addAttribute({ name: dbiName, indexed: true });*/

	try {
		//first check if the dbi exists
		return openDBI(env, dbiName);
	} catch (e) {
		//if not create it
		if (e.message === LMDB_ERRORS.DBI_DOES_NOT_EXIST) {
			//we version just the hash attribute index
			let dbiInit = new OpenDBIObject(dupSort, isHashAttribute === true);

			let newDbi = env.openDB(dbiName, dbiInit);

			let dbiDefinition = new DBIDefinition(dupSort === true, isHashAttribute);
			newDbi[DBI_DEFINITION_NAME] = dbiDefinition;

			let dbis = openDBI(env, INTERNAL_DBIS_NAME);
			dbis.putSync(dbiName, dbiDefinition);

			env.dbis[dbiName] = newDbi;

			return newDbi;
		}

		throw e;
	}
}

/**
 * opens an existing named database from an environment
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbiName - name of the dbi (KV store)
 * @returns {lmdb.Database} - returns reference to the dbi
 */
function openDBI(env, dbiName) {
	validateEnvDBIName(env, dbiName);
	dbiName = dbiName.toString();
	if (env.dbis[dbiName] !== undefined) {
		return env.dbis[dbiName];
	}

	let dbiDefinition;
	if (dbiName !== INTERNAL_DBIS_NAME) {
		dbiDefinition = getDBIDefinition(env, dbiName);
	} else {
		dbiDefinition = new DBIDefinition();
	}
	if (dbiDefinition === undefined) {
		throw new Error(LMDB_ERRORS.DBI_DOES_NOT_EXIST);
	}

	let dbi;
	try {
		let dbiInit = new OpenDBIObject(dbiDefinition.dup_sort, dbiDefinition.useVersions);
		dbi = env.openDB(dbiName, dbiInit);
		//current version of lmdb no longer throws an error if you attempt to open a non-existent dbi, simulating old behavior
		if (dbi.db === undefined) {
			throw new Error('MDB_NOTFOUND');
		}
	} catch (e) {
		if (e.message.includes('MDB_NOTFOUND') === true) {
			throw new Error(LMDB_ERRORS.DBI_DOES_NOT_EXIST);
		}

		throw e;
	}
	dbi[DBI_DEFINITION_NAME] = dbiDefinition;
	env.dbis[dbiName] = dbi;
	return dbi;
}

/**
 * gets the statistics for a named database from the environment
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbiName - name of the dbi (KV store)
 * @returns {void | Promise<Stats> | *} - object holding stats for the dbi
 */
function statDBI(env, dbiName) {
	validateEnvDBIName(env, dbiName);
	dbiName = dbiName.toString();
	let dbi = openDBI(env, dbiName);

	let stats = dbi.getStats();
	if (dbi[lmdbTerms.DBI_DEFINITION_NAME].is_hash_attribute && stats.entryCount > 0) {
		stats.entryCount--;
	}

	return stats;
}

/**
 * gets the byte size of an environment file
 * @param {String} environmentBasePath
 * @param {String} tableName
 * @returns {Promise<number>}
 */
async function environmentDataSize(environmentBasePath, tableName) {
	try {
		let environmentPath = path.join(environmentBasePath, tableName + MDB_FILE_EXTENSION);
		let statResult = await fs.stat(environmentPath);
		return statResult['size'];
	} catch (e) {
		throw new Error(LMDB_ERRORS.INVALID_ENVIRONMENT);
	}
}

/**
 * removes a named database from an environment
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbiName - name of the dbi (KV store)
 */
function dropDBI(env, dbiName) {
	validateEnvDBIName(env, dbiName);
	dbiName = dbiName.toString();
	if (dbiName === INTERNAL_DBIS_NAME) {
		throw new Error(LMDB_ERRORS.CANNOT_DROP_INTERNAL_DBIS_NAME);
	}

	let dbi = openDBI(env, dbiName);
	dbi.dropSync();

	if (env.dbis !== undefined) {
		delete env.dbis[dbiName];
	}

	let dbis = openDBI(env, INTERNAL_DBIS_NAME);
	dbis.removeSync(dbiName);
}

/**
 * opens/ creates all specified attributes
 * @param {lmdb.RootDatabase} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} writeAttributes - list of all attributes to write to the database
 */
function initializeDBIs(env, hash_attribute, writeAttributes) {
	let createdAttributes;
	for (let x = 0; x < writeAttributes.length; x++) {
		let attribute = writeAttributes[x];

		//check the internal cache to see if the dbi has been intialized
		if (!env.dbis[attribute]) {
			//if the dbi has not been intialized & cached attempt to open
			try {
				openDBI(env, attribute);
			} catch (e) {
				//if not opened, create it
				if (e.message === LMDB_ERRORS.DBI_DOES_NOT_EXIST) {
					createDBI(env, attribute, attribute !== hash_attribute, attribute === hash_attribute);
					createdAttributes = true;
				} else {
					throw e;
				}
			}
		}
	}
	if (createdAttributes) resetDatabases();
}

module.exports = {
	openDBI,
	openEnvironment,
	createEnvironment,
	listDBIs,
	listDBIDefinitions,
	createDBI,
	dropDBI,
	statDBI,
	deleteEnvironment,
	initializeDBIs,
	TransactionCursor,
	environmentDataSize,
	copyEnvironment,
	closeEnvironment,
};
