'use strict';

/**
 * The upgrade module is used to facilitate the upgrade process for existing instances of HDB that pull down a new version
 * of HDB from NPM that requires a specific upgrade script be run - e.g. there are changes required for the settings.js
 * config file, a data model change requires a re-indexing script is run, etc.
 */

const env = require('../utility/environment/environmentManager');
env.initSync();

const CLI = require('clui');
const colors = require("colors/safe");
const fs = require('fs-extra');
const log = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');
const version = require('./version');
const directivesManager = require('../upgrade/directivesManager');
const hdb_utils = require('../utility/common_utils');
const hdbInfoController = require('../data_layer/hdbInfoController');
const upgradePrompt = require('../upgrade/upgradePrompt');

const { UPGRADE_VERSION } = hdb_terms.UPGRADE_JSON_FIELD_NAMES_ENUM;

let Spinner = CLI.Spinner;
let countdown = new Spinner(`Upgrading HarperDB `, ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);

module.exports = {
    upgrade
};

/**
 * Runs the upgrade directives, if needed, for an updated version of HarperDB.
 *
 * @param upgrade_obj - optional
 * @returns {Promise<void>}
 */
async function upgrade(upgrade_obj) {
    printToLogAndConsole(`This version of HarperDB is ${version.version()}`);
    if (!fs.existsSync(env.BOOT_PROPS_FILE_PATH)) {
        const hdb_not_found_msg = 'The hdb_boot_properties file was not found.  Please install HDB.';
        printToLogAndConsole(hdb_not_found_msg, log.ERR);
        process.exit(1);
    }

    let hdb_upgrade_info = upgrade_obj;
    if (!hdb_upgrade_info) {
        hdb_upgrade_info = await hdbInfoController.getVersionUpdateInfo();
        if (!hdb_upgrade_info) {
            console.log("HarperDB version is current");
            process.exit(0);
        }
    }

    //The upgrade version should always be included in the hdb_upgrade_info object returned from the getVersion function
    // above but testing for it and using the version from package.json just in case it is not
    let current_hdb_version = hdb_upgrade_info[UPGRADE_VERSION] ? hdb_upgrade_info[UPGRADE_VERSION] : version.version();
    if(!current_hdb_version) {
        console.log(`Current Version field missing from the package.json file.  Cannot continue with upgrade.  If you need support, please contact ${hdb_terms.HDB_SUPPORT_ADDRESS}`);
        log.notify('Missing new version field from upgrade info object');
        process.exit(1);
    }

    // check if already running, ends process if error caught.
    await checkIfRunning();

    let start_upgrade;

    let exit_code = 0;
    try {
        start_upgrade = await upgradePrompt.forceUpdatePrompt(hdb_upgrade_info);
    } catch(err) {
        log.error('There was an error when prompting user about upgrade.');
        log.error(err);
        start_upgrade = false;
        exit_code = 1;
    }

    if(!start_upgrade) {
        console.log('Cancelled upgrade, closing HarperDB');
        process.exit(exit_code);
    }

    countdown.message(`Starting upgrade to version ${current_hdb_version}`);
    countdown.start();
    log.info(`Starting upgrade to version ${current_hdb_version}`);

    await runUpgrade(hdb_upgrade_info);

    countdown.stop();
    printToLogAndConsole(`HarperDB was successfully upgraded to version ${hdb_upgrade_info[UPGRADE_VERSION]}`, log.INFO);
}

/**
 * Check to see if an instance of HDB is running. Throws an error if running, otherwise it will just return to resolve the promise.
 * @throws
 */
async function checkIfRunning() {
    const hdb_running = await hdb_utils.isHarperRunning();
    if (hdb_running) {
        let run_err = "HarperDB is running, please stop HarperDB with 'harperdb stop' and run the upgrade command again.";
        console.log(colors.red(run_err));
        log.error(run_err);
        process.exit(1);
    }
}

/**
 * This function is called during an upgrade to execute the applicable upgrade directives based on the data and current
 * version info passed within the `upgrade_obj` argument.  After the upgrade is completed, a new record is inserted into
 * the hdb_info table to track the version info for the instance's data and software.
 *
 * @param upgrade_obj
 * @returns {Promise<void>}
 */
async function runUpgrade(upgrade_obj) {

    try {
        directivesManager.processDirectives(upgrade_obj);
    } catch(err) {
        printToLogAndConsole('There was an error during the data upgrade.  Please check the logs.', log.error);
        throw(err);
    }

    try {
        await hdbInfoController.insertHdbUpgradeInfo(upgrade_obj[UPGRADE_VERSION]);
    } catch(err) {
        log.error("Error updating the 'hdb_info' system table.");
        log.error(err);
    }
}

function printToLogAndConsole(msg, log_level) {
    if(!log_level) {
        log_level = log.info;
    }
    log.write_log(log_level, msg);
    console.log(msg);
}
