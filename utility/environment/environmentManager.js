"use strict";

const fs = require('fs-extra');
const PropertiesReader = require('properties-reader');
const log = require('../logging/harper_logger');
const common_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const path = require('path');
const os = require('os');
const minimist = require('minimist');

let BOOT_PROPS_FILE_PATH = common_utils.getPropsFilePath();
let initialized = false;
let data_store_type = undefined;
const defaults = {};

for(let key of Object.keys(hdb_terms.HDB_SETTINGS_NAMES)) {
    let setting_val = hdb_terms.HDB_SETTINGS_NAMES[key];
    let default_val = hdb_terms.HDB_SETTINGS_DEFAULT_VALUES[setting_val];
    if(default_val) {
        defaults[setting_val] = default_val;
    }
}

module.exports = {
    BOOT_PROPS_FILE_PATH,
    getHdbBasePath: getHdbBasePath,
    setPropsFilePath: setPropsFilePath,
    get:get,
    getProperty:getProperty,
    initSync,
    setProperty: setProperty,
    append: append,
    writeSettingsFileSync,
    initTestEnvironment : initTestEnvironment,
    isInitialized: isInitialized,
    getDataStoreType
};

let hdb_properties = PropertiesReader();
let property_values = Object.create(null);

/**
 * The base path of the HDB install is often referenced, but is referenced as a const variable at the top of many
 * modules.  This is a problem during install, as the path may not yet be defined.  We offer a function to get the
 * currently known base path here to help with this case.
 */
function getHdbBasePath() {
    return property_values['HDB_ROOT'];
}

/**
 * Wrapper for getProperty to make replacing PropertiesReader easier in the code base.
 */
function setPropsFilePath(path_value) {
    if(common_utils.isEmptyOrZeroLength(path_value)) {
        log.info(`Invalid parameter ${path_value} passed to props setter.`);
        return null;
    }
    try {
        BOOT_PROPS_FILE_PATH = path_value;
    } catch (e) {
        log.warn(`Path is invalid.`);
        return null;
    }
}

function isInitialized(){
    return initialized;
}

/**
 * Wrapper for getProperty to make replacing PropertiesReader easier in the code base.
 */
function get(prop_name) {
    if(common_utils.isEmptyOrZeroLength(prop_name)) {
        log.info(`Invalid parameter ${prop_name} passed in getProperty().`);
        return null;
    }
    try {
        return getProperty(prop_name);
    } catch (e) {
        log.warn(`Property ${prop_name} is undefined.`);
        return null;
    }
}

/**
 * Used to get a value of a stored HDB property.  Will return null if the name parameter is invalid or undefined.
 * @param prop_name
 * @returns {*}
 */
function getProperty(prop_name) {
    if(common_utils.isEmptyOrZeroLength(prop_name)) {
        log.info(`Invalid parameter ${prop_name} passed in getProperty().`);
        return null;
    }
    try {
        let value = property_values[prop_name];
        if(!value) {
            value = hdb_properties.get(prop_name);
        }
        return value;
    } catch (e) {
        log.warn(`Property ${prop_name} is undefined.`);
        return null;
    }
}

/**
 * Set a property, name matches PropertiesReader for easier migration
 */
function append(prop_name, value) {
    if(common_utils.isEmptyOrZeroLength(prop_name)) {
        log.info(`Invalid parameter for setProperty`);
    }
    try {
        setProperty(prop_name, value);
    } catch(e) {
        log.error(`Failed to set property ${prop_name}.`);
    }
}

/**
 * Set a property
 */
function setProperty(prop_name, value) {
    if(common_utils.isEmptyOrZeroLength(prop_name)) {
        log.info(`Invalid parameter for setProperty`);
    }
    try {
        hdb_properties.set(prop_name, value);
        storeVariableValue(prop_name, value);
    } catch(e) {
        log.error(`Failed to set property ${prop_name}.`);
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
            return null;
        }
        let env_value = hdb_properties.get(variable_name);
        if (common_utils.isEmptyOrZeroLength(env_value) || env_value === 0) {
            log.info(`A value was not found for ${variable_name}, using default value: ${defaults[variable_name]}`);
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
function readPrivateKeyPath() {
    let private_key_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY);
    if( common_utils.isEmptyOrZeroLength(private_key_path) || private_key_path === 0) {
        let error_msg = `A value was not found for ${hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY}, Please correct the value in your settings file and restart HarperDB.  Exiting HarperDB.`;
        log.error(error_msg);
        return;
    }

    try {
        fs.accessSync(private_key_path, fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The certificate file at path ${private_key_path} does not exist.  Exiting Harper DB.`;
        log.error(error_msg);
        return;
    }
    storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY, private_key_path);
}

/**
 * Read the path to the certificate file.  If file is not found or is inaccessible, Harper will log an error and close.
 */
function readCertPath() {
    let cert_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY);
    if( common_utils.isEmptyOrZeroLength(cert_path) || cert_path === 0) {
        let error_msg = `A value was not found for ${hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY}, Please correct the value in your settings file and restart HarperDB.  Exiting HarperDB.`;
        log.error(error_msg);
        return;
    }

    try {
        fs.accessSync(cert_path, fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The certificate file at path ${cert_path} does not exist.  Exiting Harper DB.`;
        log.error(error_msg);
        return;
    }
    storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY, cert_path);
}

/**
 * Read the root path of Harper DB.  If the path is not defined or not found, Harper will log an error and exit.
 */
function readRootPath() {
    let root_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
    if( common_utils.isEmptyOrZeroLength(root_path) || root_path === 0) {
        let error_msg = `A value was not found for ${hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY}, Please correct the value in your settings file.  Exiting HarperDB.`;
        throw new Error(error_msg);
    }
    let stats = undefined;
    try {
        stats = fs.statSync(root_path);
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
// This function always needs to be called first during initSync, as it loads the settings file.
function readPropsFile() {
    try {
        fs.accessSync(BOOT_PROPS_FILE_PATH, fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The properties file at path ${BOOT_PROPS_FILE_PATH} does not exist.  Setting up defaults.`;
        log.info(error_msg);
        log.error(e);
        //throw new Error(error_msg);
        storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY, log.DEBUG);
        storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, '../run_log.log');
        return false;
    }

    hdb_properties = PropertiesReader(BOOT_PROPS_FILE_PATH);
    storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
    storeVariableValue(hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER, hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER));
    readSettingsFile();
    return true;
}

/**
 * Read the settings file path specified in the hdb_boot_props file.
 */
function readSettingsFile() {
    try {
        fs.accessSync(hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY), fs.constants.F_OK | fs.constants.R_OK);
    } catch(e) {
        let error_msg = `The settings file at path ${hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY)} does not exist.`;
        log.error(error_msg);
    }

    hdb_properties.append(hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
}

/**
 * Write currently stored settings into the settings file
 */
function writeSettingsFileSync(create_backup_bool) {
    let settings_file_path = hdb_properties.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);
    if(!settings_file_path) {
        log.error(`No value found for the settings file path.`);
        throw new Error(`No path found for config file.`);
    }
    if(create_backup_bool) {
        try {
            fs.copyFileSync(settings_file_path, `${settings_file_path}.bak`);
        } catch(err) {
            throw err;
        }
    }
    try {
        // The global hdb_props file holds the settings_path and install_user which is from the hdb_boot_props file, we
        // dont want to write those so we clone it and delete them.
        let copy = hdb_properties.clone();
        try {
            delete copy._properties['settings_path'];
            delete copy._properties['install_user'];
            fs.writeFileSync(settings_file_path, common_utils.stringifyProps(copy, null));
        } catch(err) {
            log.error(err);
        }

    } catch(err) {
        log.error(`Had a problem writing new settings.`);
        throw err;
    }
}

/**
 * evaluates what data store type HDB is using, default is LMDB.  first will check the system.user directory, chosen because it will always hold data post install.  if it has a file named data.mdb we are lmdb, otherwise fs.
 * if there is no user folder then we check if there is a data_store argument from the command line, used for install.
 */
function getDataStoreType(){
    if(data_store_type !== undefined){
        return data_store_type;
    }

    //set lmdb as the default
    data_store_type = hdb_terms.STORAGE_TYPES_ENUM.LMDB;

    let readdir_results = undefined;
    try {
        let user_path = path.join(getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME, hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME);
        readdir_results = fs.readdirSync(user_path);
        let is_lmdb = false;
        for(let x = 0; x < readdir_results.length; x++){
            //LMDB will have a file called data.mdb
            if(readdir_results[x] === 'data.mdb'){
                is_lmdb = true;
                break;
            }
        }

        if(is_lmdb === true){
            data_store_type = hdb_terms.STORAGE_TYPES_ENUM.LMDB;
        } else{
            data_store_type = hdb_terms.STORAGE_TYPES_ENUM.FILE_SYSTEM;
        }
    }catch(e){
        //if there is no user folder we check if the command line is stating file system
        // eslint-disable-next-line no-magic-numbers
        const ARGS = minimist(process.argv.slice(2));
        if(ARGS['data_store'] === hdb_terms.STORAGE_TYPES_ENUM.FILE_SYSTEM){
            data_store_type = hdb_terms.STORAGE_TYPES_ENUM.FILE_SYSTEM;
        }
    }

    return data_store_type;
}

function initSync() {
    try {
        //if readPropsFile returns false, we are installing and don't need to read anything yet.
        if(readPropsFile()) {
            readRootPath();
            readCertPath();
            readPrivateKeyPath();
            //These settings are read in separate function calls above to handle file IO errors.
            let ignore_settings = [hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY, hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY, hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY];
            let keys = Object.keys(hdb_terms.HDB_SETTINGS_NAMES);
            for (let i = 0; i < keys.length; i++) {
                let key = keys[i];
                let value = hdb_terms.HDB_SETTINGS_NAMES[key];
                if (ignore_settings.includes(value)) {
                    continue;
                }
                readEnvVariable(value);
            }
        }
        initialized = true;
    } catch(err) {
        let msg = `Error reading in HDB environment variables from path ${BOOT_PROPS_FILE_PATH}.  Please check your boot props and settings files`;
        log.fatal(msg);
        log.error(err);
    }
}

function initTestEnvironment(test_config_obj = {}) {
    try {
        const { keep_alive_timeout, headers_timeout, server_timeout, https_enabled, cors_enabled, cors_whitelist } = test_config_obj;
        let props_path = process.cwd();
        props_path = path.join(props_path, '../', 'unitTests');
        setPropsFilePath(`${props_path}/hdb_boot_properties.file`);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, `${props_path}/settings.test`);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.INSTALL_USER, os.userInfo().username);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY, `${props_path}/envDir/utility/keys/privateKey.pem`);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.CERT_KEY, `${props_path}/envDir/utility/keys/certificate.pem`);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY, `debug`);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, `${props_path}/envDir/log/hdb_log.log`);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY, false);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY, 'TRUE');
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY, '1231412de213');
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, `${props_path}/envDir/`);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY, common_utils.isEmpty(https_enabled) ? true : https_enabled);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_PORT_KEY, 9925);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.CORS_ENABLED_KEY, common_utils.isEmpty(cors_enabled) ? false : cors_enabled);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.IPC_SERVER_PORT, 9383);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES, 2);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY, 9926);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY, true);
        setProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY, path.resolve(__dirname, '../../unitTests/server/customFunctions/custom_functions'));
        if (cors_whitelist) {
            setProperty(hdb_terms.HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY, cors_whitelist);
        }
        if (server_timeout) {
            setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY, server_timeout);
        }
        if (keep_alive_timeout) {
            setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY, keep_alive_timeout);
        }
        if (headers_timeout) {
            setProperty(hdb_terms.HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY, headers_timeout);
        }

        data_store_type = hdb_terms.STORAGE_TYPES_ENUM.FILE_SYSTEM;
    } catch(err) {
        let msg = `Error reading in HDB environment variables from path ${BOOT_PROPS_FILE_PATH}.  Please check your boot props and settings files`;
        log.fatal(msg);
        log.error(err);
    }
}
