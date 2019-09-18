"use strict";

const utils = require('../common_utils');
const _ = require('lodash');
const terms = require('../hdbTerms');
const harperdb_helium = require('../../dependencies/harperdb_helium/test/out/hdb').default;
const system_schema = require('../../json/systemSchema');
const log = require('../logging/harper_logger');
const env = require('../environment/environmentManager');
const fs = require('fs-extra');
if(!env.isInitialized()){
    env.initSync();
}

const START_SESSION_OK = [0, "HE_ERR_OK"];

let helium_server_url = undefined;
module.exports = {
    initializeHelium: initializeHelium,
    terminateHelium: terminateHelium,
    createSystemDataStores: createSystemDataStores,
    getHeliumServerURL: getHeliumServerURL
};

async function getHeliumServerURL(){
    if(helium_server_url !== undefined){
        return helium_server_url;
    }

    let volume_path = env.get(terms.HDB_SETTINGS_NAMES.HELIUM_VOLUME_PATH_KEY);
    //there is an instance if you do not have a property defined the Properties Reader library will return the string 'null'
    if(utils.isEmptyOrZeroLength(volume_path) || volume_path === 'null'){
        throw new Error(`${terms.HDB_SETTINGS_NAMES.HELIUM_VOLUME_PATH_KEY} must be defined in config settings.`);
    }

    let helium_host = env.get(terms.HDB_SETTINGS_NAMES.HELIUM_SERVER_HOST_KEY);
    if(utils.isEmptyOrZeroLength(helium_host) || helium_host === 'null'){
        throw new Error(`${terms.HDB_SETTINGS_NAMES.HELIUM_SERVER_HOST_KEY} must be defined in config settings.`);
    }

    try {
        await fs.access(volume_path, fs.constants.F_OK | fs.constants.R_OK | fs.constants.W_OK);
    }catch(e){
        if(e.code === 'ENOENT'){
            throw new Error(`invalid path defined in ${terms.HDB_SETTINGS_NAMES.HELIUM_VOLUME_PATH_KEY}`);
        }
        throw e;
    }

    helium_server_url = terms.HELIUM_URL_PREFIX + helium_host + '/' + volume_path;
    return helium_server_url;
}

function initializeHelium(){
    if(global.hdb_helium !== undefined && global.hdb_helium instanceof harperdb_helium){
        return global.hdb_helium;
    }

    let start_result;
    try {
        let helium_url = getHeliumServerURL();
        global.hdb_helium = new harperdb_helium(false);
        start_result = global.hdb_helium.startSession(helium_url);
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
    try {
        let helium_url = getHeliumServerURL();
        helium.stopSession(helium_url);
        delete global.hdb_helium;
    } catch(e){
        log.error(`unable to terminate Helium session due to ${e.message}`);
    }
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