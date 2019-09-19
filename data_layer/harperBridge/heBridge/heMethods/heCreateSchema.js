'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const heCreateRecords = require('../heMethods/heCreateRecords');

module.exports = heCreateSchema;

function heCreateSchema(create_schema_obj) {
    let insert_object = {
        operation: hdb_terms.OPERATIONS_ENUM.INSERT,
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
        records: [
            {
                name: create_schema_obj.schema,
                createddate: '' + Date.now()
            }
        ]
    };

    try {
        heCreateRecords(insert_object);
    } catch(err) {
        throw err;
    }
}
