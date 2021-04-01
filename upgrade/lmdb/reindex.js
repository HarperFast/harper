'use strict';

//keep these 2 dependencies in this exact order, otherwise this will fail on OSX
const new_environment_utility = require('../../utility/lmdb/environmentUtility');
const old_environment_utility = require('./nodeLMDB/environmentUtility');

const {insertRecords} = require('../../utility/lmdb/writeUtility');
const lmdb_common = require('../../utility/lmdb/commonUtility');
const lmdb_terms = require('../../utility/lmdb/terms');
const hdb_common = require('../../utility/common_utils');
const logger = require('../../utility/logging/harper_logger');
const fs = require('fs-extra');
const path = require('path');
const progress = require('cli-progress');
const assert = require('assert');
const pino = require('pino');
const env_mngr = require('../../utility/environment/environmentManager');
if(!env_mngr.isInitialized()) {
    env_mngr.initSync();
}

const BASE_PATH = env_mngr.getHdbBasePath();
const SCHEMA_PATH = path.join(BASE_PATH, 'schema');
const TMP_PATH = path.join(BASE_PATH, 'tmp');
const TRANSACTIONS_PATH = path.join(BASE_PATH, );
let pino_logger;

module.exports = reindexUpgrade;

async function reindexUpgrade() {
    await getTables(SCHEMA_PATH);
    await getTables(TRANSACTIONS_PATH);
}

async function getTables(reindex_path){
    logger.notify('Reindexing upgrade started');

    // Get list of schema folders
    let schema_list = await fs.readdir(reindex_path);

    for(let x = 0, length = schema_list.length; x < length; x++){
        let schema_name = schema_list[x];
        let the_schema_path = path.join(reindex_path, schema_name);
        if (schema_name === '.DS_Store') {
            continue;
        }

        // Get list of table folders
        let table_list = await fs.readdir(the_schema_path);
        for(let y = 0, table_length = table_list.length; y < table_length; y++){
            const table_name = table_list[y];
            if (table_name === '.DS_Store') {
                continue;
            }
            try {
                // Each table gets its own log
                await initPinoLogger(schema_name, table_name);

                pino_logger.info(`Reindexing started for schema: ${schema_name} table: ${table_name}`);
                await processTable(schema_name, table_name, the_schema_path);
                pino_logger.info(`Reindexing completed for schema: ${schema_name} table: ${table_name}`);
            } catch(err) {
                err.schema_path = the_schema_path;
                err.table_name = table_name;
                logger.error(err);
                pino_logger.error(err);
            }
        }
    }

    //fs.emptyDir(TMP_PATH);
    logger.notify('Reindexing upgrade completed');
}

async function initPinoLogger(schema, table) {
    let log_name = `${schema}_${table}.log`;
    let log_destination = path.join(TMP_PATH, log_name);
    await fs.ensureDir(TMP_PATH);
    await fs.writeFile(log_destination, '');
    pino_logger = pino({
        level: 'debug',
        formatters: {
            bindings() {
                return undefined;
            }
        }
    }, log_destination);
}

async function processTable(schema, table, the_schema_path){
    //open the existing environment with the "old" environment utility
    let old_env = await old_environment_utility.openEnvironment(the_schema_path, table);
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
        clearOnComplete: false
    });
    bar.start(stats.entryCount, 0, {});

    //create temp folder
    let tmp_schema_path = path.join(TMP_PATH, schema);
    await fs.remove(path.join(tmp_schema_path, table));
    await fs.mkdirp(tmp_schema_path);
    pino_logger.info(`Temp schema path: ${tmp_schema_path}`);

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

            let results = await insertRecords(new_env, hash, all_dbi_names, [record], false);
            pino_logger.info(`Insert result: ${JSON.stringify(results)}`);

            //validate indices for the row
            assert(results.written_hashes.indexOf(hash_value) > -1);
            validateIndices(new_env, hash, record[hash]);

            //increment the progress bar by 1
            bar.increment();
            pino_logger.info(`${bar.value} of ${bar.total} records inserted`);
        }
        txn.close();

    }catch(e){
        if(txn !== undefined){
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
    let table_path = path.join(the_schema_path, table);
    await fs.move(path.join(tmp_schema_path, table), table_path, {overwrite: true});
    pino_logger.info(`Moving environment to schema folder: ${table_path}`);

    //stat the moved env & make sure stats match from before
    let env = await new_environment_utility.openEnvironment(the_schema_path, table);
    let stat = new_environment_utility.statDBI(env, hash);
    pino_logger.info(`New stats: ${JSON.stringify(new_stats)}. New stats after move: ${JSON.stringify(stat)}`);
    assert.deepStrictEqual(stat, new_stats);
    new_environment_utility.closeEnvironment(env);
}

function validateIndices(env, hash, hash_value){
    let hash_dbi = env.dbis[hash];

    let record = hash_dbi.get(hash_value);
    assert.deepStrictEqual(typeof record, 'object');
    for (const [key, value] of Object.entries(record)) {
        if(key !== hash && env.dbis[key] !== undefined && !hdb_common.isEmptyOrZeroLength(value)) {
            let found = false;
            try {
                if(lmdb_common.checkIsBlob(value)){
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
            }catch(e){
                pino_logger.error(e);
                console.error(e);
            }
        }
    }
}

function getHashDBI(dbis){
    let hash_attribute;
    for (const [key, value] of Object.entries(dbis)) {
        if(value.__dbi_defintion__.is_hash_attribute === true){
            hash_attribute = key;
            break;
        }
    }
    return hash_attribute;
}


getTables().then(d=>{});