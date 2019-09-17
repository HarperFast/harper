"use strict";

// const common_utils = require('../../../../utility/common_utils');
// const hdb_terms = require('../../../../utility/hdbTerms');
const heliumUtil = require('../../../../utility/helium/heliumUtils');

module.exports = heGetAttributeValues;

function heGetAttributeValues(hash_values, data_stores) {
    try {
        // TODO: remove helium references here after helium initialization process is figured out
        const helium = heliumUtil.initializeHelium();
        const search_results = helium.searchByKeys(hash_values, data_stores);
        heliumUtil.terminateHelium(helium);

        return search_results;
    } catch(err) {
        throw err;
    }
}