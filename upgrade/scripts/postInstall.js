"use strict";

const fs = require('fs');
const os = require('os');
const terms = require('../../utility/hdbTerms');
const path = require('path');
const version = require('../../bin/version');
const {UpgradeObject} = require('../UpgradeObjects');

console.log('Running HarperDB postinstall scripts');
let homedir = os.homedir();
if(!homedir) {
    console.error('Could not determine this users home directory.  Please set your $HOME environment variable');
    process.exit(1);
}
let update_config_path = undefined;
try {
    update_config_path = path.join(homedir, terms.HDB_HOME_DIR_NAME, terms.UPDATE_FILE_NAME);
    if(!update_config_path) {
        console.error(`Failed to determine path to $HOME/${terms.HDB_HOME_DIR_NAME}/${terms.UPDATE_FILE_NAME} directory.  ${terms.SUPPORT_HELP_MSG}`);
        process.exit(1);
    }
    let upgrade_object = new UpgradeObject();
    if(!fs.existsSync(update_config_path)) {
        console.error(`Could not found ${terms.UPDATE_FILE_NAME} upgrade file, cant perform upgrade without the ${terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION} specified.  ${terms.SUPPORT_HELP_MSG}`);
        // We want to move forward despite not having a current version written so the file will be written.  This will notify the user an upgrade needs to be performed.
    }
    let curr_version = undefined;
    let data = fs.readFileSync(update_config_path, 'utf8');
    curr_version = JSON.parse(data)[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION];
    let ver = version.version();
    upgrade_object[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = ver;
    upgrade_object[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION] = curr_version;
    if(ver !== curr_version) {
        fs.writeFileSync(update_config_path, JSON.stringify(upgrade_object));
        console.log('wrote update config file to ' + update_config_path);
    } else {
        // We have matching versions, this is either a reinstall or an upgrade was run and not needed.  Delete the file.
        try {
            console.info('matching versions, removing ugprade file.');
            fs.unlinkSync(update_config_path);
        } catch(err) {
            console.error(`Could not remove upgrade file ${update_config_path}.  Please manually delete this file and restart HarperDB.`);
            process.exit(1);
        }
    }
} catch(err) {
    console.error('error writing file.');
    console.error(err);
}

process.exit(0);