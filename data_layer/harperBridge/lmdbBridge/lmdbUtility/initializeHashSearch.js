'use strict';

const SearchByHashObject = require('../../../SearchByHashObject');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const search_validator = require('../../../../validation/searchValidator');
const hdb_terms = require('../../../../utility/hdbTerms');
const path = require('path');
const env_mgr = require('../../../../utility/environment/environmentManager');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mgr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);

module.exports = initialize;

/**
 *
 * @param search_object
 * @returns {*}
 */
async function initialize(search_object){
    const validation_error = search_validator(search_object, 'hashes');
    if (validation_error) {
        throw validation_error;
    }
    let env_base_path = path.join(BASE_SCHEMA_PATH, search_object.schema);
    let environment = await environment_utility.openEnvironment(env_base_path, search_object.table);

    for(let x = 0; x < search_object.hash_values.length; x++){
        search_object.hash_values[x] = search_object.hash_values[x].toString();
    }

    return environment;
}