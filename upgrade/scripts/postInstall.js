"use strict";

/**
 * This script should be run by npm after the install is complete.  It will determine if upgrade directives need to be run and
 * create a file denoting to core that an upgrade needs to be run.
 * @type {module:fs}
 */
const fs = require('fs');
const os = require('os');
const terms = require('../../utility/hdbTerms');
const path = require('path');
const version = require('../../bin/version');
const {UpgradeObject} = require('../UpgradeObjects');
const env = require('../../utility/environment/environmentManager');
const {compareVersions} = require('../../utility/common_utils');
const SUCCESS = 0;
const FAILURE = 1;

const SCHEMA_DIR_NAME = 'schema';
const DATA_VERSION_FIELD_NAME = 'data_version_num';

console.log('Running HarperDB postinstall scripts');
let homedir = os.homedir();
if(!homedir) {
    console.error('Could not determine this users home directory.  Please set your $HOME environment variable');
    process.exit(FAILURE);
}

// If there is no hdb_boot_props file, then assume this is a new install.
let boot_props_path = path.join(homedir, terms.HDB_HOME_DIR_NAME, terms.BOOT_PROPS_FILE_NAME);
if(!fs.existsSync(boot_props_path)) {
    console.log(`${boot_props_path} not found.  This seems to beq a new install.`);
    console.log(`Finished downloading HarperDB.  Complete the installation by running 'harperdb' if you installed globally.`);
    process.exit(SUCCESS);
}
env.initSync();
let update_config_path = undefined;
try {
    update_config_path = path.join(homedir, terms.HDB_HOME_DIR_NAME, terms.UPDATE_FILE_NAME);
    if(!update_config_path) {
        console.error(`Failed to determine path to $HOME/${terms.HDB_HOME_DIR_NAME}/${terms.UPDATE_FILE_NAME} directory.  ${terms.SUPPORT_HELP_MSG}`);
        process.exit(FAILURE);
    }
    let upgrade_object = new UpgradeObject();
    let curr_version = getCurrentVersion();
    if(!curr_version) {
        // no current version found, must be a new install.
        process.exit(SUCCESS);
    }
    let ver = version.version();
    upgrade_object[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = ver;
    upgrade_object[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION] = curr_version;

    if(compareVersions(ver, curr_version) < 0) {
        console.error(`You have installed a version lower than version that your data was created on.  This may cause issues.  ${terms.SUPPORT_HELP_MSG}`);
        process.exit(FAILURE);
    }

    if(ver !== curr_version) {
        fs.writeFileSync(update_config_path, JSON.stringify(upgrade_object));
        console.log('wrote update config file to ' + update_config_path);
    } else {
        // We have matching versions, this is either a reinstall or an upgrade was run and not needed.  Delete the file.
        try {
            // try to remove the file just in case it exists.  OK if this fails.
            fs.unlinkSync(update_config_path);
        } catch(err) {
            //no-op
        }
    }

} catch(err) {
    console.error('error writing file.');
    console.error(err);
    process.exit(FAILURE);
}

/**
 * Gets the version installed before the update.  Used to populate the .updateConfig.json file.
 * @returns version string.
 */
function getCurrentVersion() {
    //TODO: This call might not work depending on how the build affects the binary structure.
    let curr_version = undefined;
    let info_dir_path = path.join(env.getHdbBasePath(),
        SCHEMA_DIR_NAME,
        terms.SYSTEM_SCHEMA_NAME,
        terms.HDB_INFO_TABLE_NAME,
        DATA_VERSION_FIELD_NAME
    );
    try {
        let files = fs.readdirSync(info_dir_path);
        if(!files|| files.length === 0) {
            return curr_version;
        }
        curr_version = files[0];
        for(let i=1; i<files.length; i++) {
            if(compareVersions(files[i], curr_version) > 0) {
                curr_version = files[i];
            }
        }
    } catch(err) {
        console.log(`HDB Info table not found at ${info_dir_path}.`);
    }
    return curr_version;
}

process.exit(SUCCESS);