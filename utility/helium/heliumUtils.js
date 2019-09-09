"use strict";

const utils = require('../common_utils');
const _ = require('lodash');
const terms = require('../hdbTerms');
const harperdb_helium = require('../../dependencies/harperdb_helium/test/out/hdb').default;
const system_schema = require('../../json/systemSchema');
const log = require('../logging/harper_logger');
const env = require('../environment/environmentManager');
if(!env.isInitialized()){
    env.initSync();
}

const START_SESSION_OK = [0, "HE_ERR_OK"];

module.exports = {
    initializeHelium: initializeHelium,
    terminateHelium: terminateHelium,
    createSystemDataStores: createSystemDataStores
};

function initializeHelium(){
    if(utils.isEmptyOrZeroLength(env.get('HELIUM_VOLUME_PATH'))){
        throw new Error('HELIUM_VOLUME_PATH must be defined in config settings.');
    }

    let helium = new harperdb_helium(false);
    let start_result = helium.startSession(terms.HELIUM_URL_PREFIX + env.get('HELIUM_VOLUME_PATH'));
    if(!_.isEqual(start_result, START_SESSION_OK)){
        throw new Error(`Unable to access Helium volume with error code: ${start_result[1]}`);
    }

    return helium;
}

function terminateHelium(helium){
    helium.stopSession(terms.HELIUM_URL_PREFIX + env.get('HELIUM_VOLUME_PATH'));
}

function createSystemDataStores(){
    try {
        log.info('Creating HarperDB System datastores');
        let helium = initializeHelium();
        let data_stores = [];
        //build the attribute array list from the systemSchema.json
        Object.keys(system_schema).forEach(table_key=>{
            let table = system_schema[table_key];
            let schema_table = `${table.schema}/${table.name}`;
            table.attributes.forEach(attribute=>{
                data_stores.push(`${schema_table}/${attribute.attribute}`);
            });
        });

        helium.createDataStores(data_stores);

        terminateHelium(helium);
        log.info('Created system level data stores');
    }catch(e){
        log.error(`Creating system data stores failed due to ${e}`);
        throw e;
    }
}