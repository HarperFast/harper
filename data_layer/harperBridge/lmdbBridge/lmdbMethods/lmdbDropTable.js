'use strict';

const SearchObject = require('../../../SearchObject');
const DeleteObject = require('../../../../data_layer/DeleteObject');
const search_by_value = require('./lmdbSearchByValue');
const delete_records = require('./lmdbDeleteRecords');
const drop_all_attributes = require('../lmdbUtility/lmdbDropAllAttributes');
const hdb_terms = require('../../../../utility/hdbTerms');
const fs = require('fs-extra');

const env_mngr = require('../../../../utility/environment/environmentManager');
const path = require('path');

if(!env_mngr.isInitialized()){
    env_mngr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mngr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);

module.exports = lmdbDropTable;

/**
 * Calls drops the table, all of it's attribute & deletes the environment
 * @param drop_table_obj
 */
async function lmdbDropTable(drop_table_obj) {
    try {
        await drop_all_attributes(drop_table_obj);
        await dropTableFromSystem(drop_table_obj);

        let environment_path = path.join(BASE_SCHEMA_PATH, drop_table_obj.schema, drop_table_obj.table);
        await fs.remove(environment_path);
    } catch(err) {
        throw err;
    }
}

/**
 * Searches the system table for the table hash, then uses hash to delete table from system.
 * @param drop_table_obj
 */
async function dropTableFromSystem(drop_table_obj) {
    let search_obj = new SearchObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY, drop_table_obj.table, undefined,
        [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]);
    let search_result;
    let delete_table;
    try {
        search_result = await search_by_value(search_obj);
    } catch(err) {
        throw err;
    }

    // Data found by the search function should match the drop_table_object
    for(let x = 0; x < search_result.length; x++){
        let item = search_result[x];
        if (item.name === drop_table_obj.table && item.schema === drop_table_obj.schema) {
            delete_table = item;
        }
    }

    if (!delete_table) {
        throw new Error(`${drop_table_obj.schema}.${drop_table_obj.table} was not found`);
    }

    let delete_table_obj = new DeleteObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME, [delete_table.id]);
    try {
        await delete_records(delete_table_obj);
    } catch(err) {
        throw err;
    }
}