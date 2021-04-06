'use strict';

//TODO - rewrite code comment
/**
 * The upgrade process is a two part process, where the first upgrade call is made against the currently installed
 * version of harperDB in the /bin directory as ./harperdb upgrade.  Upgrade will call the LMS to get the latest version
 * of HDB, compare with the currently installed version to see if an upgrade is needed.  If needed, It will check for any
 * running instances of HDB and cancel the upgrade until they are stopped.  It will then download the tarball of the
 * latest version of HDB and untar it into an upgrade/ directory.
 *
 * Once they are stopped, it will call startUpgrade() on the newly downloaded version of HDB in upgrade/, and then stop
 * the currently running process.
 *
 * startUpgrade() will read in the current environemnt variable settings, create an upgrade log file, run the upgrade directives
 * stored in the new versions, swap the /bin/harperdb with /upgrade/harperdb by moving /bin/harperdb to <install_path>/trash.
 *
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
 * Runs the upgrade directives, if needed, for an updated version of HarperDB.
 * @returns {Promise<*>}
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
        console.log('Current Version field missing from the package.json file.  Cannot continue with upgrade.  If you need support, please contact support@harperdb.io');
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
 * This function is called during an upgrade from the existing install's harperdb executable.  We needed to be able to
 * overwrite the existing executable during upgrade as well as reference directive files that are packaged into latest
 * versions.
 * @throws
 * @returns {Promise}
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
        log.error('Error updating the hdbInfo version table.');
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
