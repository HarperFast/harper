"use strict";

const lmdb = require('node-lmdb');
const fs = require('fs-extra');
const path = require('path');

//allow an environment to grow up to 1 TB
const MAP_SIZE = 1000 * 1024 * 1024 * 1024;
//allow up to 10,000 named data bases in an environment
const MAX_DBS = 10000;
const INTERNAL_DBIS_NAME = '__dbis__';
const MDB_FILE_NAME = 'data.mdb';

/***  VALIDATION FUNCTIONS ***/

/**
 * validates the base_path & env_name exist.  checks base_path is a valid path
 * @param {String} base_path - top level path the environment folder and the data.mdb file live under
 * @param {String} env_name - name of environment
 */
async function pathEnvNameValidation(base_path, env_name){
    if(base_path === undefined){
        throw new Error('base_path is required');
    }

    if(env_name === undefined){
        throw new Error('env_name is required');
    }

    //verify the base_path is valid
    try {
        await fs.access(base_path);
    } catch(e){
        if(e.code === 'ENOENT'){
            throw new Error('invalid base_path');
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
            throw new Error('invalid environment');
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
    if(env === undefined){
        throw new Error('env is required');
    }

    if(dbi_name === undefined){
        throw new Error('dbi_name is required');
    }
}

/***  ENVIRONMENT FUNCTIONS ***/

/**
 * creates a new environment
 * @param base_path - base path the envirnment will reside in
 * @param env_name - name of the environment
 * @returns {Promise<lmdb.Env>} - LMDB environment object
 */
async function createEnvironment(base_path, env_name) {
    await pathEnvNameValidation(base_path, env_name);

    try {
        await fs.access(path.join(base_path, env_name, MDB_FILE_NAME), fs.constants.R_OK | fs.constants.F_OK);
        //if no error is thrown the environment already exists so we return the handle to that environment
        return await openEnvironment(base_path, env_name);
    } catch(e){
        if (e.code === 'ENOENT'){
            await fs.mkdirp(path.join(base_path, env_name));
            let env = new lmdb.Env();
            env.open({
                path: path.join(base_path, env_name),
                mapSize: MAP_SIZE,
                maxDbs: MAX_DBS,
                noMetaSync: true,
                noSync: true
            });

            env.dbis = Object.create(null);
            //next we create an internal dbi to track the named databases
            let dbi = env.openDbi({
                name: INTERNAL_DBIS_NAME,
                create: true,
                dupSort: false
            });

            dbi.close();

            //add environment to global variable to cache reference to environment & named databases
            if(global.lmdb_map === undefined) {
                global.lmdb_map = Object.create(null);
            }

            global.lmdb_map[env_name] = env;

            return env;
        }
        throw e;
    }
}

/**
 * opens an environment
 * @returns {lmdb.Env} - lmdb environment object
 * @param {String} base_path - the base pase under which the envrinment resides
 * @param {String} env_name -  the name of the environment
 */
async function openEnvironment(base_path, env_name){
    await pathEnvNameValidation(base_path, env_name);

    await validateEnvironmentPath(base_path, env_name);

    if(global.lmdb_map === undefined) {
        global.lmdb_map = Object.create(null);
    }

    if(global.lmdb_map[env_name] !== undefined){
        return global.lmdb_map[env_name];
    }

    let env = new lmdb.Env();
    env.open({
        path: path.join(base_path, env_name),
        maxDbs: MAX_DBS,
        mapSize: MAP_SIZE,
        noMetaSync: true,
        noSync: true
    });

    env.dbis = Object.create(null);

    let dbis = listDBIs(env);

    dbis.forEach(dbi=>{
        openDBI(env, dbi);
    });

    global.lmdb_map[env_name] = env;

    return env;
}


/**
 * deletes the environment from the file system & removes the reference from global
 * @param {String} base_path - top level path the environment folder and the data.mdb file live under
 * @param {String} env_name - name of environment
 */
async function deleteEnvironment(base_path, env_name) {
    await pathEnvNameValidation(base_path, env_name);
    await validateEnvironmentPath(base_path, env_name);

    await fs.remove(path.join(base_path, env_name));
    if(global.lmdb_map !== undefined) {
        delete global.lmdb_map[env_name];
    }
}

/***  DBI FUNCTIONS ***/

/**
 * lists & stats named databases in an environment
 * @param {lmdb.Env} env - environment object used high level to interact with all data in an environment
 * @returns {[String]} - list of dbi names in the environment
 */
function listDBIs(env){
    if(env === undefined){
        throw new Error('env is required');
    }

    let dbis = [];

    let default_dbi = openDBI(env, INTERNAL_DBIS_NAME);
//TODO implement TransactionCursor
    let txn = env.beginTxn({readOnly: true });

    let cursor = new lmdb.Cursor(txn, default_dbi);

    for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
        if(found !== INTERNAL_DBIS_NAME) {
            dbis.push(found);
        }
    }

    return dbis;
}

/**
 * creates a new named database in an environment
 * @param {lmdb.Env} env - environment object used high level to interact with all data in an environment
 * @param {String} dbi_name - name of the dbi (KV store)
 * @param {Boolean} [dup_sort] - optional, determines if the dbi allows duplicate keys or not
 * @returns {*} - reference to the dbi
 */
function createDBI(env, dbi_name, dup_sort){
    validateEnvDBIName(env, dbi_name);

    let new_dbi = env.openDbi({
        name: dbi_name,
        create: true,
        dupSort: dup_sort === true
    });

    let dbis = openDBI(env, INTERNAL_DBIS_NAME);
    let txn = env.beginTxn();
    txn.putString(dbis, dbi_name, dbi_name);
    txn.commit();

    env.dbis[dbi_name] = new_dbi;

    return new_dbi;
}

/**
 * opens an existing named database from an environment
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbi_name - name of the dbi (KV store)
 * @returns {*} - returns reference to the dbi
 */
function openDBI(env, dbi_name){
    validateEnvDBIName(env, dbi_name);

    if(env.dbis[dbi_name] !== undefined){
        return env.dbis[dbi_name];
    }

    let dbi;
    try {
        dbi = env.openDbi({
            name: dbi_name,
            create: false,
            dupSort: true
        });
    } catch(e){
        if(e.message.startsWith('MDB_NOTFOUND') === true){
            throw new Error('dbi does not exist');
        }

        throw e;
    }

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
    let dbi = openDBI(env, dbi_name);
    let txn = env.beginTxn();
    let stats = dbi.stat(txn);
    txn.abort();
    return stats;
}

/**
 * removes a named database from an environment
 * @param {lmdb.Env} env - environment object used thigh level to interact with all data in an environment
 * @param {String} dbi_name - name of the dbi (KV store)
 */
function dropDBI(env, dbi_name){
    validateEnvDBIName(env, dbi_name);

    let dbi = openDBI(env, dbi_name);
    dbi.drop();

    if(env.dbis !== undefined){
        delete env.dbis[dbi_name];
    }

    //TODO implemenmt delete function when it's created
    let dbis = openDBI(env, INTERNAL_DBIS_NAME);
    let txn = env.beginTxn();
    txn.del(dbis, dbi_name);
    txn.commit();
}

module.exports = {
    openDBI,
    openEnvironment,
    createEnvironment,
    listDBIs,
    createDBI,
    dropDBI,
    statDBI,
    deleteEnvironment
};