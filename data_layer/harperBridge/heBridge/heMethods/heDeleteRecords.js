'use strict';

const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const hdb_utils = require('../../../../utility/common_utils');
const helium_utils = require('../../../../utility/helium/heliumUtils');
const log = require('../../../../utility/logging/harper_logger');
let hdb_helium = helium_utils.initializeHelium();

module.exports = heDeleteRecords;

let DELETE_OBJ_TEST = {
    operation: "delete",
    table: "doggo",
    schema: "deleteTest",
    hash_values: [
        8,
        9
    ],
    records: [
        {
            age: 5,
            breed: "Mutt",
            id: 8,
            name: "Harper"
        },
        {
            age: 5,
            breed: "Mutt",
            id: 9,
            name: "Penny"
        }
    ]
};

/**
 * Deletes a full table row at a certain hash. Hle
 * @param delete_obj
 */
function heDeleteRecords(delete_obj) {
        let schema_table = global.hdb_schema[delete_obj.schema][delete_obj.table];
        if (hdb_utils.isEmpty(schema_table.hash_attribute)) {
            log.error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
            throw new Error(`hash attribute not found`);
        }

        try {

            // TODO: what should we do with the response? currently FS will throw error if not exist
            let result = hdb_helium.deleteRows(buildTableDataStores(delete_obj, schema_table), delete_obj.hash_values);
            log.info(`Result from heDeleteRecords: ${result}`);
        } catch(err) {
            throw err;
        }
}

/**
 * Builds an array of all the attributes/datastores in a table.
 * @param delete_obj
 * @param schema_table
 * @returns {[]}
 */
function buildTableDataStores(delete_obj, schema_table) {
    let datastores = [];
    for (let i = 0; i < schema_table.attributes.length; i++) {
        datastores.push(heGenerateDataStoreName(delete_obj.schema, delete_obj.table, schema_table.attributes[i].attribute));
    }

    return datastores;
}