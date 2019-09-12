'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const heProcessRows = require('../heUtility/heProcessRows');
const hdb_utils = require('../../../../utility/common_utils');
const heliumUtils = require('../../../../utility/helium/heliumUtils');
let hdb_helium = heliumUtils.initializeHelium();

module.exports = createRecords;

async function createRecords(insert_obj) {
    let { schema_table, attributes } = insertUpdateValidate(insert_obj);
    let { datastores, rows } = heProcessRows(insert_obj, attributes, schema_table);
    await checkAttributes(insert_obj.hdb_auth_header, schema_table, attributes);
    let he_response;

    try {
        he_response = hdb_helium.insertRows(datastores, rows);
    } catch(err) {
        throw err;
    }

    let { written_hashes, skipped_hashes } = processHeliumResponse(he_response);

    let return_obj = {
        written_hashes: written_hashes,
        skipped_hashes: skipped_hashes,
        schema_table
    };
}

async function checkAttributes(hdb_auth_header, table_schema, data_attributes) {
    let new_attributes = checkForNewAttributes(table_schema, data_attributes);

    if (hdb_utils.isEmptyOrZeroLength(new_attributes)) {
        return;
    }

}

function processHeliumResponse(he_response) {
    let written_hashes = he_response[0];
    let skipped_hashes = [];
    for (let i = 0; i < he_response[1].length; i++) {
        skipped_hashes.push(he_response[1][i][0]);
    }

    return {
        written_hashes,
        skipped_hashes
    };
}
