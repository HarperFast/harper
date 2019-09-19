'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const heCreateRecords = require('../heMethods/heCreateRecords');
const heCreateAttribute = require('./heCreateAttribute');

module.exports = heCreateTable;

/**
 * Writes new table data to the system tables and creates two datastores to track created and updated
 * timestamps for new table data.
 * @param table_system_data
 * @param table_create_obj
 */
function heCreateTable(table_system_data, table_create_obj) {
    let insert_object = {
        operation: hdb_terms.OPERATIONS_ENUM.INSERT,
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        hash_attribute: hdb_terms.SYSTEM_TABLE_HASH,
        records: [table_system_data]
    };

    let created_time_attr = {
        operation: hdb_terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
        schema: table_create_obj.schema,
        table: table_create_obj.table,
        attribute: hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME,
    };

    let updated_time_attr = {
        operation: hdb_terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
        schema: table_create_obj.schema,
        table: table_create_obj.table,
        attribute: hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME,
    };

    try {
        heCreateRecords(insert_object);
        heCreateAttribute(created_time_attr);
        heCreateAttribute(updated_time_attr);
    } catch(err) {
        throw err;
    }
}
