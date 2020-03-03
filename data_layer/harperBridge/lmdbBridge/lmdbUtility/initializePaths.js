'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const env = require('../../../../utility/environment/environmentManager');
const path = require('path');

if(!env.isInitialized()){
    env.initSync();
}

let BASE_SCHEMA_PATH = undefined;
let SYSTEM_SCHEMA_PATH = undefined;


/**
 * when HDB is not yet installed we do not yet know the base path and an error is thrown if we do a standard const, so we create a getter
 * @returns {string|*}
 */
function getBaseSchemaPath(){
    if(BASE_SCHEMA_PATH !== undefined){
        return BASE_SCHEMA_PATH;
    }

    if(env.getHdbBasePath() !== undefined){
        BASE_SCHEMA_PATH = path.join(env.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);
        return BASE_SCHEMA_PATH;
    }
}

/**
 * when HDB is not yet installed we do not yet know the base path and an error is thrown if we do a standard const, so we create a getter
 * @returns {string|*}
 */
function getSystemSchemaPath(){
    if(SYSTEM_SCHEMA_PATH !== undefined){
        return SYSTEM_SCHEMA_PATH;
    }

    if(env.getHdbBasePath() !== undefined){
        SYSTEM_SCHEMA_PATH = path.join(getBaseSchemaPath(), hdb_terms.SYSTEM_SCHEMA_NAME);
        return SYSTEM_SCHEMA_PATH;
    }
}

module.exports = {
    getBaseSchemaPath,
    getSystemSchemaPath
};