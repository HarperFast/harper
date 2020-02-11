'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../utility/lmdb/writeUtility');
const path = require('path');
const env_mgr = require('../../../../utility/environment/environmentManager');
const system_schema = require('../../../../json/systemSchema');
const lmdb_create_attribute = require('./lmdbCreateAttribute');
const LMDBCreateAttributeObject = require('../lmdbUtility/LMDBCreateAttributeObject');
const log = require('../../../../utility/logging/harper_logger');

if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mgr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);

const HDB_TABLE_INFO = system_schema.hdb_table;
let hdb_table_attributes = [];
for(let x = 0; x < HDB_TABLE_INFO.attributes.length; x++){
    hdb_table_attributes.push(HDB_TABLE_INFO.attributes[x].attribute);
}
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, hdb_terms.SYSTEM_SCHEMA_NAME);

module.exports = lmdbCreateTable;

/**
 * Writes new table data to the system tables creates the enivronment file and creates two datastores to track created and updated
 * timestamps for new table data.
 * @param table_system_data
 * @param table_create_obj
 */
async function lmdbCreateTable(table_system_data, table_create_obj) {
    let schema_path = path.join(BASE_SCHEMA_PATH, table_create_obj.schema);

    let created_time_attr = new LMDBCreateAttributeObject(table_create_obj.schema, table_create_obj.table, hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME, undefined, true);
    let updated_time_attr = new LMDBCreateAttributeObject(table_create_obj.schema, table_create_obj.table, hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME, undefined, true);
    let hash_attr = new LMDBCreateAttributeObject(table_create_obj.schema, table_create_obj.table, table_create_obj.hash_attribute, undefined, false);

    try {
        //create the new environment
        await environment_utility.createEnvironment(schema_path, table_create_obj.table);

        let hdb_table_env = await environment_utility.openEnvironment(SYSTEM_SCHEMA_PATH, hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME);
        //add the meta data to system.hdb_table
        write_utility.insertRecords(hdb_table_env, HDB_TABLE_INFO.hash_attribute, hdb_table_attributes, [table_system_data]);
        //create attributes for hash attribute created/updated time stamps

        await createAttribute(created_time_attr);
        await createAttribute(updated_time_attr);
        await createAttribute(hash_attr);
    }catch (e) {
        throw e;
    }
}

/**
 * used to individually create the required attributes for a new table, logs a warning if any fail
 * @param {LMDBCreateAttributeObject} attribute_object
 * @returns {Promise<void>}
 */
async function createAttribute(attribute_object){
    try{
        await lmdb_create_attribute(attribute_object);
    }catch(e){
        log.warn(`failed to create attribute ${attribute_object.attribute} due to ${e.message}`);
    }
}