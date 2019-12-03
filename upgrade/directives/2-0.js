"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');
const hdb_utils = require('../../utility/common_utils');
const fs = require('fs');
const {HDB_SETTINGS_NAMES, HDB_SETTINGS_DEFAULT_VALUES, CLUSTERING_FOLDER_NAMES_ENUM} = require('../../utility/hdbTerms');
let directive2_0_0 = new upgrade_directive('2.0.000');
let directives = [];
const env = require('../../utility/environment/environmentManager');
if(!env.isInitialized()) {
    env.initSync();
}

const KEYS_FILE_NAME = '060493.ks';
let home_dir = process.env['HOME'];
let new_keys_dir_path = `${home_dir}/.harperdb/keys`;
let hdb_root = env.get('HDB_ROOT');

// Create the ~/.harperdb directory
directive2_0_0.explicit_directory_paths.push(`${home_dir}/.harperdb`);
// Create the ~/.harperdb/keys directory
directive2_0_0.explicit_directory_paths.push(new_keys_dir_path);

// If directive is called at install root does not exist, in that case skip creating folders.
if (!hdb_utils.isEmpty(hdb_root)) {
    // Create the ~/hdb/clustering/connections directory
    let connections_dir_path = path.join(hdb_root, CLUSTERING_FOLDER_NAMES_ENUM.CLUSTERING_FOLDER, CLUSTERING_FOLDER_NAMES_ENUM.CONNECTIONS_FOLDER);
    directive2_0_0.explicit_directory_paths.push(connections_dir_path);
    // Create the ~/hdb/clustering/transaction_log directory
    let transaction_log_dir_path = path.join(hdb_root, CLUSTERING_FOLDER_NAMES_ENUM.CLUSTERING_FOLDER, CLUSTERING_FOLDER_NAMES_ENUM.TRANSACTION_LOG_FOLDER);
    directive2_0_0.explicit_directory_paths.push(transaction_log_dir_path);
}

directive2_0_0.environment_variables.push(
    new env_variable(`${HDB_SETTINGS_NAMES.CLUSTERING_USER_KEY}`, ``, [`The user used to connect to other instances of HarperDB, this user must have a role of cluster_user`])
);

directive2_0_0.environment_variables.push(
    new env_variable(`${HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY}`, `false`, [`Set to true to enable daily log file rotations - each log file name will be prepended with YYYY-MM-DD (for WINSTON logger only)=`])
);

directive2_0_0.environment_variables.push(
    new env_variable(`${HDB_SETTINGS_NAMES.HELIUM_VOLUME_PATH_KEY}`, ``, [`Specify the file system path to where the Helium volume will reside.`])
);

directive2_0_0.environment_variables.push(
    new env_variable(`${HDB_SETTINGS_NAMES.LOG_MAX_DAILY_FILES_KEY}`, `false`, [`Set the number of daily log files to maintain when LOG_DAILY_ROTATE is enabled`,
    'If no integer value is set, no limit will be set for',
    'daily log files which may consume a large amount of storage depending on your log settings'])
);

directive2_0_0.environment_variables.push(
    new env_variable(`${HDB_SETTINGS_NAMES.HELIUM_SERVER_HOST}`, HDB_SETTINGS_DEFAULT_VALUES.HELIUM_SERVER_HOST,
        [`specify the host & port where your helium server is running. NOTE for most installs this will not change from ${HDB_SETTINGS_DEFAULT_VALUES.HELIUM_SERVER_HOST}`])
);

// Move the utilities/keys/060493.ks file to its new home in ~/.harperdb/keys/
directive2_0_0.functions.push(() => {
    let old_keys_path = undefined;
    let new_keys_path = undefined;
    try {
        // Assuming upgrade is being run out of bin/
        old_keys_path = path.join(`${process.cwd()}`, '../', 'utility', 'keys', KEYS_FILE_NAME);
        console.log(`Checking for ${KEYS_FILE_NAME} file at ${old_keys_path}`);
        if (!fs.existsSync(old_keys_path)) {
            old_keys_path = path.join(`${process.cwd()}`, '../', 'utility', 'keys', KEYS_FILE_NAME);
            console.log(`${KEYS_FILE_NAME} file not found.  Trying path ${old_keys_path}`);
            if (!fs.existsSync(old_keys_path)) {
                console.log(`${KEYS_FILE_NAME} file not found.  If you have an enterprise license, please manually move the /utilities/keys/${KEYS_FILE_NAME} into ~/.harperdb/keys/.`);
                return;
            }
        }
        let home_dir = process.env['HOME'];
        if (!home_dir) {
            console.log(`Your environment HOME directory is not defined.  If you have an enterprise license, please manually move the /utilities/keys/${KEYS_FILE_NAME} into ~/.harperdb/keys/.`);
        }
        new_keys_path = path.join(new_keys_dir_path, KEYS_FILE_NAME);
        fs.renameSync(old_keys_path, new_keys_path);
    } catch(err) {
        console.error(`There was an error upgrading to version 2.0.  Upgrade will continue, but you may need to manually move your ${old_keys_path} file to ${new_keys_path}`);
        console.error(err);
    }
});

directives.push(directive2_0_0);

module.exports = directives;