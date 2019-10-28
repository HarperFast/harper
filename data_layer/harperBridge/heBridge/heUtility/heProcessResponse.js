'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
module.exports = heProcessResponse;

/**
 * The Helium API returns a multi-dimensional array. This function transforms that response into appropriate message
 * The only response error codes accepted is if the item does or does not exist.
 * @param he_response
 * @param action
 * @returns {{skipped_hashes: *, written_hashes: *}}
 */
function heProcessResponse(he_response, action) {
    let records_count;
    let plural;
    let processed_hashes = [];
    for(let x = 0; x < he_response[0].length; x++){
        processed_hashes.push(hdb_utils.autoCast(he_response[0][x]));
    }

    let skipped_hashes = [];

    for (let i = 0; i < he_response[1].length; i++) {
        if (he_response[1][i][1][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_ITEM_EXISTS && he_response[1][i][1][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_ITEM_NOT_FOUND) {
            throw new Error(he_response[1][i][1][1]);
        }

        skipped_hashes.push(hdb_utils.autoCast(he_response[1][i][0]));
    }

    switch (action) {
        case hdb_terms.OPERATIONS_ENUM.INSERT:
        case hdb_terms.OPERATIONS_ENUM.UPDATE:
            return {
                written_hashes: processed_hashes,
                skipped_hashes
            };
        case hdb_terms.OPERATIONS_ENUM.DELETE:
            records_count = processed_hashes.length;
            plural = (records_count === 1) ? 'record' : 'records';
            return {
                message: `${records_count} ${plural} successfully deleted`,
                deleted_hashes: processed_hashes,
                skipped_hashes
            };
    }
}
