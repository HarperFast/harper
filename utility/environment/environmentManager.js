"use strict"

const fs = require('fs');
const PropertiesReader = require('properties-reader');
const log = require('../logging/harper_logger');
const common_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const {promisify} = require('util');

const PROPS_FILE_PATH = `${process.cwd()}/../hdb_boot_properties.file`;

// Promisified functions
const p_fs_access = promisify(fs.access);
const p_fs_stat = promisify(fs.stat);

const defaults = {};

for(let key of Object.keys(hdb_terms.HDB_SETTINGS_NAMES)) {
    let setting_val = hdb_terms.HDB_SETTINGS_NAMES[key];
    let default_val = hdb_terms.HDB_SETTINGS_DEFAULT_VALUES[setting_val];
    if(default_val) {
        defaults[setting_val] = default_val;
    }
}

module.exports = {
    PROPS_FILE_PATH,
    getProperty:getProperty,
    init: init
};

let hdb_properties = undefined;
let property_values = Object.create(null);

/**
 * Used to get a value of a stored HDB property.  Will return null if the name parameter is invalid or undefined.
 * @param prop_name
 * @returns {*}
 */
function getProperty(prop_name) {
    if(common_utils.isEmptyOrZeroLength(prop_name)) {
        log.info(`Invalid parameter ${prop_name} passed in getProperty().`)
        return null;
    }
    try {
        return property_values[prop_name];
    } catch (e) {
        log.warn(`Property ${prop_name} is undefined.`);
        return null;
    }
}

/**
 * This function stores the setting values found in a globally accessible key store.  Currently this is
 * the node global object, though this may change to the database or another object.
 * @param variable_name - The variable name to be stored
 * @param value - The variable value to be stored.
 */
function storeVariableValue(variable_name, value) {
    if(variable_name) {
        property_values[variable_name] = value;
    }
}

/**
 * Look in the hdb_properties file to find a value for the specified environment variable.  If a value is not found,
 * a default value will be stored if it exists.
 * @param variable_name
 * @returns {null}
 */
function readEnvVariable(variable_name) {
    try {
        if(common_utils.isEmptyOrZeroLength(variable_name)) {
            log.info('Tried to read an empty environment variable name');
            return;
        }
        let env_value = hdb_properties.get(variable_name);
        if (common_utils.isEmptyOrZeroLength(env_value) || env_value === 0) {
            log.warn(`A value was not found for ${variable_name}, using default value: ${defaults[variable_name]}`);
            env_value = defaults[variable_name];
        }
        if(env_value) {
            storeVariableValue(variable_name, env_value);
        }
    } catch(err) {
        log.error('hdb properties is null, did you initialize the environment manager?');
    }
}

/**
 * Read the path to the private key.  If file is not found or is inaccessible, Harper will log an error and close.
 */
async function readPrivateKeyPath() {
    let private_key_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY);
    if( common_utils.isEmptyOrZeroLength(private_key_path) || private_key_path === 0) {
        let error_msg = `A value was not found for ${hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY}, Please correct the value in your settings file and restart HarperDB.  Exiting HarperDB.`;
        throw new Error(error_msg);
    }

    try {
        await p_fs_access(private_key_path, fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The certificate file at path ${private_key_path} does not exist.  Exiting Harper DB.`;
        throw new Error(error_msg);
    }
    storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY, private_key_path);
}

/**
 * Read the path to the certificate file.  If file is not found or is inaccessible, Harper will log an error and close.
 */
async function readCertPath() {
    let cert_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY);
    if( common_utils.isEmptyOrZeroLength(cert_path) || cert_path === 0) {
        let error_msg = `A value was not found for ${hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY}, Please correct the value in your settings file and restart HarperDB.  Exiting HarperDB.`;
        throw new Error(error_msg);
    }

    try {
        await p_fs_access(cert_path, fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The certificate file at path ${cert_path} does not exist.  Exiting Harper DB.`;
        throw new Error(error_msg);
    }
    storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY, cert_path);
}

/**
 * Read the root path of Harper DB.  If the path is not defined or not found, Harper will log an error and exit.
 */
async function readRootPath() {
    let root_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
    if( common_utils.isEmptyOrZeroLength(root_path) || root_path === 0) {
        let error_msg = `A value was not found for ${hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY}, Please correct the value in your settings file.  Exiting HarperDB.`;
        throw new Error(error_msg);
    }
    let stats = undefined;
    try {
        stats = await p_fs_stat(root_path);
    } catch(e) {
        let error_msg = `The specified root path ${root_path} does not exist.  Please change this to the correct path to HarperDB. in your settings file. Exiting Harper DB.`;
        throw new Error(error_msg);
    }
    if(stats && stats.isDirectory()) {
        storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, root_path);
    } else {
        let error_msg = `The specified root path ${root_path} does not exist.  Please change this to the correct path to HarperDB. in your settings file. Exiting Harper DB.`;
        log.fatal(`The specified root path ${root_path} does not exist.  Please change this to the correct path to HarperDB. in your settings file. Exiting Harper DB.`);
        throw new Error(error_msg);
    }
}

/**
 * Read the hdb_boot_properties.file to get the path to the settings.js file.  If either of these files is not found, Harper will log an error and exit.
 */
// This function always needs to be called first during init, as it loads the settings file.
async function readPropsFile() {
    try {
        await p_fs_access(PROPS_FILE_PATH, fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The properties file at path ${PROPS_FILE_PATH} does not exist.  Exiting Harper DB.`;
        log.error(e);
        throw new Error(error_msg);
    }

    hdb_properties = PropertiesReader(PROPS_FILE_PATH);
    storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
    await readSettingsFile();
}

/**
 * Read the settings file path specified in the hdb_boot_props file.
 * @returns {Promise<void>}
 */
async function readSettingsFile() {
    try {
        await p_fs_access(hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY), fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The settings file at path ${PROPS_FILE_PATH} does not exist.  Exiting Harper DB.`;
        throw new Error(error_msg);
    }

    hdb_properties.append(hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
}

async function init() {
    try {
        await readPropsFile();
        /** Read the desired server timeout setting.  Default is 120000 ms. */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.PROPS_SERVER_TIMEOUT_KEY);
        /** Read the project path. If the path is not defined or not found, Harper will log an error and exit. */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.PROJECT_DIR_KEY);
        await readRootPath();
        /** Read the desired HTTP port.  Default is 9925 */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.HTTP_PORT_KEY);
        /** Reads the desired Secure HTTP port.  Default is 31283 */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.HTTP_SECURE_PORT_KEY);
        await readCertPath();
        await readPrivateKeyPath();
        /** Read if Secure HTTP (HTTPS) is enabled.  Default is true (enabled). */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY);
        /** Read if HTTP is enabled.  Default is false (disabled). */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.HTTP_ENABLED_KEY);
        /** Read if CORS is enabled.  Default is true (enabled). */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.CORS_ENABLED_KEY);
        /** Read the whitelist for CORS.  Default is an empty list. */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY);
        /** Read the desired log level for the logger.  Default is error. */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY);
        /** Read the desired logger to be used by HarperDB. Default is 1 (WINSTON */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.LOGGER_KEY);
        /** Read the desired path for the log file. Default is ./harper_log.log. */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
        /** Read the variable used to set the nodejs runtime environment value. Default is production */
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.PROPS_ENV_KEY);
        // Read the variable used to enable clustering
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY);
        // Read the variable used to set the port used in clustering
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY);
        // Read the variable used to set the node name in clustering.
        readEnvVariable(hdb_terms.HDB_SETTINGS_NAMES.NODE_NAME_KEY);
    } catch(err) {
        let msg = `Error reading in HDB environment variables from path ${PROPS_FILE_PATH}.  Please check your boot props and settings files`;
        log.fatal(msg);
        log.error(err);
        throw new Error(msg);
    }
}

//Initialize the environment manager.
/*
init()
    .then( () => {
        harper_logger.info("initialized environment logger with no issues.");
    })
    .catch( (err) => {
        harper_logger.error(err);
        process.exit(1);
    });
*/

