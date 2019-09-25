'use strict';

const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const heProcessResponse = require('../heUtility/heProcessResponse');
const hdb_utils = require('../../../../utility/common_utils');
const helium_utils = require('../../../../utility/helium/heliumUtils');
const hdb_terms = require('../../../../utility/hdbTerms');

let hdb_helium;
try {
    hdb_helium = helium_utils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = heDeleteRecords;

/**
 * Deletes a full table row at a certain hash.
 * @param delete_obj
 */
function heDeleteRecords(delete_obj) {
        let schema_table = global.hdb_schema[delete_obj.schema][delete_obj.table];
        if (hdb_utils.isEmpty(schema_table.hash_attribute)) {
            throw new Error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
        }

        try {
            let he_response = hdb_helium.deleteRows(buildTableDataStores(delete_obj, schema_table), delete_obj.hash_values);
            let response = heProcessResponse(he_response, hdb_terms.OPERATIONS_ENUM.DELETE);

            return response;
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