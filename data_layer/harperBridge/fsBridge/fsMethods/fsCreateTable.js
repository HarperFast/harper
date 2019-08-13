'use strict';

const fs = require('fs-extra');
const env = require('../../../../utility/environment/environmentManager');
const terms = require('../../../../utility/hdbTerms');

module.exports = createTable;

// This must be after export to prevent issues with circular dependencies related to insert.checkForNewAttributes.
const hdb_core_insert = require('../../../insert');

async function createTable(table_system_data, create_table_obj) {
    let insert_object = {
        operation: terms.OPERATIONS_ENUM.INSERT,
        schema: terms.SYSTEM_SCHEMA_NAME,
        table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        hash_attribute: terms.SYSTEM_TABLE_HASH,
        records: [table_system_data]
    };

    try {
        await hdb_core_insert.insert(insert_object);
        await fs.mkdir(`${env.get('HDB_ROOT')}/${terms.HDB_SCHEMA_DIR}/${create_table_obj.schema}/${create_table_obj.table}`, {mode: terms.HDB_FILE_PERMISSIONS});
    } catch(err) {
        if (err.errno === -2) {
            throw new Error('schema does not exist');
        }
        if (err.errno === -17) {
            throw new Error('table already exists');
        }
        throw err;
    }
}
