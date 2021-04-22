"use strict";

const path = require('path');
const colors = require("colors/safe");
const fs = require('fs-extra');
const PropertiesReader = require('properties-reader');
const UpgradeDirective = require('../UpgradeDirective');
const hdb_log = require('../../utility/logging/harper_logger');
const { HDB_SETTINGS_NAMES, HDB_SETTINGS_DEFAULT_VALUES } = require('../../utility/hdbTerms');
const env = require('../../utility/environment/environmentManager');
const common_utils = require('../../utility/common_utils');

const reindex_script = require('./upgrade_scripts/3_0_0_reindex_script');

let directive3_0_0 = new UpgradeDirective('3.0.0');

let directives = [];

//We need these here b/c they are no longer included in hdbTerms.js as of version 3.0.0
const OLD_SETTINGS_KEYS = {
    HTTP_ENABLED_KEY: 'HTTP_ON',
    HTTP_PORT_KEY: 'HTTP_PORT',
    HTTP_SECURE_ENABLED_KEY: 'HTTPS_ON',
    HTTP_SECURE_PORT_KEY: 'HTTPS_PORT'
};

let old_hdb_props;
function getOldPropsValue(prop_name, value_required = false) {
    const old_val =  old_hdb_props.getRaw(prop_name);
    if (common_utils.isNotEmptyAndHasValue(old_val)) {
        return old_val;
    }
    if (value_required) {
        return HDB_SETTINGS_DEFAULT_VALUES[prop_name];
    }
    return '';
}

function updateSettingsFile_3_0_0() {
    old_hdb_props = PropertiesReader(env.getProperty(HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));

    //check to see if new settings keys from 3.0.0 are already there - this means the settings file has been updated but
    // there may have been an error/fail during the reindexing step.
    if (common_utils.isNotEmptyAndHasValue(old_hdb_props.get(HDB_SETTINGS_NAMES.SERVER_PORT_KEY))) {
        const settings_already_updated_msg = 'New settings file for 3.0.0 upgrade has already been successfully created.';
        console.log(settings_already_updated_msg);
        hdb_log.info(settings_already_updated_msg);
        return settings_already_updated_msg;
    }

    const settings_update_msg = 'Updating settings file for version 3.0.0';
    console.log(settings_update_msg);
    hdb_log.info(settings_update_msg);

    const http_secure_enabled_old = getOldPropsValue(OLD_SETTINGS_KEYS.HTTP_SECURE_ENABLED_KEY);
    const http_secure_port_old = getOldPropsValue(OLD_SETTINGS_KEYS.HTTP_SECURE_PORT_KEY);
    const http_enabled_old = getOldPropsValue(OLD_SETTINGS_KEYS.HTTP_ENABLED_KEY);
    const http_port_old = getOldPropsValue(OLD_SETTINGS_KEYS.HTTP_PORT_KEY);

    const http_secure_enabled_new = http_secure_enabled_old.toString().toLowerCase() === 'true';
    const server_port_new = http_secure_enabled_new ? http_secure_port_old : http_port_old;

    if (http_enabled_old && http_secure_enabled_old) {
        console.log(colors.magenta("HarperDB 3.0.0 does not allow HTTP and HTTPS to be enabled at the same time. This upgrade has enabled " +
            "HTTPS and disabled HTTP. You can modify this in config/settings.js."));
    }

    let new_hdb_settings_vals = `   ;Settings for the HarperDB process.\n` +
        `\n` +
        `   ;The directory harperdb has been installed in.\n` +
        `${HDB_SETTINGS_NAMES.PROJECT_DIR_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.PROJECT_DIR_KEY)}\n` +
        `   ;The directory selected during install where the database files reside.\n` +
        `${HDB_SETTINGS_NAMES.HDB_ROOT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.HDB_ROOT_KEY)}\n` +
        `   ;The port the HarperDB REST interface will listen on.\n` +
        `${HDB_SETTINGS_NAMES.SERVER_PORT_KEY} = ${server_port_new}\n` +
        `   ;Set to true to enable HTTPS on the HarperDB REST endpoint.  Requires a valid certificate and key.\n` +
        `${HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY} = ${http_secure_enabled_new}\n` +
        `   ;The path to the SSL certificate used when running with HTTPS enabled.\n` +
        `${HDB_SETTINGS_NAMES.CERT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CERT_KEY)}\n` +
        `   ;The path to the SSL private key used when running with HTTPS enabled.\n` +
        `${HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY)}\n` +
        `   ;Set to true to enable Cross Origin Resource Sharing, which allows requests across a domain.\n` +
        `${HDB_SETTINGS_NAMES.CORS_ENABLED_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CORS_ENABLED_KEY)}\n` +
        `   ;Allows for setting allowable domains with CORS. Comma separated list.\n` +
        `${HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY)}\n` +
        `   ;Length of time in milliseconds after which a request will timeout.  Defaults to 120,000 ms (2 minutes).\n` +
        `${HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY, true)}\n` +
        `   ;The number of milliseconds of inactivity a server needs to wait for additional incoming data, after it has finished writing the last response.  Defaults to 5,000 ms (5 seconds).\n` +
        `${HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY, true)}\n` +
        `   ;Limit the amount of time the parser will wait to receive the complete HTTP headers..  Defaults to 60,000 ms (1 minute).\n` +
        `${HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY, true)}\n` +
        `   ;Set to control amount of logging generated.  Accepted levels are trace, debug, warn, error, fatal.\n` +
        `${HDB_SETTINGS_NAMES.LOG_LEVEL_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.LOG_LEVEL_KEY)}\n` +
        `   ;Setting LOGGER to 1 uses the WINSTON logger.\n` +
        `   ; 2 Uses the more performant PINO logger.\n` +
        `${HDB_SETTINGS_NAMES.LOGGER_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.LOGGER_KEY)}\n` +
        `   ;The path where log files will be written. If there is no file name included in the path, the log file will be created by default as 'hdb_log.log' \n` +
        `${HDB_SETTINGS_NAMES.LOG_PATH_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.LOG_PATH_KEY)}\n` +
        `   ;Set to true to enable daily log file rotations - each log file name will be prepended with YYYY-MM-DD (for WINSTON logger only).\n` +
        `${HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY)}\n` +
        `   ;Set the number of daily log files to maintain when LOG_DAILY_ROTATE is enabled. If no integer value is set, no limit will be set for\n` +
        `   ;daily log files which may consume a large amount of storage depending on your log settings.\n` +
        `${HDB_SETTINGS_NAMES.LOG_MAX_DAILY_FILES_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.LOG_MAX_DAILY_FILES_KEY)}\n` +
        `   ;The environment used by NodeJS.  Setting to production will be the most performant, settings to development will generate more logging.\n` +
        `${HDB_SETTINGS_NAMES.PROPS_ENV_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.PROPS_ENV_KEY)}\n` +
        `   ;This allows self signed certificates to be used in clustering.  This is a security risk\n` +
        `   ;as clustering will not validate the cert, so should only be used internally.\n` +
        `   ;The HDB install creates a self signed certificate, if you use that cert this must be set to true.\n` +
        `${HDB_SETTINGS_NAMES.ALLOW_SELF_SIGNED_SSL_CERTS} = ${getOldPropsValue(HDB_SETTINGS_NAMES.ALLOW_SELF_SIGNED_SSL_CERTS, true)}\n` +
        `   ;Set the max number of processes HarperDB will start.  This can also be limited by number of cores and licenses.\n` +
        `${HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES} = ${getOldPropsValue(HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES)}\n` +
        `   ;Set to true to enable clustering.  Requires a valid enterprise license.\n` +
        `${HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY, true)}\n` +
        `   ;The port that will be used for HarperDB clustering.\n` +
        `${HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY)}\n` +
        `   ;The name of this node in your HarperDB cluster topology.  This must be a value unique from the rest of your cluster node names.\n` +
        `${HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)}\n` +
        `   ;The user used to connect to other instances of HarperDB, this user must have a role of cluster_user. \n` +
        `${HDB_SETTINGS_NAMES.CLUSTERING_USER_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CLUSTERING_USER_KEY)}\n` +
        `   ;Defines if this instance does not record transactions. Note, if Clustering is enabled and Transaction Log is disabled your nodes will not catch up.  \n` +
        `${HDB_SETTINGS_NAMES.DISABLE_TRANSACTION_LOG_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.DISABLE_TRANSACTION_LOG_KEY, true)}\n` +
        `   ;Defines the length of time an operation token will be valid until it expires. Example values: https://github.com/vercel/ms  \n` +
        `${HDB_SETTINGS_NAMES.OPERATION_TOKEN_TIMEOUT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.OPERATION_TOKEN_TIMEOUT_KEY, true)}\n` +
        `   ;Defines the length of time a refresh token will be valid until it expires. Example values: https://github.com/vercel/ms  \n` +
        `${HDB_SETTINGS_NAMES.REFRESH_TOKEN_TIMEOUT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.REFRESH_TOKEN_TIMEOUT_KEY, true)}\n`
    ;

    const settings_path = env.get('settings_path');
    const settings_dir = path.dirname(settings_path);
    const settings_backup_path =  path.join(settings_dir, '3_0_0_upgrade_settings.bak');

    try {
        //create backup of old settings file
        hdb_log.info(`Backing up old settings file to: ${settings_backup_path}`);
        fs.copySync(settings_path, settings_backup_path);

    } catch(err) {
        console.error('There was a problem writing the backup for the old settings file.  Please check the log for details.');
        throw err;
    }

    try {
        hdb_log.info(`New settings file values for 3.0.0 upgrade: ${JSON.stringify(new_hdb_settings_vals)}`);
        hdb_log.info(`Creating new/upgraded settings file at '${settings_path}'`);

        fs.writeFileSync(settings_path, new_hdb_settings_vals);
        hdb_log.info('Updating env variables with new settings values');
    } catch(err) {
        console.error('There was a problem writing the new settings file. Please check the log for details.');
        console.log("Attempting to reset the settings file to its original state.  Use the '.bak' file if this fails.");
        fs.copySync(settings_backup_path, settings_path);
        throw err;
    }

    // load new props into env
    env.initSync();

    const upgrade_success_msg = 'New settings file for 3.0.0 upgrade successfully created.';
    console.log(upgrade_success_msg);
    hdb_log.info(upgrade_success_msg);

    return upgrade_success_msg;
}

directive3_0_0.sync_functions.push(updateSettingsFile_3_0_0);
directive3_0_0.async_functions.push(reindex_script);

directives.push(directive3_0_0);

module.exports = directives;
