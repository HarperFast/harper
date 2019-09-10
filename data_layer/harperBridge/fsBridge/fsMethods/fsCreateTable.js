'use strict';

const fs = require('fs-extra');
const terms = require('../../../../utility/hdbTerms');
const getBasePath = require('../fsUtility/getBasePath');
const fsCreateRecords = require('./fsCreateRecords');

module.exports = createTable;

async function createTable(table_system_data, create_table_obj) {
    let insert_object = {
        operation: terms.OPERATIONS_ENUM.INSERT,
        schema: terms.SYSTEM_SCHEMA_NAME,
        table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        hash_attribute: terms.SYSTEM_TABLE_HASH,
        records: [table_system_data]
    };

    try {
        await fsCreateRecords(insert_object);
        await fs.mkdir(`${getBasePath()}/${create_table_obj.schema}/${create_table_obj.table}`, {mode: terms.HDB_FILE_PERMISSIONS});
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
