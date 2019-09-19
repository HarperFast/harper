'use strict';

module.exports = heCreateTable;

function heCreateTable(create_table_obj) {
    let insert_object = {
        operation: terms.OPERATIONS_ENUM.INSERT,
        schema: terms.SYSTEM_SCHEMA_NAME,
        table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        hash_attribute: terms.SYSTEM_TABLE_HASH,
        records: [table_system_data]
    };



}
