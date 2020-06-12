'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../utility/lmdb/writeUtility');
const path = require('path');
const {getSystemSchemaPath,getBaseSchemaPath, getTransactionStorePath} = require('../lmdbUtility/initializePaths');
const system_schema = require('../../../../json/systemSchema');
const lmdb_create_attribute = require('./lmdbCreateAttribute');
const LMDBCreateAttributeObject = require('../lmdbUtility/LMDBCreateAttributeObject');
const log = require('../../../../utility/logging/harper_logger');
const fs = require('fs-extra');

const HDB_TABLE_INFO = system_schema.hdb_table;
let hdb_table_attributes = [];
for(let x = 0; x < HDB_TABLE_INFO.attributes.length; x++){
    hdb_table_attributes.push(HDB_TABLE_INFO.attributes[x].attribute);
}

module.exports = lmdbCreateTable;

/**
 * Writes new table data to the system tables creates the enivronment file and creates two datastores to track created and updated
 * timestamps for new table data.
 * @param table_system_data
 * @param table_create_obj
 */
async function lmdbCreateTable(table_system_data, table_create_obj) {
    let schema_path = path.join(getBaseSchemaPath(), table_create_obj.schema.toString());

    let created_time_attr = new LMDBCreateAttributeObject(table_create_obj.schema, table_create_obj.table, hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME, undefined, true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
    let updated_time_attr = new LMDBCreateAttributeObject(table_create_obj.schema, table_create_obj.table, hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME, undefined, true, lmdb_terms.DBI_KEY_TYPES.NUMBER);
    let hash_attr = new LMDBCreateAttributeObject(table_create_obj.schema, table_create_obj.table, table_create_obj.hash_attribute, undefined, false, lmdb_terms.DBI_KEY_TYPES.STRING, true);

    try {
        //create the new environment
        await environment_utility.createEnvironment(schema_path, table_create_obj.table);

        if(table_system_data !== undefined) {
            let hdb_table_env = await environment_utility.openEnvironment(getSystemSchemaPath(), hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME);

            //add the meta data to system.hdb_table
            write_utility.insertRecords(hdb_table_env, HDB_TABLE_INFO.hash_attribute, hdb_table_attributes, [table_system_data]);
            //create attributes for hash attribute created/updated time stamps

            await createAttribute(created_time_attr);
            await createAttribute(updated_time_attr);
            await createAttribute(hash_attr);
        }

        await createTransactionsEnvironment(table_create_obj);
    }catch (e) {
        throw e;
    }
}

/**
 *
 * @param table_create_obj
 * @returns {Promise<void>}
 */
async function createTransactionsEnvironment(table_create_obj){
    let env;
    try {
        //create transactions environment for table
        let transaction_path = path.join(getTransactionStorePath(), table_create_obj.schema.toString());
        await fs.mkdirp(transaction_path);
        env = await environment_utility.createEnvironment(transaction_path, table_create_obj.table, true);
    }catch(e){
        e.message = `unable to create transactions environment for ${table_create_obj.schema}.${table_create_obj.table} due to: ${e.message}`;
        throw e;
    }

    try {
        //create dbis for transactions environment
        environment_utility.createDBI(env, hdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, false, lmdb_terms.DBI_KEY_TYPES.NUMBER, true);
        environment_utility.createDBI(env, hdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE, true, lmdb_terms.DBI_KEY_TYPES.STRING, false);
        environment_utility.createDBI(env, hdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME, true, lmdb_terms.DBI_KEY_TYPES.STRING, false);
    }catch(e){
        e.message = `unable to create dbi for ${table_create_obj.schema}.${table_create_obj.table} due to: ${e.message}`;
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