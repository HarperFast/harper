'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const heProcessRows = require('../heUtility/heProcessRows');
const heCheckForNewAttributes = require('../heUtility/heCheckForNewAttributes');
const heProcessResponse = require('../heUtility/heProcessResponse');
const hdb_terms = require('../../../../utility/hdbTerms');
const heliumUtils = require('../../../../utility/helium/heliumUtils');

let hdb_helium;
try {
    hdb_helium = heliumUtils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = heUpdateRecords;

/**
 * Orchestrates the update of data in Helium and the creation of new attributes/datastores
 * if they do not already exist.
 * @param update_obj
 * @returns {{skipped_hashes: *, written_hashes: *, schema_table: *}}
 */
function heUpdateRecords(update_obj) {
    try {
        let { schema_table, hashes, attributes } = insertUpdateValidate(update_obj);
        let { datastores, processed_rows } = heProcessRows(update_obj, attributes, schema_table, hashes);

        if (update_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
            if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME)) {
                attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME);
            }

            if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME)) {
                attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME);
            }
        }

        heCheckForNewAttributes(update_obj.hdb_auth_header, schema_table, attributes);
        let he_response = hdb_helium.updateRows(datastores, processed_rows);
        let { written_hashes, skipped_hashes } = heProcessResponse(he_response, hdb_terms.OPERATIONS_ENUM.UPDATE);

        return {
            written_hashes,
            skipped_hashes,
            schema_table
        };
    } catch(err) {
        throw err;
    }
}
