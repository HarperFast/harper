'use strict';

const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const search_validator = require('../../../../validation/searchValidator');
const path = require('path');
const {getBaseSchemaPath} = require('./initializePaths');

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
    let env_base_path = path.join(getBaseSchemaPath(), search_object.schema.toString());
    let environment = await environment_utility.openEnvironment(env_base_path, search_object.table);

    for(let x = 0; x < search_object.hash_values.length; x++){
        search_object.hash_values[x] = search_object.hash_values[x].toString();
    }

    return environment;
}