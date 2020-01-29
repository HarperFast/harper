'use strict';

const SearchByHashObject = require('../../../SearchByHashObject');

const search_utility = require('../../../../utility/lmdb/searchUtility');
const hash_search_init = require('../lmdbUtility/initializeHashSearch');

module.exports = lmdbSearchByHash;

/**
 * fetches records by their hash values and returns an Array of the results
 * @param {SearchByHashObject} search_object
 */
async function lmdbSearchByHash(search_object) {
    try {
        let environment = await hash_search_init(search_object);
        const table_info = global.hdb_schema[search_object.schema][search_object.table];
        return search_utility.batchSearchByHash(environment, table_info.hash_attribute, search_object.get_attributes, search_object.hash_values);
    } catch(err) {
        throw err;
    }
}