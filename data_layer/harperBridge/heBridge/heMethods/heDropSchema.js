'use strict';

const heDropTable = require('./heDropTable');
const heDeleteRecords = require('./heDeleteRecords');
const hdb_terms = require('../../../../utility/hdbTerms');
const common_utils = require('../../../../utility/common_utils');

module.exports = heDropSchema;

async function heDropSchema(drop_schema_obj) {
    let schema = drop_schema_obj.schema;

    try {
        let delete_schema_obj = {
            schema: hdb_terms.SYSTEM_SCHEMA_NAME,
            table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
            hash_values: [drop_schema_obj.schema]
        };

        // Delete the schema from the system > hdb_schema datastore
        const delete_response = heDeleteRecords(delete_schema_obj);

        //If there was no deleted_hashes returned, that means the schema doesn't exist
        // in the db and we can skip the rest of this operation
        if (delete_response.deleted_hashes.length === 0) {
            throw new Error(`schema '${drop_schema_obj.schema}' does not exist`);
        }

        //Final step is to drop the tables associated with the schema - this will also
        // handle table and attribute system data
        let tables = global.hdb_schema[schema];
        let delete_table_obj = {
            schema: schema,
            table: ''
        };

        for (let table_name in tables) {
            delete_table_obj.table = tables[table_name].name;
            try {
                heDropTable(delete_table_obj);
            } catch(e) {
                throw e;
            }
        }

    } catch(err) {
        throw err;
    }
}
