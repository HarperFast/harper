'use strict';

const heDropTable = require('./heDropTable');
const heDeleteRecords = require('./heDeleteRecords');
const heGetDataByHash = require('./heGetDataByHash');
const heGetDataByValue = require('./heGetDataByValue');
const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = heDropSchema;

function heDropSchema(drop_schema_obj) {
    let delete_schema;

    try {
        delete_schema = validateDropSchema(drop_schema_obj.schema);

        //We search in system > hdb_table for tables with the schema to ensure we are deleting all schema datastores
        const table_search_obj = {
            schema: hdb_terms.SYSTEM_SCHEMA_NAME,
            table: hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
            search_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY,
            search_value: delete_schema,
            get_attributes: [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]
        };

        let tables = heGetDataByValue(table_search_obj);

        for (let table_name in tables) {
            const delete_table_obj = {
                schema: delete_schema,
                table: tables[table_name].name
            };
            try {
                heDropTable(delete_table_obj);
            } catch(e) {
                throw e;
            }
        }

        //After all tables for schema are deleted, we can delete the schema
        const delete_schema_obj = {
            schema: hdb_terms.SYSTEM_SCHEMA_NAME,
            table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
            hash_values: [delete_schema]
        };

        // Delete the schema from the system > hdb_schema datastore
        heDeleteRecords(delete_schema_obj);

    } catch(err) {
        throw err;
    }
}

function validateDropSchema(drop_schema) {
    let search_obj = {
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
        hash_values: [drop_schema],
        get_attributes: [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]
    };
    let search_result;
    let delete_schema;

    try {
        search_result = heGetDataByHash(search_obj);
    } catch(err) {
        throw err;
    }

    // Data found by the search function should match the drop_schema
    for (let item in search_result) {
        if (search_result[item].name === drop_schema) {
            delete_schema = drop_schema;
        }
    }

    if (!delete_schema) {
        throw new Error(`schema '${drop_schema}' does not exist`);
    }

    return delete_schema;
}
