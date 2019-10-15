'use strict';

const heDropTable = require('./heDropTable');
const heDeleteRecords = require('./heDeleteRecords');
const heGetDataByValue = require('./heGetDataByValue');
// const moveFolderToTrash = require('../fsUtility/moveFolderToTrash');
// const deleteAttrStructure = require('../../fsBridge/fsUtility/deleteAttrStructure');
// const env = require('../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../utility/hdbTerms');
const common_utils = require('../../../../utility/common_utils');

// const DATE_SUBSTR_LENGTH = 19;
// let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
// const TRASH_BASE_PATH = `${env.getHdbBasePath()}/${terms.HDB_TRASH_DIR}`;

module.exports = heDropSchema;

async function heDropSchema(drop_schema_obj) {
    let schema = drop_schema_obj.schema;

    try {
        let delete_schema_obj = {
            schema: hdb_terms.SYSTEM_SCHEMA_NAME,
            table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
            hash_values: [drop_schema_obj.schema]
        };

        const delete_response = heDeleteRecords(delete_schema_obj);

        if (delete_response.deleted_hashes.length === 0) {
            throw new Error(`schema '${drop_schema_obj.schema}' does not exist`);
        }

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

        // dropSchemaFromSystem(drop_schema_obj);
    } catch(err) {
        throw err;
    }
}

/**
 * Searches the system schema for the schema hash, then uses hash to delete schema from system.
 * @param drop_schema_obj
 */
// function dropSchemaFromSystem(drop_schema_obj) {
//     let delete_schema_obj = {
//         schema: hdb_terms.SYSTEM_SCHEMA_NAME,
//         table: hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
//         hash_values: [drop_schema_obj.schema]
//     };
//
//     try {
//         return heDeleteRecords(delete_schema_obj);
//     } catch(err) {
//         throw err;
//     }
// }
