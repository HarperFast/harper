const os = require('os');
const mkdirp = require('mkdirp');
const fs = require('fs');
const http = require('http');
const tar = require('tar-fs');
const CLI = require('clui');
const request = require("request-promise-native");
const PropertiesReader = require('properties-reader');
const log = require('../utility/logging/harper_logger');
const hdb_util = require('../utility/common_utils');
const { promisify } = require('util');
const version = require('./version');
const process_directives = require('../utility/install/installRequirements/processDirectives');

//Promisified functions
const p_fs_readFile = promisify(fs.readFile);
const p_fs_rename = promisify(fs.rename);
const p_fs_unlink = promisify(fs.unlink);

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
    upgrade: upgrade
};

//const versions_url = 'http://products.harperdb.io:9926/',
//      versions_auth ='Basic dXBncmFkZV91c2VyOl43Snk3JCgmIW45TWpsIV4oSDAzMCUhU3ZFOFU2c1RY';

const versions_url = 'http://lms.harperdb.io:9926/';
const versions_auth ='Basic dXBncmFkZV91c2VyOl43Snk3JCgmIW45TWpsIV4oSDAzMCUhU3ZFOFU2c1RY';

async function upgrade() {
    if(hdb_util.isEmptyOrZeroLength(hdb_properties) ) {
        log.error('the hdb_boot_properties file was not found.  Please install HDB.');
        console.error('the hdb_boot_properties file was not found.  Please install HDB.');
        return;
    }
    let os = findOs();
    if (!os) {
        return console.error('You are attempting to upgrade HarperDB on an unsupported operating system');
    }
    let build = undefined;
    try {
        build = await getBuild(os);
    } catch (err) {
        log.error(err);
        return console.error(err);
    }

    let package_json = await p_fs_readFile(hdb_properties.get('PROJECT_DIR') + '/package.json', 'utf8').catch(err => {
        log.error(err);
        return console.error(err);
    });

    if (JSON.parse(package_json).version >= build[0].product_version) {
        return console.warn('HarperDB already up to date on ' + JSON.parse(package_json).version);
    }
    let found_directives = await process_directives.readDirectiveFiles(hdb_base);
    executeUpgrade(build[0]);
    await startUpgradeDirectives(version.version(), build[0].product_version);
}

async function getBuild(os) {
    let options = {
        method: 'POST',
        url: versions_url,
        headers:
            {
                'cache-control': 'no-cache',
                authorization: versions_auth,
                'content-type': 'application/json'
            },
        body:
            {
                operation: 'sql',
                sql: "select public_path, product_version,path, product, os, " +
                "status from hdb_lms.versions where status = 'active' AND os = '" + os + "'  ORDER BY product_version desc"
            },
        json: true
    };
    let res = undefined;
    try {
        res = await request(options);
    } catch (e) {
        log.error(`There was an error with the request to get the latest HDB Build: ${e}`);
        throw new Error("Error getting latest build");
    }
    if(!res || !res.body || hdb_util.isEmptyOrZeroLength(res.body)) {
        log.error(`Got empty response from the HDB Version server`);
        throw new Error("Got empty response from the HDB Version server");
    }
    return res.body;
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
    await process_directives.processDirectives(old_version_number, new_version_number);
    countdown.stop();
    console.log('HarperDB has been upgraded to ' + build.product_version);
}


