'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const heCreateRecords = require('../heMethods/heCreateRecords');

module.exports = heCreateTable;

function heCreateTable(table_system_data, table_create_obj) {
    let insert_object = {
        operation: hdb_terms.OPERATIONS_ENUM.INSERT,
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        hash_attribute: hdb_terms.SYSTEM_TABLE_HASH,
        records: [table_system_data]
    };

    try {
        heCreateRecords(insert_object);
    } catch(err) {

    }
}
