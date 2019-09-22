'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const heProcessRows = require('../heUtility/heProcessRows');
const hdb_terms = require('../../../../utility/hdbTerms');



module.exports = heUpdateRecords;

function heUpdateRecords(update_obj) {
    try {
        let { schema_table, hashes, attributes } = insertUpdateValidate(update_obj);
        let { datastores, rows } = heProcessRows(update_obj, attributes, schema_table);

        if (update_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
            if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME)) {
                attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME);
            }

            if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME)) {
                attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME);
            }
        }





    } catch(err) {
        throw err;
    }

}