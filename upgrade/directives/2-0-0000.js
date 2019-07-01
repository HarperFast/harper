"use strict";
const path = require('path');
const env_variable = require('../EnvironmentVariable');
const upgrade_directive = require('../UpgradeDirective');
const fs = require('fs');
let directive = new upgrade_directive('2.0.000');

const KEYS_FILE_NAME = '060493.ks';
let home_dir = process.env['HOME'];
let new_keys_dir_path = `${home_dir}/.harperdb/keys`;
// Create the ~/.harperdb directory
directive.explicit_directory_paths.push(`${home_dir}/.harperdb`);
// Create the ~/.harperdb/keys directory
directive.explicit_directory_paths.push(new_keys_dir_path);

directive.environment_variables.push(
    new env_variable(`CLUSTERING_USER`, ``, [`The user used to connect to other instances of HarperDB, this user must have a role of cluster_user`])
);

directive.environment_variables.push(
    new env_variable(`LOG_DAILY_ROTATE`, `false`, [`Set to true to enable daily log file rotations - each log file name will be prepended with YYYY-MM-DD (for WINSTON logger only)=`])
);

directive.environment_variables.push(
    new env_variable(`LOG_MAX_DAILY_FILES`, `false`, [`Set the number of daily log files to maintain when LOG_DAILY_ROTATE is enabled`,
    'If no integer value is set, no limit will be set for',
    'daily log files which may consume a large amount of storage depending on your log settings'])
);

// Move the utilities/keys/060493.ks file to its new home in ~/.harperdb/keys/
directive.functions.push(() => {
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

module.exports = directive;