"use strict";

const env = require('../environment/environmentManager');
if(!env.isInitialized()){
    env.initSync();
}

const path = require('path');
const fs_search_by_value = require('../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByValue');
const fs_search_by_hash = require('../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByHash');
const fs = require('fs-extra');
const he_insert_rows = require('../../data_layer/harperBridge/heBridge/heMethods/heCreateRecords');
const system_schema = require('../../json/systemSchema');
const terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');
const BATCH_SIZE = 1000;

/**
 *
 * @param schema
 * @param table
 */
function schemaTableValidation(schema, table){
    if(hdb_utils.isEmpty(schema)){
        throw new Error('schema is required');
    }

    if(hdb_utils.isEmpty(table)){
        throw new Error('table is required');
    }
}
/**
 *
 * @param schema
 * @param table
 * @returns {Promise<void>}
 */
async function migrateTableToHelium(schema, table){
    try {
        schemaTableValidation(schema, table);

        let table_info = await getTableInfo(schema, table);
        if (!table_info) {
            console.log(`unknown table: ${schema}.${table}`);
            return;
        }
        setGlobalSchema(table_info);

        let ids = await getTableHashValues(table_info);

        await searchAndInsert(table_info, ids);
    } catch(e){
        console.error(e);
    }
}

/**
 *
 * @param table_info
 * @param ids
 * @returns {Promise<void>}
 */
async function searchAndInsert(table_info, ids){
    if(Array.isArray(ids) && ids.length > 0) {
        let search = {
            schema: table_info.schema,
            table: table_info.name,
            get_attributes: ['*'],
            hash_values: []
        };

        let insert = {
            operation: terms.OPERATIONS_ENUM.INSERT,
            schema: table_info.schema,
            table: table_info.name,
            records: []
        };

        for (let x = 0; x < ids.length; x++) {
            search.hash_values.push(ids[x]);
            if (search.hash_values.length > BATCH_SIZE) {
                let search_results = await fs_search_by_hash(search);
                if (search_results.length > 0) {
                    insert.records = search_results;
                    await he_insert_rows(insert);
                }
                search.hash_values = [];
            }
        }

        let search_results = await fs_search_by_hash(search);
        insert.records = search_results;
        await he_insert_rows(insert);
    }
}

/**
 *
 * @param schema
 * @param table
 * @returns {Promise<undefined>}
 */
async function getTableInfo(schema, table){
    schemaTableValidation(schema, table);

    console.info(`searching for table info ${schema}.${table}`);

    let table_info = undefined;
    if(schema === terms.SYSTEM_SCHEMA_NAME){
        console.info(`fetching system info ${schema}.${table}`);
        table_info = system_schema[table];
    } else {
        //use fs search by value to get the table meta data from
        let table_search_obj = {
            schema: terms.SYSTEM_SCHEMA_NAME,
            table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
            hash_attribute: terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
            search_attribute: 'name',
            search_value: table,
            get_attributes: ['*']
        };

        let results = [];
        try {
            console.info(`performing fs search on table ${schema}.${table}`);
            results = await fs_search_by_value(table_search_obj);
            for (let x = 0; x < results.length; results++) {
                if (results[x].schema === schema) {
                    table_info = results[x];
                    break;
                }
            }
        }catch (e) {
            console.error(`failed to search for table ${schema}.${table}: ${e.message}`);
        }
    }

    return table_info;
}

/**
 *
 * @param table_info
 */
function setGlobalSchema(table_info){
    if(hdb_utils.isEmpty(table_info)){
        throw new Error('table_info is required');
    }

    schemaTableValidation(table_info.schema, table_info.name);

    if(global.hdb_schema === undefined) {
        global.hdb_schema = {};
    }

    if(global.hdb_schema[table_info.schema] === undefined) {
        global.hdb_schema[table_info.schema] = {};
    }

    global.hdb_schema[table_info.schema][table_info.name] = table_info;
}

/**
 *
 * @param table_info
 * @returns {Promise<[]>}
 */
async function getTableHashValues(table_info){
    if(hdb_utils.isEmpty(table_info)){
        throw new Error('table_info is required');
    }

    schemaTableValidation(table_info.schema, table_info.name);

    let hash_path = path.join(env.getHdbBasePath(), terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY, table_info.schema, table_info.name,
        terms.HASH_FOLDER_NAME, table_info.hash_attribute);
    let ids = [];
    try {
        let file_ids = await fs.readdir(hash_path);
        file_ids.forEach(fid=>{
            ids.push(fid.replace(terms.HDB_FILE_SUFFIX, ''));
        });
    } catch(e){
        if(e.code !== 'ENOENT'){
            console.error(e);
            return ids;
        }
    }

    return ids;
}

/**
 *
 * @returns {Promise<void>}
 */
async function migrateSystemTablesToHelium(){
    for(const tbl of Object.keys(system_schema)){
        await migrateTableToHelium(terms.SYSTEM_SCHEMA_NAME, tbl);
    }
}