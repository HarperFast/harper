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
const tar = require('tar-fs');
const CLI = require('clui');
const request = require("request");
const request_promise = require("request-promise-native");
const env = require('../utility/environment/environmentManager');
const log = require('../utility/logging/harper_logger');
const hdb_util = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const { promisify } = require('util');
const version = require('./version');
const process_directives = require('../upgrade/processDirectives');
const {spawn} = require('child_process');
const path = require('path');
const fs_extra = require('fs-extra');
const { isHarperRunning } = require('../utility/common_utils');
const hdbInfoController = require('../data_layer/hdbInfoController');

const UPGRADE_DIR_NAME= 'hdb_upgrade';
const TAR_FILE_NAME = 'hdb-latest.tar';
const EXE_COPY_NAME = 'hdb';
const EXE_NAME = 'harperdb';

// This will be set to the path of the upgrade directory.
let UPGRADE_DIR_PATH = path.join(__dirname, '../', UPGRADE_DIR_NAME);

//Promisified functions
const p_fs_readdir = promisify(fs.readdir);
const p_fs_copyfile = promisify(fs.copyFile);
const p_fs_chmod = promisify(fs.chmod);

const VERSIONS_URL = 'http://products.harperdb.io/api/latestVersion?os=';
const DOWNLOAD_URL = 'http://products.harperdb.io/api/update?os=';

let Spinner = CLI.Spinner;
let countdown = new Spinner(`Upgrading HarperDB `, ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);

module.exports = {
    upgrade: upgrade,
    startUpgrade: startUpgrade,
    upgradeFromFilePath:upgradeFromFilePath
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
            let run_err = 'HarperDB is running, please stop HarperDB with /bin/harperdb stop and run the upgrade command again.';
            printToLogAndConsole(run_err, log.ERR);
            throw new Error(run_err);
        }
    }).catch(err => {
        throw err;
    });
}

/**
 * Call the startUpgrade function on the untared latest version of HDB.
 */
function callUpgradeOnNew() {
    let spawn_target =
        `${process.cwd()}/${EXE_COPY_NAME}`;
    try {
        let child = spawn(spawn_target, [hdb_terms.SERVICE_ACTIONS_ENUM.UPGRADE_EXTERN], {
            stdio: ['ignore', 'ignore', 'ignore']
        }).unref();
    } catch(e) {
        printToLogAndConsole(e, log.ERR);
    }
    // Should terminate after this spawn
    process.exit();
}

async function upgradeFromFilePath(file_path) {
    // Extract the tar file, use the 'finish' event to kick off the upgrade process.
    if(!fs.existsSync(file_path)) {
        printToLogAndConsole(`Upgrade tar file at path ${file_path} not found.  Stopping upgrade.`);
        throw new Error(`Upgrade file not found.`);
    }
    let tarball = await fs.createReadStream(file_path, {mode: hdb_terms.HDB_FILE_PERMISSIONS}).pipe(tar.extract(UPGRADE_DIR_PATH));
    tarball.on('finish', async function () {
        printToLogAndConsole(`Finished extracting tar file at path: ${file_path}`);
        await copyUpgradeExecutable();
        startUpgrade();
    });
    tarball.on('error', (err) => {
        printToLogAndConsole(`There was an error extracting the upgrade tar file at path: ${file_path}`);
        log.error(err);
        throw new Error(`Error unpacking upgrade file.`);
    });
}

/**
 * Upgrades the currently installed version of harperdb by calling the LMS to get the version number of the most recently
 * release version of HDB.  If an upgrade is possible, it will download the latest version, untar it, then call the
 * newest version of the harperdb executable to complete the upgrade.
 * @returns {Promise<*>}
 */
async function upgrade() {
    log.setLogLevel(log.INFO);
    printToLogAndConsole(`This version of HarperDB is ${version.version()}`, log.INFO);
    if(hdb_util.isEmptyOrZeroLength(env) ) {
        printToLogAndConsole('the hdb_boot_properties file was not found.  Please install HDB.', log.ERR);
        throw new Error('the hdb_boot_properties file was not found.  Please install HDB.');
    }

    // check if already running, ends process if error caught.
    try {
        await checkIfRunning();
    } catch(e) {
        console.log(e.message);
        throw e;
    }

    let opers = findOs();
    if (!opers) {
        printToLogAndConsole('You are attempting to upgrade HarperDB on an unsupported operating system', log.ERR);
        throw new Error('You are attempting to upgrade HarperDB on an unsupported operating system');
    }
    let latest_version = await getLatestVersion(opers).catch((e) => {
        log.error(e);
        console.error(`Error getting latest version from HarperDB: ${e}`);
        throw e;
    });

    if(hdb_util.compareVersions(version.version(), latest_version) === 0) {
        return "HarperDB version is current";
    }
    countdown.message(`Starting upgrade to version ${latest_version}`);
    countdown.start();
    log.info(`Starting upgrade to version ${latest_version}`);
    // Remove any existing upgrade/ directory path files
    let upgrade_dir_stat = await p_fs_readdir(UPGRADE_DIR_PATH).catch((e) => {
        // no-op
    });

    if(upgrade_dir_stat) {
        await hdb_util.removeDir(UPGRADE_DIR_PATH).catch((e) => {
           printToLogAndConsole(`Got an error trying to remove the upgrade/ directory.  Please manually delete the directory and 
           it's contents and re-run upgrade. ${e}`, log.ERR);
           return;
        });
    }

    try {
        fs.mkdirSync(UPGRADE_DIR_PATH, {mode:  hdb_terms.HDB_FILE_PERMISSIONS});
    } catch(e) {
        printToLogAndConsole(`Got an error trying to create the upgrade directory. ${e}`, log.ERR);
    }
    try {
        await getBuild(opers);
    } catch(err) {
        printToLogAndConsole(err, log.ERR);
        throw err;
    }
}

/**
 * This function is called during an upgrade from the existing install's harperdb executable.  We needed to be able to
 * overwrite the existing executable during upgrade as well as reference directive files that are packaged into latest
 * versions.
 * @throws
 * @returns {Promise}
 */
async function startUpgrade() {
    try {
        let curr_version_path = path.join(process.cwd(), '../', 'package.json');
        let curr_package_json = fs.readFileSync(curr_version_path, 'utf8');
        CURRENT_VERSION_NUM = JSON.parse(curr_package_json).version;
    } catch(e) {
        printToLogAndConsole('Error loading the currently installed version number');
        log.error(e);
    }

    let upgrade_package_path = path.join(UPGRADE_DIR_PATH, 'HarperDB', 'package.json');
    printToLogAndConsole(`package path is ${upgrade_package_path}`, log.INFO);
    console.log(`Upgrade path is ${UPGRADE_DIR_PATH}`);

    let upgrade_package_json = undefined;
    try {
        upgrade_package_json = fs.readFileSync(upgrade_package_path, 'utf8');
        UPGRADE_VERSION_NUM = JSON.parse(upgrade_package_json).version;
        printToLogAndConsole(`Starting upgrade process from version ${CURRENT_VERSION_NUM} to version ${UPGRADE_VERSION_NUM}`, log.INFO);
    } catch(err) {
        console.error(`could not find package at path ${upgrade_package_path}`);
        printToLogAndConsole(err, log.ERR);
        throw err;
    }

    try {
        backupCurrInstall();
    } catch(err) {
        // Error logging happens in backup.
        throw err;
    }

    let upgrade_result = undefined;
    try {
        upgrade_result = startUpgradeDirectives(CURRENT_VERSION_NUM, UPGRADE_VERSION_NUM);
    } catch(e) {
        // since we dont currently support any kind of rollback, just keep moving forward.
        printToLogAndConsole(`There was a problem running upgrade instructions.  Installation will continue and try to correct the problem.  ${e}`, log.ERR);
    }

    try {
        copyNewFilesIntoInstall();
    } catch(err) {
        // Error logging happens in copy.
        throw err;
    }
    let exe_path = path.join(process.cwd(), EXE_NAME);
    log.info(`Calling chmod on ${exe_path}`);
    try {
        fs.chmodSync(exe_path, hdb_terms.HDB_FILE_PERMISSIONS);
    } catch(e) {
        let msg = `Unable to set permissions ${ hdb_terms.HDB_FILE_PERMISSIONS} on ${exe_path}.  Please set the permissions using the command chmod ${ hdb_terms.HDB_FILE_PERMISSIONS} ${exe_path}`;
        log.error(msg);
        console.error(msg);
    }

    // Logging and exception handling occurs in postInstallCleanUp.
    postInstallCleanUp();
    version.refresh();
    try {
        await hdbInfoController.updateHdbInfo(version.version());
    } catch(err) {
        log.error('Error updating the hdbInfo version table.');
        log.error(err);
    }
    countdown.stop();
    printToLogAndConsole(`HarperDB was successfully upgraded to version ${version.version()}`, log.INFO);
}

/**
 * Clean up files that were created during the upgrade process.
 */
function postInstallCleanUp() {
    let temp_exe_path = path.join(process.cwd(), EXE_COPY_NAME);
    try {
        fs_extra.emptyDirSync(UPGRADE_DIR_PATH);
        fs_extra.removeSync(temp_exe_path);
    } catch(e) {
        let msg = `There was a problem cleaning up the upgrade files.  These can be manually removed from ${UPGRADE_DIR_PATH}`;
        console.error(msg);
        log.error(msg);
    }
}

/**
 * Call the getLatest API to get the most recent release version of HDB.
 * @param opers
 * @returns {Promise<*>}
 */
async function getLatestVersion(opers) {
    let options = {
        method: 'GET',
        url: VERSIONS_URL + opers,
        headers:
            {
                'cache-control': 'no-cache',
                'content-type': 'application/json',
                'Accept': 'application/json'
            }
    };
    let res = undefined;
    try {
        res = await request_promise(options);
    } catch (e) {
        log.error(`There was an error with the request to get the latest HDB Build: ${e}`);
        throw new Error("Error getting latest build");
    }
    res = JSON.parse(res);
    return res[0].product_version;
}

/**
 * Downloads the latest version of HDB and attempts to install it.
 * @param opers
 * @returns {Promise<void>}
 */
async function getBuild(opers) {
    let options = {
        method: 'GET',
        url: DOWNLOAD_URL + opers,
        headers:
            {
                'cache-control': 'no-cache',
                'content-type': 'application/json',
                'Accept': 'application/json'
            }
    };
    let res = undefined;
    try {
        // The request-promise repo recommends using plain old request when piping needs to happen.
        res = await request(options);
        let file = await fs.createWriteStream(path.join(UPGRADE_DIR_PATH, TAR_FILE_NAME), {mode: hdb_terms.HDB_FILE_PERMISSIONS});
        res.pipe(file);
        file.on('finish', async function() {
            let tarball = await fs.createReadStream(path.join(UPGRADE_DIR_PATH, TAR_FILE_NAME), {mode: hdb_terms.HDB_FILE_PERMISSIONS}).pipe(tar.extract(UPGRADE_DIR_PATH));
            tarball.on('finish', async function () {
                await copyUpgradeExecutable();
                callUpgradeOnNew();
            });
        });
    } catch (e) {
        log.error(`There was an error with the request to get the latest HDB Build: ${e}`);
        throw new Error("Error getting latest build" + e);
    }
}

/**
 * Get the type of OS this is running on.
 * @returns {*}
 */
function findOs() {
    if (os.arch() === 'arm' || os.arch() === 'arm64') {
        switch (os.release()) {
            case "armv7l":
                return 'ARM 7';
            case "armv6l":
                return 'ARM 6';
            default:
                return null;
        }
    }
    switch (os.platform()) {
        case "darwin":
            return 'Mac';
        case "linux":
            return 'Linux';
        default:
            return null;
    }
}

/**
 * Makes a copy of the upgraded HDB executable file so it can be run during the upgrade process.  This file is copied into
 * the existing install's bin directory so it can access the boot props file.
 * @returns {Promise<void>}
 */
async function copyUpgradeExecutable() {
    let source_path = path.join(UPGRADE_DIR_PATH, 'HarperDB', 'bin', 'harperdb');
    // Note we need to rename the new executable to 'hdb', so we don't e overwrite the existing installed executable (yet)
    let destination_path = path.join(process.cwd(), 'hdb');
    await p_fs_copyfile(source_path, destination_path).catch((e) => {
        log.error(e);
        throw e;
    });
    // Need to set perms on new hdb exe.
    await p_fs_chmod(`${process.cwd()}/${EXE_COPY_NAME}`, hdb_terms.HDB_FILE_PERMISSIONS).catch((e) => {
        let msg = `Error setting permissions on newest version of HarperDB ${e}`;
        log.error(msg);
        throw e;
    });
}

/**
 *
 * @param old_version_number - The currently installed version number of HDB.
 * @param new_version_number - The latest version being upgraded to.
 * @returns {Array}
 */
function startUpgradeDirectives(old_version_number, new_version_number) {
    let directive_results = [];
    try {
        directive_results = process_directives.processDirectives(old_version_number, new_version_number);
    } catch(e) {
        throw e;
    }
    return directive_results;
}

/**
 * Makes a backup of the harperdb files.  The backup is placed in the data path in the backups folder.
 */
function backupCurrInstall() {
    console.log('Backing up current install files.');
    let curr_install_base = path.join(process.cwd(), '../');
    let data_base = env.get(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
    log.info(`Current install path is: ${curr_install_base}`);

    let backup_path = path.join(data_base, 'backup', `version${(version.version().replace('/./g', '-'))}`);
    log.info(`Writing backup files to path: ${backup_path}`);

    if(fs.existsSync(backup_path)) {
        fs_extra.emptyDirSync(backup_path);
    } else {
        fs.mkdirSync(backup_path, {mode:  hdb_terms.HDB_FILE_PERMISSIONS});
    }
    try {
        fs_extra.copySync(curr_install_base, backup_path);
    } catch(err) {
        console.log(`There was a problem backing up current install.  Please check the logs.  Exiting.`);
        log.fatal(err);
        throw err;
    }
}

/**
 * Copies the untarred files of the new version into the existing install path.
 */
function copyNewFilesIntoInstall() {
    console.log('Copying new install files.');
    let curr_install_base = path.join(process.cwd(), '../');
    log.info(`backing up current install files to path: ${curr_install_base}`);
    let upgrade_base = path.join(UPGRADE_DIR_PATH, 'HarperDB');
    log.info(`upgrading from path: ${upgrade_base} to install path ${curr_install_base}`);
    // copy the new files to the current directory.
    try {
        fs_extra.copySync(upgrade_base, curr_install_base);
    } catch(err) {
        console.log(`There was a problem copying new install files..  Please check the logs.  Exiting.`);
        log.fatal(err);
        throw err;
    }
}

function printToLogAndConsole(msg, log_level) {
    if(!log_level) {
        log_level = log.info;
    }
    log.write_log(log_level, msg);
    console.log(msg);
}