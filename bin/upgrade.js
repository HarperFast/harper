'use strict';

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
const os = require('os');
const fs = require('fs');
const CLI = require('clui');
// const request = require("request");
// const request_promise = require("request-promise-native");
const env = require('../utility/environment/environmentManager');
const log = require('../utility/logging/harper_logger');
const hdb_util = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const { promisify } = require('util');
const version = require('./version');
const process_directives = require('../upgrade/processDirectives');
const { spawn } = require('child_process');
const path = require('path');
const fs_extra = require('fs-extra');
const { isHarperRunning } = require('../utility/common_utils');
const hdbInfoController = require('../data_layer/hdbInfoController');
const global_schema = require('../utility/globalSchema');
const upgradePrompt = require('../upgrade/upgradePrompt');

const { UPGRADE_VERSION } = hdb_terms.UPGRADE_JSON_FIELD_NAMES_ENUM

const UPGRADE_DIR_NAME= 'hdb_upgrade';
// const TAR_FILE_NAME = 'hdb-latest.tar';
const EXE_COPY_NAME = 'hdb';
const EXE_NAME = 'harperdb';

// This will be set to the path of the upgrade directory.
let UPGRADE_DIR_PATH = path.join(__dirname, '../', UPGRADE_DIR_NAME);

//Promisified functions
const p_fs_readdir = promisify(fs.readdir);
const p_fs_copyfile = promisify(fs.copyFile);
const p_fs_chmod = promisify(fs.chmod);

// const VERSIONS_URL = 'http://products.harperdb.io/api/latestVersion?os=';
// const DOWNLOAD_URL = 'http://products.harperdb.io/api/update?os=';

let Spinner = CLI.Spinner;
let countdown = new Spinner(`Upgrading HarperDB `, ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);
let p_set_schema_global = promisify(global_schema.setSchemaDataToGlobal);
module.exports = {
    upgrade,
    startUpgrade,
    startUpgradeDirectives,
    listDirectiveChanges
};

let UPGRADE_VERSION_NUM = undefined;
let CURRENT_VERSION_NUM = undefined;

/**
 * Check to see if an instance of HDB is running. Throws an error if running, otherwise it will just return to resolve the promise.
 * @throws
 */
function checkIfRunning() {
    isHarperRunning().then(hdb_running => {
        if(hdb_running) {
            let run_err = "HarperDB is running, please stop HarperDB with 'harperdb stop' and run the upgrade command again.";
            printToLogAndConsole(run_err, log.ERR);
            throw new Error(run_err);
        }
    }).catch(err => {
        throw err;
    });
}

/**
 * Runs the upgrade directives, if needed, for an updated version of HarperDB.
 * @returns {Promise<*>}
 */
async function upgrade(upgrade_obj) {
    log.setLogLevel(log.INFO);
    printToLogAndConsole(`This version of HarperDB is ${version.version()}`);
    if (hdb_util.isEmptyOrZeroLength(env) ) {
        const hdb_not_found_msg = 'The hdb_boot_properties file was not found.  Please install HDB.'
        printToLogAndConsole(hdb_not_found_msg, log.ERR);
        process.exit(1);
    }

    let hdb_upgrade_info = upgrade_obj;
    if (!hdb_upgrade_info) {
        const hdb_upgrade_info = hdbInfoController.getVersionUpdateInfo();
        if (!hdb_upgrade_info) {
            console.log("HarperDB version is current");
            process.exit(0);
        }
    }

    let current_hdb_version = hdb_upgrade_info[UPGRADE_VERSION] ? hdb_upgrade_info[UPGRADE_VERSION] : version.version();
    if(!current_hdb_version) {
        console.log('Current Version field missing from the package.json file.  Cannot continue with upgrade.  If you need support, please contact support@harperdb.io');
        logger.notify('Missing new version field from upgrade info object');
        process.exit(1);
    }

    // check if already running, ends process if error caught.
    try {
        await checkIfRunning();
    } catch(e) {
        console.log(e.message);
        throw e;
    }

    let start_upgrade = await upgradePrompt.forceUpdatePrompt(upgrade_obj);
    if(!start_upgrade) {
        console.log('Cancelled upgrade, closing HarperDB');
        process.exit(1);
    }

    countdown.message(`Starting upgrade to version ${current_hdb_version}`);
    countdown.start();
    log.info(`Starting upgrade to version ${current_hdb_version}`);
    startUpgrade(hdb_upgrade_info);
}

/**
 * This function is called during an upgrade from the existing install's harperdb executable.  We needed to be able to
 * overwrite the existing executable during upgrade as well as reference directive files that are packaged into latest
 * versions.
 * @throws
 * @returns {Promise}
 */
async function startUpgrade(upgrade_obj) {

    try {
        let upgrade_result = await startUpgradeDirectives(upgrade_obj);
        upgrade_result.forEach((result) => {
            logger.info(result);
        });
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
    countdown.stop();
    printToLogAndConsole(`HarperDB was successfully upgraded to version ${upgrade_obj[UPGRADE_VERSION]}`, log.INFO);
}

/**
 * Clean up files that were created during the upgrade process.
 */
// function postInstallCleanUp() {
//     let temp_exe_path = path.join(process.cwd(), EXE_COPY_NAME);
//     try {
//         fs_extra.emptyDirSync(UPGRADE_DIR_PATH);
//         fs_extra.removeSync(temp_exe_path);
//     } catch(e) {
//         let msg = `There was a problem cleaning up the upgrade files.  These can be manually removed from ${UPGRADE_DIR_PATH}`;
//         console.error(msg);
//         log.error(msg);
//     }
// }

/**
 * Call the getLatest API to get the most recent release version of HDB.
 * @param opers
 * @returns {Promise<*>}
 */
// async function getLatestVersion(opers) {
//     let options = {
//         method: 'GET',
//         url: VERSIONS_URL + opers,
//         headers:
//             {
//                 'cache-control': 'no-cache',
//                 'content-type': 'application/json',
//                 'Accept': 'application/json'
//             }
//     };
//     let res = undefined;
//     try {
//         res = await request_promise(options);
//     } catch (e) {
//         log.error(`There was an error with the request to get the latest HDB Build: ${e}`);
//         throw new Error("Error getting latest build");
//     }
//     res = JSON.parse(res);
//     return res[0].product_version;
// }

/**
 * Downloads the latest version of HDB and attempts to install it.
 * @param opers
 * @returns {Promise<void>}
 */
// async function getBuild(opers) {
//     let options = {
//         method: 'GET',
//         url: DOWNLOAD_URL + opers,
//         headers:
//             {
//                 'cache-control': 'no-cache',
//                 'content-type': 'application/json',
//                 'Accept': 'application/json'
//             }
//     };
//     let res = undefined;
//     try {
//         // The request-promise repo recommends using plain old request when piping needs to happen.
//         res = await request(options);
//         let file = await fs.createWriteStream(path.join(UPGRADE_DIR_PATH, TAR_FILE_NAME), {mode: hdb_terms.HDB_FILE_PERMISSIONS});
//         res.pipe(file);
//         file.on('finish', async function() {
//             let tarball = await fs.createReadStream(path.join(UPGRADE_DIR_PATH, TAR_FILE_NAME), {mode: hdb_terms.HDB_FILE_PERMISSIONS}).pipe(tar.extract(UPGRADE_DIR_PATH));
//             tarball.on('finish', async function () {
//                 await copyUpgradeExecutable();
//                 callUpgradeOnNew();
//             });
//         });
//     } catch (e) {
//         log.error(`There was an error with the request to get the latest HDB Build: ${e}`);
//         throw new Error("Error getting latest build" + e);
//     }
// }

/**
 * Get the type of OS this is running on.
 * @returns {*}
 */
// function findOs() {
//     if (os.arch() === 'arm' || os.arch() === 'arm64') {
//         switch (os.release()) {
//             case "armv7l":
//                 return 'ARM 7';
//             case "armv6l":
//                 return 'ARM 6';
//             default:
//                 return null;
//         }
//     }
//     switch (os.platform()) {
//         case "darwin":
//             return 'Mac';
//         case "linux":
//             return 'Linux';
//         default:
//             return null;
//     }
// }

/**
 * Makes a copy of the upgraded HDB executable file so it can be run during the upgrade process.  This file is copied into
 * the existing install's bin directory so it can access the boot props file.
 * @returns {Promise<void>}
 */
// async function copyUpgradeExecutable() {
//     let source_path = path.join(UPGRADE_DIR_PATH, 'HarperDB', 'bin', 'harperdb');
//     // Note we need to rename the new executable to 'hdb', so we don't e overwrite the existing installed executable (yet)
//     let destination_path = path.join(process.cwd(), 'hdb');
//     await p_fs_copyfile(source_path, destination_path).catch((e) => {
//         log.error(e);
//         throw e;
//     });
//     // Need to set perms on new hdb exe.
//     await p_fs_chmod(`${process.cwd()}/${EXE_COPY_NAME}`, hdb_terms.HDB_FILE_PERMISSIONS).catch((e) => {
//         let msg = `Error setting permissions on newest version of HarperDB ${e}`;
//         log.error(msg);
//         throw e;
//     });
// }

/**
 * Run the upgrade directives between the old version and the new version.  This should only be called if there are upgrade
 * directives to run
 * @param old_version_number - The currently installed version number of HDB.
 * @param new_version_number - The latest version being upgraded to.
 * @returns {Array}
 */
function startUpgradeDirectives(upgrade_obj) {
    let directive_results = [];
    try {
        directive_results = process_directives.processDirectives(upgrade_obj);
    } catch(e) {
        throw e;
    }
    return directive_results;
}

/**
 * List the change descriptions for all directives between the old version and the new one.
 * @param old_version_number - The version being replaced
 * @param new_version_number - The new version
 * @returns {Array}
 */
function listDirectiveChanges(upgrade_obj) {
    let directive_change_descriptions = [];
    try {
        directive_change_descriptions = process_directives.getDirectiveChangeDescriptions(upgrade_obj);
    } catch(e) {
        throw e;
    }
    return directive_change_descriptions;
}

/**
 * Makes a backup of the harperdb files.  The backup is placed in the data path in the backups folder.
 */
// function backupCurrInstall() {
//     console.log('Backing up current install files.');
//     let curr_install_base = path.join(process.cwd(), '../');
//     let data_base = env.get(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
//     log.info(`Current install path is: ${curr_install_base}`);
//
//     let backup_path = path.join(data_base, 'backup', `version${(version.version().replace('/./g', '-'))}`);
//     log.info(`Writing backup files to path: ${backup_path}`);
//
//     if(fs.existsSync(backup_path)) {
//         fs_extra.emptyDirSync(backup_path);
//     } else {
//         fs.mkdirSync(backup_path, {mode:  hdb_terms.HDB_FILE_PERMISSIONS});
//     }
//     try {
//         fs_extra.copySync(curr_install_base, backup_path);
//     } catch(err) {
//         console.log(`There was a problem backing up current install.  Please check the logs.  Exiting.`);
//         log.fatal(err);
//         throw err;
//     }
// }

/**
 * Copies the untarred files of the new version into the existing install path.
 */
// function copyNewFilesIntoInstall() {
//     console.log('Copying new install files.');
//     let curr_install_base = path.join(process.cwd(), '../');
//     log.info(`backing up current install files to path: ${curr_install_base}`);
//     let upgrade_base = path.join(UPGRADE_DIR_PATH, 'HarperDB');
//     log.info(`upgrading from path: ${upgrade_base} to install path ${curr_install_base}`);
//     // copy the new files to the current directory.
//     try {
//         fs_extra.copySync(upgrade_base, curr_install_base);
//     } catch(err) {
//         console.log(`There was a problem copying new install files..  Please check the logs.  Exiting.`);
//         log.fatal(err);
//         throw err;
//     }
// }

function printToLogAndConsole(msg, log_level) {
    if(!log_level) {
        log_level = log.info;
    }
    log.write_log(log_level, msg);
    console.log(msg);
}
