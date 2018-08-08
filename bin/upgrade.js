'use strict';

/**
 * The upgrade process is a two part process, where the first upgrade call is made against the currently installed
 * version of harperDB in the /bin directory as ./harperdb upgrade.  Upgrade will call the LMS to get the latest version
 * of HDB, compare with the currently installed version to see if an upgrade is needed.  If needed, It will check for any
 * running instances of HDB and cancel the upgrade until they are stopped.  It will then download the tarball of the
 * latest version of HDB and untar it into an upgrade/ directory.
 *
 * Once they are stopped, it will call upgradeExternal() on the newly downloaded version of HDB in upgrade/, and then stop
 * the currently running process.
 *
 * upgradeExternal() will read in the current environemnt variable settings, create an upgrade log file, run the upgrade directives
 * stored in the new versions, swap the /bin/harperdb with /upgrade/harperdb by moving /bin/harperdb to <install_path>/trash.
 *
 */
const os = require('os');
const mkdirp = require('mkdirp');
const fs = require('fs');
const http = require('http');
const tar = require('tar-fs');
const CLI = require('clui');
const request = require("request");
const request_promise = require("request-promise-native");
const PropertiesReader = require('properties-reader');
const log = require('../utility/logging/harper_logger');
const hdb_util = require('../utility/common_utils');
const { promisify } = require('util');
const version = require('./version');
const process_directives = require('../upgrade/processDirectives');
const child_process = require('child_process');
const ps = require('find-process');
const path = require('path');
const zlib = require('zlib');

const UPGRADE_DIR_NAME= 'upgrade_vers'
const UPGRADE_DIR_PATH = path.join(process.cwd(), UPGRADE_DIR_NAME);

//Promisified functions
const p_fs_readFile = promisify(fs.readFile);
const p_fs_rename = promisify(fs.rename);
const p_fs_unlink = promisify(fs.unlink);
const p_fs_stat = promisify(fs.stat);
const p_fs_readdir = promisify(fs.readdir);

let hdb_properties;

try {
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));
} catch (e) {
    log.fatal(`There was an error reading settings the properties & settings file. ${e}`);
}

const hdb_base = hdb_properties.get('PROJECT_DIR');
let Spinner = CLI.Spinner;
let countdown = new Spinner('Upgrading HarperDB ', ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']);

module.exports = {
    upgrade: upgrade,
    upgradeExternal: upgradeExternal
};

const versions_url = 'http://lms.harperdb.io:7777/api/latestVersion?os=';
const download_url = 'http://lms.harperdb.io:7777/api/update?os=';

/**
 * Check to see if an instance of HDB is running. Throws an error if running, otherwise it will just return to resolve the promise.
 * @returns {Promise<void>}
 */
async function checkIfRunning() {
    let list = await ps('name', HDB_PROC_NAME).catch((e) => {
        let run_err = 'HarperDB is running, please stop HarperDB with /bin/harperdb stop and run the upgrade command again.';
        console.log(run_err);
        log.info(run_err);
        throw new Error('An instance of harperdb is running.');
    });

    if( list.length !== 0 ) {
        let run_err = 'HarperDB is running, please stop HarperDB with /bin/harperdb stop and run the upgrade command again.';
        console.log(run_err);
        log.info(run_err);
        throw new Error('An instance of harperdb is running.');
    }
    return;
}

/**
 * Call the upgradeExternal function on the untared latest version of HDB.
 */
function callUpgradeOnNew() {
    console.log('HERHEEHREHREHR');
}

async function upgrade() {
    log.setLogLevel(log.INFO);
    let curr_user = os.userInfo();
    log.info('Starting upgrade process');
    if(hdb_util.isEmptyOrZeroLength(hdb_properties) ) {
        let msg = 'the hdb_boot_properties file was not found.  Please install HDB.';
        log.error(msg);
        console.error(msg);
        return msg;
    }

    // check if already running, ends process if error caught.
    await checkIfRunning().catch(() => {return});

    let opers = findOs();
    if (!opers) {
        return console.error('You are attempting to upgrade HarperDB on an unsupported operating system');
    }
    let latest_version = await getLatestVersion(opers).catch((e) => {
        log.error(e);
        console.error(`Error getting latest version from HarperDB: ${e}`);
        throw e;
    });

    if(process_directives.compareVersions(version.version(), latest_version) === 0) {
        return "HarperDB version is current";
    }

    // Remove any existing upgrade/ directory path files
    let upgrade_dir_stat = await p_fs_readdir(UPGRADE_DIR_PATH).catch((e) => {
        // Most Failures here are OK, we just want to delete it if it exists.  Log it just in case.
        log.info(`Error reading upgrade directory, this is probably OK, we want to make sure it's empty before an upgrade. ${e} `)
    });

    if(upgrade_dir_stat) {
        await hdb_util.removeDir(UPGRADE_DIR_PATH).catch((e) => {
           let err_msg = `Got an error trying to remove the upgrade/ directory.  Please manually delete the directory and 
           it's contents and re-run upgrade. ${e}`;
           console.error(err_msg);
           log.error(err_msg);
           return;
        });
    };

    mkdirp(UPGRADE_DIR_PATH);
    try {
        let build = await getBuild(opers);
    } catch(err) {
        log.error(err);
        console.error(err);
        throw err;
    };

    /*let package_json = await p_fs_readFile(hdb_properties.get('PROJECT_DIR') + '/package.json', 'utf8').catch(err => {
        log.error(err);
        return console.error(err);
    });*/

    //if (JSON.parse(package_json).version >= build[0].product_version) {
    //    return console.warn('HarperDB already up to date on ' + JSON.parse(package_json).version);
    //}
    // untar the new package
    //let found_directives = await process_directives.readDirectiveFiles(hdb_base);
    //executeUpgrade(build[0]);
    //await startUpgradeDirectives(version.version(), build[0].product_version);
}


async function upgradeExternal(curr_installed_version) {

}

async function getLatestVersion(opers) {
    let options = {
        method: 'GET',
        url: versions_url + opers,
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

async function getBuild(opers) {
    let options = {
        method: 'GET',
        url: download_url + opers,
        headers:
            {
                'cache-control': 'no-cache',
                'content-type': 'application/json',
                'Accept': 'application/json'
            }
    };
    let res = undefined;
    try {
        res = await request(options);
        let file = await fs.createWriteStream(path.join(UPGRADE_DIR_PATH, 'hdb-latest.tar'));
        res.pipe(file);
        file.on('finish', async function() {
            let tarball = await fs.createReadStream(path.join(UPGRADE_DIR_PATH, 'hdb-latest.tar')).pipe(tar.extract(UPGRADE_DIR_PATH));
            tarball.on('finish', async function () {
                callUpgradeOnNew();
            });
        });
    } catch (e) {
        log.error(`There was an error with the request to get the latest HDB Build: ${e}`);
        throw new Error("Error getting latest build");
    }
}

function findOs() {
    if (os.arch() === 'arm' || os.arch() === 'arm64') {
        switch (os.release()) {
            case "armv7l":
                return 'ARM 7'
                break;
            case "armv6l":
                return 'ARM 6';
                break;
            default:
                return null;
                break;
        }
    }
    switch (os.platform()) {
        case "darwin":
            return 'Mac';
            break;
        case "linux":
            return 'Linux';
            break;
        default:
            return null;
    }
}

function executeUpgrade(build) {
    countdown.start();

    let upgradeFolder = hdb_properties.get('HDB_ROOT') + '/upgrade/' + Date.now() + '/';

    mkdirp(upgradeFolder);
    let path_tokens = build.public_path.split(':');
    let host = path_tokens[0];
    let port = path_tokens[1].split('/')[0];
    let path = path_tokens[1].split('/')[1];
    let options = {
        "method": "GET",
        "hostname": host,
        "port": port,
        "path": "/" + path
    };

    let file = fs.createWriteStream(upgradeFolder + '' + path);
    http.get(options).on('response', function (response) {
        response.pipe(file);
        response.on('end', function () {
            let stream = fs.createReadStream(upgradeFolder + '' + path);
            stream.pipe(tar.extract(upgradeFolder));
            stream.on('error', function (err) {
                log.error(err);
                return console.error(err);
            });
            stream.on('close', async function () {
                await p_fs_unlink(hdb_properties.get('PROJECT_DIR') + '/bin/harperdb').catch(err => {
                    log.error(err);
                    return console.error(err);
                });
                await p_fs_rename(upgradeFolder + 'HarperDB/bin/harperdb', hdb_properties.get('PROJECT_DIR') + '/bin/harperdb').catch(err => {
                    log.error(err);
                    return console.error(err);
                });
                await p_fs_rename(upgradeFolder + 'HarperDB/package.json', hdb_properties.get('PROJECT_DIR') + '/package.json').catch(err => {
                    log.error(err);
                    return console.error(err);
                });
                await p_fs_rename(upgradeFolder + 'HarperDB/user_guide.html', hdb_properties.get('PROJECT_DIR') + '/user_guide.html').catch(err => {
                    log.error(err);
                    return console.error(err);
                });
                countdown.stop();
                console.log('HarperDB has been upgraded to ' + build.product_version);
            });
        });
    });
}

async function startUpgradeDirectives(old_version_number, new_version_number) {
    let found_directives = await process_directives.readDirectiveFiles(hdb_base);
    if(hdb_util.isEmptyOrZeroLength(found_directives)) {
        log.info('No upgrade directives found.');
        countdown.stop();
        return;
    }
    await process_directives.processDirectives(old_version_number, new_version_number, found_directives);
    countdown.stop();
    console.log('HarperDB has been upgraded to ' + build.product_version);
}


