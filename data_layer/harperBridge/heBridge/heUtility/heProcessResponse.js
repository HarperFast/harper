'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = heProcessResponse;

/**
 * The Helium API returns a multi-dimensional array. This function transforms that response
 * into two arrays, written or deleted hashes and skipped. The only response error code accepted is if the item already exists.
 * @param he_response
 * @param action
 * @returns {{skipped_hashes: *, written_hashes: *}}
 */
function heProcessResponse(he_response, action) {
    let processed_hashes = he_response[0];
    let skipped_hashes = [];

    for (let i = 0; i < he_response[1].length; i++) {
        if (he_response[1][i][1][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_ITEM_EXISTS && he_response[1][i][1][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_ITEM_NOT_FOUND) {
            throw new Error(he_response[1][i][1][1]);
        }

        skipped_hashes.push(he_response[1][i][0]);
    }

    if (action === hdb_terms.OPERATIONS_ENUM.INSERT) {
        return {
            written_hashes: processed_hashes,
            skipped_hashes
        };
    } else if (action === hdb_terms.OPERATIONS_ENUM.DELETE) {
        let records_count = processed_hashes.length;
        let plural = (records_count === 1) ? 'record' : 'records';

        return {
            message: `${records_count} ${plural} successfully deleted`,
            deleted_hashes: processed_hashes,
            skipped_hashes
        };
    }
}
