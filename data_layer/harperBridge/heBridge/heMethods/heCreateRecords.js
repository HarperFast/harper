'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const heProcessRows = require('../heUtility/heProcessRows');
const heProcessInsertUpdateResponse = require('../heUtility/heProcessInsertUpdateResponse');
const heCheckForNewAttributes = require('../heUtility/heCheckForNewAttributes');
const hdb_terms = require('../../../../utility/hdbTerms');
const heliumUtils = require('../../../../utility/helium/heliumUtils');

let hdb_helium;
try {
    hdb_helium = heliumUtils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = heCreateRecords;

/**
 * Orchestrates the insertion of data into Helium and the creation of new attributes/datastores
 * if they do not already exist.
 * @param insert_obj
 * @returns {Promise<{skipped_hashes: *, written_hashes: *, schema_table: *}>}
 */
function heCreateRecords(insert_obj) {
    try {
        let { schema_table, attributes } = insertUpdateValidate(insert_obj);
        let { datastores, processed_rows } = heProcessRows(insert_obj, attributes, schema_table);

        if (insert_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
            if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME)) {
                attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME);
            }

            if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME)) {
                attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME);
            }
        }

        heCheckForNewAttributes(insert_obj.hdb_auth_header, schema_table, attributes);
        let he_response = hdb_helium.insertRows(datastores, rows);
        let { written_hashes, skipped_hashes } = heProcessInsertUpdateResponse(he_response);

        return {
            written_hashes,
            skipped_hashes,
            schema_table
        };
    } catch(err) {
        throw err;
    }
}
