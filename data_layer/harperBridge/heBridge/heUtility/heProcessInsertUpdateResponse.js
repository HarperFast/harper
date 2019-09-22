'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = heProcessInsertUpdateResponse;

/**
 * Helium API returns a multi-dimensional array from the createRecords and updateRecords call. This function transforms that response
 * into two arrays, one with hashes of written records the other with hashes of skipped records due to them
 * already existing. The only error code accepted is if the item already exists.
 * @param he_response
 * @returns {{skipped_hashes: *, written_hashes: *}}
 */
function heProcessInsertUpdateResponse(he_response) {
    let written_hashes = he_response[0];
    let skipped_hashes = [];

    for (let i = 0; i < he_response[1].length; i++) {
        if (he_response[1][i][1][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_ITEM_EXISTS) {
            throw new Error(he_response[1][i][1][1]);
        }

        skipped_hashes.push(he_response[1][i][0]);
    }

    return {
        written_hashes,
        skipped_hashes
    };
}
