'use strict';

const heDropTable = require('./heDropTable');
const heDeleteRecords = require('./heDeleteRecords');
const heGetDataByValue = require('./heGetDataByValue');
// const moveFolderToTrash = require('../fsUtility/moveFolderToTrash');
const deleteAttrStructure = require('../../fsBridge/fsUtility/deleteAttrStructure');
const env = require('../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../utility/hdbTerms');

const DATE_SUBSTR_LENGTH = 19;
let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
// const TRASH_BASE_PATH = `${env.getHdbBasePath()}/${terms.HDB_TRASH_DIR}`;

module.exports = heDropSchema;

async function heDropSchema(drop_schema_obj) {
    let schema = drop_schema_obj.schema;
    let delete_schema_obj = {
        schema: drop_schema_obj.schema,
        table: ''
    };

    try {
        let tables = global.hdb_schema[schema];
        for (let table_name in tables) {
            delete_schema_obj.table = tables[table_name].name;
            try {
                heDropTable(delete_schema_obj);
            } catch(e) {
                throw e;
            }
        }

        dropSchemaFromSystem(drop_schema_obj);
    } catch(err) {
        throw err;
    }
}

/**
 * Searches the system schema for the schema hash, then uses hash to delete schema from system.
 * @param drop_schema_obj
 */
function dropSchemaFromSystem(drop_schema_obj) {
    let search_obj = {
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
        search_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
        search_value: drop_schema_obj.schema,
        get_attributes: [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]
    };
    let search_result;
    let delete_schema;

    try {
        search_result = heGetDataByValue(search_obj);
    } catch(err) {
        throw err;
    }

    // Data found by the search function should match the drop_schema_object
    for (let item in search_result) {
        if (search_result[item].name === drop_schema_obj.schema) {
            delete_schema = search_result[item];
        }
    }

    if (!delete_schema) {
        throw new Error(`${drop_schema_obj.schema} was not found`);
    }

    let delete_schema_obj = {
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
        // hash_attribute: hdb_terms.SYSTEM_SCHEMA_NAME,
        hash_values: [delete_schema[hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]]
    };
    try {
        heDeleteRecords(delete_schema_obj);
    } catch(err) {
        throw err;
    }
}
