'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../utility/lmdb/writeUtility');
const path = require('path');
const env_mgr = require('../../../../utility/environment/environmentManager');
const system_schema = require('../../../../json/systemSchema');
const lmdb_create_attribute = require('./lmdbCreateAttribute');

if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mgr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);

const HDB_TABLE_INFO = system_schema.hdb_table;
let hdb_table_attributes = [];
for(let x = 0; x < HDB_TABLE_INFO.attributes.length; x++){
    hdb_table_attributes.push(HDB_TABLE_INFO.attributes[x].attribute);
}
let HDB_TABLE_ENV;

module.exports = lmdbCreateTable;

/**
 * Writes new table data to the system tables creates the enivronment file and creates two datastores to track created and updated
 * timestamps for new table data.
 * @param table_system_data
 * @param table_create_obj
 */
async function lmdbCreateTable(table_system_data, table_create_obj) {
    let schema_path = path.join(BASE_SCHEMA_PATH, table_create_obj.schema);

    let created_time_attr = {
        operation: hdb_terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
        schema: table_create_obj.schema,
        table: table_create_obj.table,
        attribute: hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME,
    };

    let updated_time_attr = {
        operation: hdb_terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
        schema: table_create_obj.schema,
        table: table_create_obj.table,
        attribute: hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME,
    };

    let hash_attr = {
        operation: hdb_terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
        schema: table_create_obj.schema,
        table: table_create_obj.table,
        attribute: table_create_obj.hash_attribute,
    };

    try {
        //create the new environment
        await environment_utility.createEnvironment(schema_path, table_create_obj.table);

        await getHDBTableEnvironment();
        //add the meta data to system.hdb_table
        write_utility.insertRecords(HDB_TABLE_ENV, HDB_TABLE_INFO.hash_attribute, hdb_table_attributes, [table_system_data]);
        //create attributes for hash attribute created/updated time stamps
        await lmdb_create_attribute(created_time_attr);
        await lmdb_create_attribute(updated_time_attr);
        await lmdb_create_attribute(hash_attr);
    }catch (e) {
        throw e;
    }
}

async function getHDBTableEnvironment(){
    if(HDB_TABLE_ENV === undefined){
        HDB_TABLE_ENV = await environment_utility.openEnvironment(path.join(BASE_SCHEMA_PATH, hdb_terms.SYSTEM_SCHEMA_NAME), hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME);
    }
}