'use strict';

const SearchByHashObject = require('../../../SearchByHashObject');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const search_validator = require('../../../../validation/searchValidator');
const hdb_terms = require('../../../../utility/hdbTerms');
const search_utility = require('../../../../utility/lmdb/searchUtility');
const path = require('path');
const env_mgr = require('../../../../utility/environment/environmentManager');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mgr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);

module.exports = lmdbGetDataByHash;

/**
 * fetches records by their hash values and returns a map of the results
 * @param {SearchByHashObject} search_object
 */
async function lmdbGetDataByHash(search_object) {
    try {
        const validation_error = search_validator(search_object, 'hashes');
        if (validation_error) {
            throw validation_error;
        }
        const table_info = global.hdb_schema[search_object.schema][search_object.table];
        let env_base_path = path.join(BASE_SCHEMA_PATH, search_object.schema);
        let environment = await environment_utility.openEnvironment(env_base_path, search_object.table);

        for(let x = 0; x < search_object.hash_values.length; x++){
            search_object.hash_values[x] = search_object.hash_values[x].toString();
        }

        return search_utility.batchSearchByHashToMap(environment, table_info.hash_attribute, search_object.get_attributes, search_object.hash_values);
    } catch(err) {
        throw err;
    }
}