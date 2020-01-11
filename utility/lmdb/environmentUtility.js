"use strict";

const lmdb = require('node-lmdb');
const fs = require('fs-extra');
const path = require('path');

//allow an environment to grow up to 1 TB
const MAP_SIZE = 1000 * 1024 * 1024 * 1024;
//allow up to 10,000 named data bases in an environment
const MAX_DBS = 10000;
const INTERNAL_DBIS_NAME = '__dbis__';

/**
 * creates a new environment
 * @param base_path - base path the envirnment will reside in
 * @param env_name - name of the environment
 * @returns {Promise<lmdb.Env>} - LMDB environment object
 */
async function createEnvironment(base_path, env_name) {
    try {
        await fs.access(path.join(base_path, env_name, 'data.mdb'), fs.constants.R_OK | fs.constants.F_OK);
        //if no error is thrown the environment already exists so we return the handle to that environment
        return openEnvironment(base_path, env_name);
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
 * @returns {lmdb.Env}
 * @param base_path - the base pase under which the envrinment resides
 * @param env_name -  the name of the environment
 */
function openEnvironment(base_path, env_name){
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

    Object.keys(dbis).forEach(dbi=>{
        openDBI(env, dbi);
    });

    global.lmdb_map[env_name] = env;

    return env;
}

/**
 * deletes the environment from the file system & removes the reference from global
 * @param base_path
 * @param env_name
 * @returns {Promise<void>}
 */
async function deleteEnvironment(base_path, env_name) {
    await fs.remove(path.join(base_path, env_name));
    if(global.lmdb_map !== undefined) {
        delete global.lmdb_map[env_name];
    }
}


/**
 * lists & stats named databases in an environment
 * @param env - environment object
 * @returns {[]}
 */
function listDBIs(env){
    let dbis = {};

    let default_dbi = env.openDbi({
        name:INTERNAL_DBIS_NAME,
        create: false
    });

    let txn = env.beginTxn({readOnly: true });

    let cursor = new lmdb.Cursor(txn, default_dbi);

    for (let found = cursor.goToFirst(); found !== null; found = cursor.goToNext()) {
        let dbi_name = cursor.getCurrentString();
        if(dbi_name !== INTERNAL_DBIS_NAME) {
            dbis[dbi_name] = statDBI(env, dbi_name);
        }
    }

    return dbis;
}

/**
 * creates a new named database in an environment
 * @param env
 * @param dbi_name
 * @returns {*}
 */
function createDBI(env, dbi_name){
    let new_dbi = env.openDbi({
        name: dbi_name,
        create: true,
        dupSort: true
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
 * @param env
 * @param dbi_name
 * @returns {*}
 */
function openDBI(env, dbi_name){
    if(env.dbis[dbi_name] !== undefined){
        return env.dbis[dbi_name];
    }

    let dbi = env.openDbi({
        name: dbi_name,
        create: false,
        dupSort: true
    });

    env.dbis[dbi_name] = dbi;
    return dbi;
}

/**
 * gets the statistics for a named database from the environment
 * @param env
 * @param dbi_name
 * @returns {void | Promise<Stats> | *}
 */
function statDBI(env, dbi_name){
    let dbi = openDBI(env, dbi_name);
    let txn = env.beginTxn();
    let stats = dbi.stat(txn);
    txn.abort();
    return stats;
}

/**
 * removes a named database from an environment
 * @param env
 * @param dbi_name
 */
function dropDBI(env, dbi_name){
    let dbi = openDBI(env, dbi_name);
    dbi.drop();

    let dbis = openDBI(env, INTERNAL_DBIS_NAME);
    let txn = env.beginTxn();
    txn.putString(dbis, dbi_name);
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