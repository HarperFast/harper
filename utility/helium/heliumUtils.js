"use strict";

const utils = require('../common_utils');
const _ = require('lodash');
const terms = require('../hdbTerms');
const harperdb_helium = require('../../dependencies/harperdb_helium/test/out/hdb').default;
const system_schema = require('../../json/systemSchema');
const log = require('../logging/harper_logger');
const env = require('../environment/environmentManager');
const ps_list = require('../../utility/psList');
const spawn = require('child_process').spawn;

if(!env.isInitialized()){
    env.initSync();
}

const START_SESSION_OK = [0, "HE_ERR_OK"];

let helium_server_url = undefined;
module.exports = {
    initializeHelium: initializeHelium,
    terminateHelium: terminateHelium,
    createSystemDataStores: createSystemDataStores,
    getHeliumServerURL: getHeliumServerURL,
    checkHeliumServerRunning: checkHeliumServerRunning
};

function getHeliumServerURL(){
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
        throw new Error(`Unable to initialize Helium due to error code: ${start_result[1]}`);
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

function createSystemDataStores(helium){
    try {
        log.info('Creating HarperDB System datastores');

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

        log.info('Created system level data stores');
    }catch(e){
        log.error(`Creating system data stores failed due to ${e}`);
        throw e;
    }
}

/**
 * checks if the helium server is running / available
 * @returns {Promise<void>}
 */
async function checkHeliumServerRunning(){
    let helium_host = env.getProperty(terms.HDB_SETTINGS_NAMES.HELIUM_SERVER_HOST_KEY);
    try {
        //first check if the helium server host is localhost or 127.0.0.1, if so check for the helium process
        if (helium_host.startsWith('localhost') || helium_host.startsWith('127.0.0.1')) {
            let instances = await ps_list.findPs(terms.HELIUM_PROCESS_NAME);
            if(utils.isEmptyOrZeroLength(instances)) {
                log.info('helium server not running, attempting to start helium server');
                spawn(terms.HELIUM_PROCESS_NAME, [terms.HELIUM_START_SERVER_COMMAND], {
                    detached: true,
                    stdio: 'ignore'
                }).unref();

                await utils.checkProcessRunning(terms.HELIUM_PROCESS_NAME);
                log.info('helium server successfully started');
            }
        }

        initializeHelium();
    } catch(e) {
        throw new Error(`unable to access helium due to ${e.message},  please check that ${helium_host} is available and running`);
    }
}

