'use strict';

const fs = require('fs-extra');
const terms = require('../../../../utility/hdbTerms');
const getBasePath = require('../fsUtility/getBasePath');
const fsCreateRecords = require('./fsCreateRecords');
const fsCreateAttribute = require('./fsCreateAttribute');

module.exports = createTable;

/**
 * Orchestrates the creation of a table.
 * Inserts the table info into the system schema/table.
 * Creates a directory for the table inside its schema directory.
 * Creates an attribute for the table hash attribute.
 * @param table_system_data
 * @param create_table_obj
 * @returns {Promise<void>}
 */
async function createTable(table_system_data, create_table_obj) {
    let insert_object = {
        operation: terms.OPERATIONS_ENUM.INSERT,
        schema: terms.SYSTEM_SCHEMA_NAME,
        table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        hash_attribute: terms.SYSTEM_TABLE_HASH,
        records: [table_system_data]
    };

    let hash_attr_object = {
        operation: terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
        schema: create_table_obj.schema,
        table: create_table_obj.table,
        attribute: create_table_obj.hash_attribute,
    };

    try {
        await fsCreateRecords(insert_object);
        await fs.mkdir(`${getBasePath()}/${create_table_obj.schema}/${create_table_obj.table}`, {mode: terms.HDB_FILE_PERMISSIONS});
        await fsCreateAttribute(hash_attr_object);
    } catch(err) {
        if (err.code === 'ENOENT') {
            throw new Error('schema does not exist');
        }
        if (err.code === 'EEXIST') {
            throw new Error('table already exists');
        }
        throw err;
    }
}
