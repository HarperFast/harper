"use strict";

const lmdb = require('node-lmdb');
const fs = require('fs-extra');
const path = require('path');
const common = require('./commonUtility');
const log = require('../logging/harper_logger');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const DBIDefinition = require('./DBIDefinition');
const OpenDBIObject = require('./OpenDBIObject');
const OpenEnvironmentObject = require('./OpenEnvironmentObject');
const lmdb_terms = require('./terms');
const promisify = require('util').promisify;
//allow an environment to grow up to 100Gb
// eslint-disable-next-line no-magic-numbers
const MAP_SIZE = 100 * 1024 * 1024 * 1024;
//allow up to 1,000 named data bases in an environment
const MAX_DBS = 1000;
const MAX_READERS = 1000;
const INTERNAL_DBIS_NAME = lmdb_terms.INTERNAL_DBIS_NAME;
const DBI_DEFINITION_NAME = lmdb_terms.DBI_DEFINITION_NAME;
const MDB_FILE_NAME = 'data.mdb';

/**
 * This class is used to create the transaction & cursor objects needed to perform search on a dbi as well as a function to close both objects after use
 */
class TransactionCursor{
    /**
     * create the TransactionCursor object
     * @param {lmdb.Env} env - environment object to create the transaction & cursor from
     * @param {String} attribute - name of the attribute to create the cursor against
     * @param {Boolean} [write_cursor] - optional, dictates if the cursor created will be a readOnly cursor or not
     */
    constructor(env, attribute, write_cursor = false) {
        this.dbi = openDBI(env, attribute);
        this.key_type = this.dbi[lmdb_terms.DBI_DEFINITION_NAME].key_type;
        this.is_hash_attribute = this.dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute;
        this.txn = env.beginTxn({ readOnly: write_cursor === false });
        this.cursor = new lmdb.Cursor(this.txn, this.dbi);
    }

    /**
     * function to close the read cursor & abort the transaction
     */
    close(){
        this.cursor.close();
        this.txn.abort();
    }

    /**
     * function to close the read cursor & abort the transaction
     */
    commit(){
        this.cursor.close();
        this.txn.commit();
    }
}

/***  VALIDATION FUNCTIONS ***/

/**
 * validates the base_path & env_name exist.  checks base_path is a valid path
 * @param {String} base_path - top level path the environment folder and the data.mdb file live under
 * @param {String} env_name - name of environment
 */
async function pathEnvNameValidation(base_path, env_name){
    if(base_path === undefined){
        throw new Error(LMDB_ERRORS.BASE_PATH_REQUIRED);
    }

    if(env_name === undefined){
        throw new Error(LMDB_ERRORS.ENV_NAME_REQUIRED);
    }

    //verify the base_path is valid
    try {
        await fs.access(base_path);
    } catch(e){
        if(e.code === 'ENOENT'){
            throw new Error(LMDB_ERRORS.INVALID_BASE_PATH);
        }

        throw e;
    }
}

/**
 * checks the environment file exists
 * @param {String} base_path - top level path the environment folder and the data.mdb file live under
 * @param {String} env_name - name of environment
 * @returns {Promise<void>}
 */
async function validateEnvironmentPath(base_path, env_name){
    try {
        await fs.access(path.join(base_path, env_name, MDB_FILE_NAME), fs.constants.R_OK | fs.constants.F_OK);
    } catch(e){
        if(e.code === 'ENOENT'){
            throw new Error(LMDB_ERRORS.INVALID_ENVIRONMENT);
        }

        throw e;
    }
}

/**
 * validates the env & dbi_name variables exist
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} dbi_name - name of the dbi (KV store)
 */
function validateEnvDBIName(env, dbi_name){
    common.validateEnv(env);

    if(dbi_name === undefined){
        throw new Error(LMDB_ERRORS.DBI_NAME_REQUIRED);
    }
}

/***  ENVIRONMENT FUNCTIONS ***/

/**
 * creates a new environment
 * @param base_path - base path the envirnment will reside in
 * @param env_name - name of the environment
 * @param {Boolean} is_txn - defines if is a transactions environemnt
 * @returns {Promise<lmdb.Env>} - LMDB environment object
 */
async function createEnvironment(base_path, env_name, is_txn = false) {
    await pathEnvNameValidation(base_path, env_name);
    env_name = env_name.toString();
    try {
        await fs.access(path.join(base_path, env_name, MDB_FILE_NAME), fs.constants.R_OK | fs.constants.F_OK);
        //if no error is thrown the environment already exists so we return the handle to that environment
        return await openEnvironment(base_path, env_name, is_txn);
    } catch(e){
        if (e.code === 'ENOENT'){
            let environment_path = path.join(base_path, env_name);
            await fs.mkdirp(environment_path);
            let env = new lmdb.Env();
            let env_init = new OpenEnvironmentObject(environment_path, MAP_SIZE, MAX_DBS, true, true, MAX_READERS);
            env.open(env_init);

            env.dbis = Object.create(null);
            //next we create an internal dbi to track the named databases
            let dbi_init = new OpenDBIObject(INTERNAL_DBIS_NAME, true, false, lmdb_terms.DBI_KEY_TYPES.STRING);
            let dbi = env.openDbi(dbi_init);

            dbi.close();

            createDBI(env, lmdb_terms.BLOB_DBI_NAME, false, lmdb_terms.DBI_KEY_TYPES.STRING, false);

            //add environment to global variable to cache reference to environment & named databases
            if(global.lmdb_map === undefined) {
                global.lmdb_map = Object.create(null);
            }
            let full_name = getCachedEnvironmentName(base_path, env_name, is_txn);
            env[lmdb_terms.ENVIRONMENT_NAME_KEY] = full_name;
            global.lmdb_map[full_name] = env;

            return env;
        }
        throw e;
    }
}

async function copyEnvironment(base_path, env_name, destination_path, compact_environment = true){
    let env = await openEnvironment(base_path, env_name);

    if(destination_path === undefined){
        throw new Error(LMDB_ERRORS.DESTINATION_PATH_REQUIRED);
    }

    //verify the destination_path is valid
    try {
        await fs.access(destination_path);
    } catch(e){
        if(e.code === 'ENOENT'){
            throw new Error(LMDB_ERRORS.INVALID_DESTINATION_PATH);
        }

        throw e;
    }
    let p_environment_copy = promisify(env.copy).bind(env);

    await p_environment_copy(destination_path, compact_environment);
}

/**
 * opens an environment
 * @returns {lmdb.Env} - lmdb environment object
 * @param {String} base_path - the base pase under which the envrinment resides
 * @param {String} env_name -  the name of the environment
 * @param {Boolean} is_txn - defines if is a transactions environemnt
 */
async function openEnvironment(base_path, env_name, is_txn = false){
    await pathEnvNameValidation(base_path, env_name);
    env_name = env_name.toString();
    let full_name = getCachedEnvironmentName(base_path, env_name, is_txn);

    if(global.lmdb_map === undefined) {
        global.lmdb_map = Object.create(null);
    }

    if(global.lmdb_map[full_name] !== undefined){
        return global.lmdb_map[full_name];
    }

    await validateEnvironmentPath(base_path, env_name);

    let env = new lmdb.Env();
    let env_path = path.join(base_path, env_name);
    let env_init = new OpenEnvironmentObject(env_path, MAP_SIZE, MAX_DBS, true, true, MAX_READERS);
    env.open(env_init);

    env.dbis = Object.create(null);

    let dbis = listDBIs(env);
    for(let x = 0; x < dbis.length; x++){
        openDBI(env, dbis[x]);
    }
    env[lmdb_terms.ENVIRONMENT_NAME_KEY] = full_name;
    global.lmdb_map[full_name] = env;

    return env;
}

/**
 * deletes the environment from the file system & removes the reference from global
 * @param {String} base_path - top level path the environment folder and the data.mdb file live under
 * @param {String} env_name - name of environment
 * @param {Boolean} is_txn - defines if is a transactions environemnt
 */
async function deleteEnvironment(base_path, env_name, is_txn = false) {
    await pathEnvNameValidation(base_path, env_name);
    env_name = env_name.toString();
    await validateEnvironmentPath(base_path, env_name);

    await fs.remove(path.join(base_path, env_name));
    if(global.lmdb_map !== undefined) {
        let full_name = getCachedEnvironmentName(base_path, env_name, is_txn);
        if(global.lmdb_map[full_name]){
            let env = global.lmdb_map[full_name];
            closeEnvironment(env);
            delete global.lmdb_map[full_name];
        }
    }
}

/**
 * takes an environment and closes it
 * @param env
 */
function closeEnvironment(env){
    //make sure env is actually a reference to the lmdb environment class so we don't blow anything up
    if(env && env.constructor && env.constructor.name === 'Env') {
        //we need to close the environment to release the file from the process
        env.close();
    }
}

/**
 * creates a composite name for the environment based on the parent folder name & the environment name.
 * This forces uniqueness when same environment names live under different parent folders
 * @param {String} base_path
 * @param {String} env_name
 * @param {Boolean} is_txn - defines if is a transactions environemnt
 * @returns {string}
 */
function getCachedEnvironmentName(base_path, env_name, is_txn = false){
    let schema_name = path.basename(base_path);
    let full_name = `${schema_name}.${env_name}`;
    if(is_txn === true){
        full_name = `txn.${full_name}`;
    }
    return full_name;
}

/***  DBI FUNCTIONS ***/

/**
 * lists dbis in a map with their defintition as the value
 * @param {lmdb.Env} env - environment object used high level to interact with all data in an environment
 * @returns {{String, DBIDefinition}}
 */
function listDBIDefinitions(env){
    let txn = undefined;
    try {
        common.validateEnv(env);

        let dbis = Object.create(null);

        txn = new TransactionCursor(env, INTERNAL_DBIS_NAME);

        for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
            if (found !== INTERNAL_DBIS_NAME) {
                try {
                    dbis[found] = Object.assign(new DBIDefinition(), JSON.parse(txn.cursor.getCurrentString()));
                } catch (e) {
                    log.warn(`an internal error occurred: unable to parse DBI Definition for ${found}`);
                }
            }
        }

        txn.close();
        return dbis;
    }catch (e) {
        if(txn !== undefined){
            txn.close();
        }
        throw e;
    }
}

/**
 * lists all dbis in an environment
 * @param {lmdb.Env} env - environment object used high level to interact with all data in an environment
 * @returns {[String]}
 */
function listDBIs(env){
    let txn = undefined;
    try {
        common.validateEnv(env);

        let dbis = [];

        txn = new TransactionCursor(env, INTERNAL_DBIS_NAME);

        for (let found = txn.cursor.goToFirst(); found !== null; found = txn.cursor.goToNext()) {
            if (found !== INTERNAL_DBIS_NAME) {
                dbis.push(found);
            }
        }
        txn.close();
        return dbis;
    }catch(e){
        if(txn !== undefined){
            txn.close();
        }

        throw e;
    }
}

/**
 * fetches an individual dbi definition from the internal dbi
 * @param env
 * @param dbi_name
 * @returns {DBIDefinition}
 */
function getDBIDefinition(env, dbi_name){
    let txn = undefined;
    try {
        txn = new TransactionCursor(env, INTERNAL_DBIS_NAME);

        let dbi_definition = new DBIDefinition();
        let found = txn.cursor.goToKey(dbi_name);
        if (found === null) {
            txn.close();
            return dbi_definition;
        }

        try {
            dbi_definition = Object.assign(dbi_definition, JSON.parse(txn.cursor.getCurrentString()));
        } catch (e) {
            log.warn(`an internal error occurred: unable to parse DBI Definition for ${found}`);
        }

        txn.close();
        return dbi_definition;
    }catch (e) {
        if(txn !== undefined){
            txn.close();
        }
        throw e;
    }
}

/**
 * creates a new named database in an environment
 * @param {lmdb.Env} env - environment object used high level to interact with all data in an environment
 * @param {String} dbi_name - name of the dbi (KV store)
 * @param {Boolean} [dup_sort] - optional, determines if the dbi allows duplicate keys or not
 * @param {lmdb_terms.DBI_KEY_TYPES} [key_type] - optional, dictates what data format the of the key, default is string
 * @param {Boolean} is_hash_attribute - defines if the dbi being created is the hash_attribute fro the environment / table
 * @returns {*} - reference to the dbi
 */
function createDBI(env, dbi_name, dup_sort, key_type, is_hash_attribute= false){
    validateEnvDBIName(env, dbi_name);
    dbi_name = dbi_name.toString();
    if(dbi_name === INTERNAL_DBIS_NAME){
        throw new Error(LMDB_ERRORS.CANNOT_CREATE_INTERNAL_DBIS_NAME);
    }

    try {
        //first check if the dbi exists
        return openDBI(env, dbi_name);
    } catch(e) {
        //if not create it
        if(e.message === LMDB_ERRORS.DBI_DOES_NOT_EXIST) {
            let dbi_init = new OpenDBIObject(dbi_name, true, dup_sort, key_type);
            let new_dbi = env.openDbi(dbi_init);

            let dbi_definition = new DBIDefinition(dup_sort === true, key_type, is_hash_attribute);
            new_dbi[DBI_DEFINITION_NAME] = dbi_definition;

            let dbis = openDBI(env, INTERNAL_DBIS_NAME);
            let txn = env.beginTxn();
            txn.putString(dbis, dbi_name, JSON.stringify(dbi_definition));
            txn.commit();

            env.dbis[dbi_name] = new_dbi;

            return new_dbi;
        }

        throw e;
    }
}

/**
 * opens an existing named database from an environment
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbi_name - name of the dbi (KV store)
 * @returns {*} - returns reference to the dbi
 */
function openDBI(env, dbi_name){
    validateEnvDBIName(env, dbi_name);
    dbi_name = dbi_name.toString();
    if(env.dbis[dbi_name] !== undefined){
        return env.dbis[dbi_name];
    }

    let dbi_definition = new DBIDefinition();
    if(dbi_name !== INTERNAL_DBIS_NAME){
        dbi_definition = getDBIDefinition(env, dbi_name);
    }

    let dbi;
    try {
        let dbi_init = new OpenDBIObject(dbi_name, false, dbi_definition.dup_sort, dbi_definition.key_type);
        dbi = env.openDbi(dbi_init);
    } catch(e){
        if(e.message.startsWith('MDB_NOTFOUND') === true){
            throw new Error(LMDB_ERRORS.DBI_DOES_NOT_EXIST);
        }

        throw e;
    }
    dbi[DBI_DEFINITION_NAME] = dbi_definition;
    env.dbis[dbi_name] = dbi;
    return dbi;
}

/**
 * gets the statistics for a named database from the environment
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbi_name - name of the dbi (KV store)
 * @returns {void | Promise<Stats> | *} - object holding stats for the dbi
 */
function statDBI(env, dbi_name){
    validateEnvDBIName(env, dbi_name);
    dbi_name = dbi_name.toString();
    let dbi = openDBI(env, dbi_name);
    let txn = env.beginTxn();
    let stats = dbi.stat(txn);
    txn.abort();
    return stats;
}

/**
 * gets the byte size of an environment file
 * @param {String} environment_base_path
 * @param {String} table_name
 * @returns {Promise<number>}
 */
async function environmentDataSize(environment_base_path, table_name){
    try {
        let environment_path = path.join(environment_base_path, table_name, MDB_FILE_NAME);
        let stat_result = await fs.stat(environment_path);
        return stat_result["size"];
    }catch(e){
        throw new Error(LMDB_ERRORS.INVALID_ENVIRONMENT);
    }
}

/**
 * removes a named database from an environment
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbi_name - name of the dbi (KV store)
 */
function dropDBI(env, dbi_name){
    validateEnvDBIName(env, dbi_name);
    dbi_name = dbi_name.toString();
    if(dbi_name === INTERNAL_DBIS_NAME){
        throw new Error(LMDB_ERRORS.CANNOT_DROP_INTERNAL_DBIS_NAME);
    }

    let dbi = openDBI(env, dbi_name);
    dbi.drop();

    if(env.dbis !== undefined){
        delete env.dbis[dbi_name];
    }

    let dbis = openDBI(env, INTERNAL_DBIS_NAME);
    let txn = env.beginTxn();
    txn.del(dbis, dbi_name);
    txn.commit();
}

/**
 * opens/ creates all specified attributes
 * @param {lmdb.Env} env - lmdb environment object
 * @param {String} hash_attribute - name of the table's hash attribute
 * @param {Array.<String>} write_attributes - list of all attributes to write to the database
 */
function initializeDBIs(env, hash_attribute, write_attributes){
    for(let x = 0; x < write_attributes.length; x++){
        let attribute = write_attributes[x];

        //check the internal cache to see if the dbi has been intialized
        if(!env.dbis[attribute]) {
            //if the dbi has not been intialized & cached attempt to open
            try {
                openDBI(env, attribute);
            } catch (e) {
                //if not opened, create it
                if (e.message === LMDB_ERRORS.DBI_DOES_NOT_EXIST) {
                    let key_type = lmdb_terms.TIMESTAMP_NAMES.indexOf(attribute) >=0 ? lmdb_terms.DBI_KEY_TYPES.NUMBER : lmdb_terms.DBI_KEY_TYPES.STRING;
                    createDBI(env, attribute, attribute !== hash_attribute, key_type, attribute === hash_attribute);
                } else {
                    throw e;
                }
            }
        }
    }
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
    closeEnvironment
};
