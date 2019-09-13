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
    if(global.hdb_helium !== undefined && global.hdb_helium instanceof harperdb_helium){
        return global.hdb_helium;
    }

    let volume_path = env.get('HELIUM_VOLUME_PATH');
    //there is an instance if you do not have a property defined the Properties Reader library will return the string 'null'
    if(utils.isEmptyOrZeroLength(volume_path) || volume_path === 'null'){
        throw new Error('HELIUM_VOLUME_PATH must be defined in config settings.');
    }

    let start_result;
    try {
        global.hdb_helium = new harperdb_helium(false);
        start_result = global.hdb_helium.startSession(terms.HELIUM_URL_PREFIX + env.get('HELIUM_VOLUME_PATH'));
    } catch(e){
        log.error('Error attempting to start Helium: ' + e);
        throw e;
    }

    if(!_.isEqual(start_result, START_SESSION_OK)){
        throw new Error(`Unable to access Helium volume with error code: ${start_result[1]}`);
    }

    return global.hdb_helium;
}

function terminateHelium(helium){
    helium.stopSession(terms.HELIUM_URL_PREFIX + env.get('HELIUM_VOLUME_PATH'));
    delete global.hdb_helium;
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