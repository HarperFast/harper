"use strict";

const fs = require('fs');
const os = require('os');
const terms = require('../../utility/hdbTerms');
const path = require('path');
const version = require('../../bin/version');
const {UpgradeObject} = require('../UpgradeObjects');

console.log('Running HarperDB preinstall scripts');
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
    let ver = version.version();
    console.log(`Storing version: ${ver}`);
    upgrade_object[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION] = ver;

    fs.writeFileSync(update_config_path, JSON.stringify(upgrade_object), {mode: terms.HDB_FILE_PERMISSIONS});
} catch(err) {
    console.error('error writing file.');
    console.error(err);
}

console.log('wrote update config file to ' + update_config_path);
process.exit(0);