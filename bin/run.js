"use strict";
const env = require('../utility/environment/environmentManager');
env.initSync();
const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const install = require('../utility/install/installer.js');
const colors = require("colors/safe");
const logger = require('../utility/logging/harper_logger');
const pjson = require('../package.json');
const terms = require('../utility/hdbTerms');
let checkPermissions = require('../utility/check_permissions');
const { isHarperRunning } = require('../utility/common_utils');
const { promisify } = require('util');
const stop = require('./stop');
const os = require('os');
const upgrade_prompt = require('../utility/userInterface/upgradePrompt');
const upgrade = require('./upgrade');
const version = require('./version');

// These may change to match unix return codes (i.e. 0, 1)
const SUCCESS_CODE = 'success';
const FAILURE_CODE = 'failed';
const FOREGROUND_ARG = 'foreground';
const ENOENT_ERR_CODE = -2;

// promisified functions
const p_install_install = promisify(install.install);

let fork = require('child_process').fork;
let child = undefined;

/***
 * Starts Harper DB.  If Harper is already running, or the port is in use, and error will be thrown and Harper will not
 * start.  If the hdb_boot_props file is not found, it is assumed an install needs to be performed.
 */
async function run() {
    let hdb_running = undefined;
    try {
        hdb_running = await isHarperRunning();
    } catch(err) {
        console.log(err);
        logger.error(err);
    }
    if(hdb_running) {
        let run_err = 'HarperDB is already running.';
        console.log(run_err);
        logger.info(run_err);
        return;
    }

    try {
        // Check to see if an upgrade file exists in $HOME/.harperdb.  If it exists, we need to force the user to upgrade.
        let home_hdb_path = path.join(os.homedir(), terms.HDB_HOME_DIR_NAME, terms.UPDATE_FILE_NAME);
        if(fs.existsSync(home_hdb_path)) {
            try {
                let update_json = JSON.parse(fs.readFileSync(home_hdb_path), 'utf8');
                let upgrade_result = await forceUpdate(update_json);
                if(upgrade_result) {
                    fs.unlinkSync(home_hdb_path);
                }
            } catch(err) {
                console.error(`Got an error trying to read ${home_hdb_path}, please check the file is readable and try again.  Exiting HarperDB.`);
                process.exit(1);
            }
        }
        console.log('Upgrade complete.  Starting HarperDB.');
        let is_in_use = await arePortsInUse();
        if(!is_in_use) {
            await startHarper();
        } else {
            console.log(`Can't start HarperDB.  Ports: ${env.get(terms.HDB_SETTINGS_NAMES.HTTP_PORT_KEY)} or ${env.get(terms.HDB_SETTINGS_NAMES.HTTP_SECURE_PORT_KEY)} in use.`);
        }
    } catch(err) {
        console.log(err);
        logger.info(err);
        return;
    }
}

async function forceUpdate(update_json) {
    let old_version = update_json[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION];
    let new_version = update_json[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION];
    if(!old_version) {
        console.log('Current Version field missing from the config file.  Cannot continue with upgrade.  Please contact support@harperdb.io');
        logger.notify('Missing current version field from upgradeconfig');
        process.exit(1);
    }
    if(!new_version) {
        new_version = version.version();
        if(!new_version) {
            console.log('Current Version field missing from the config file.  Cannot continue with upgrade.  Please contact support@harperdb.io');
            logger.notify('Missing new version field from upgradeconfig');
            process.exit(1);
        }
    }
    let start_upgrade = await upgrade_prompt.forceUpdatePrompt(old_version, new_version);
    if(!start_upgrade) {
        console.log('Cancelled upgrade, closing HarperDB');
        process.exit(1);
    }
    try {
        let upgrade_result = await upgrade.startUpgradeDirectives(old_version, new_version);
        upgrade_result.forEach((result) => {
           logger.info(result);
        });
        // success, remove the upgrade file.
        return true;
    } catch(err) {
        console.log('There was an error during the data upgrade.  Please check the logs.');
        logger.error(err);
        return false;
    }
}

async function arePortsInUse() {
    let httpsecure_port;
    let http_port;
    let httpsecure_on;
    let http_on;
    // If this fails to find the boot props file, this must be a new install.  This will fall through,
    // pass the process and port check, and then hit the install portion of startHarper().
    try {
        httpsecure_on = env.get(terms.HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY);
        http_on = env.get(terms.HDB_SETTINGS_NAMES.HTTP_ENABLED_KEY);
        http_port = env.get(terms.HDB_SETTINGS_NAMES.HTTP_PORT_KEY);
        httpsecure_port = env.get(terms.HDB_SETTINGS_NAMES.HTTP_SECURE_PORT_KEY);
    } catch (e) {
        logger.info('hdb_boot_props file not found.');
        return;
    }

    if (http_on === 'FALSE' && httpsecure_on === 'FALSE') {
        let flag_err = 'http and https flags are both disabled.  Please check your settings file.';
        logger.error(flag_err);
        throw new Error(flag_err);
    }

    if (!http_port && !httpsecure_port) {
        let port_err = 'http and https ports are both undefined.  Please check your settings file.';
        logger.error(port_err);
        await startHarper();
    }

    //let port_taken = undefined;
    if (http_port && http_on === 'TRUE') {
        try {
            let is_port_taken = await isPortTaken(http_port);
            if(is_port_taken) {
                return true;
            }
        } catch(err) {
            console.error(`error checking for port ${http_port}`);
        }
    }

    if (httpsecure_port && httpsecure_on === 'TRUE') {
        try {
            let is_port_taken = await isPortTaken(httpsecure_port);
            if(is_port_taken) {
                return true;
            }
        } catch(err) {
            console.error(`error checking for port ${http_port}`);
        }
    }
}

/**
 * Checks to see if the port specified in the settings file is in use.
 * @param port - The port to check for running processes against
 * @param callback - Callback, returns (err, true/false)
 */
function isPortTaken(port) {
    if(!port) {
        throw new Error(`Invalid port passed as parameter`);
    }

    const tester = net.createServer();
    let event_response = new Promise(function(resolve, reject) {
        tester.once('error', function (err) {
            if (err.code !== 'EADDRINUSE') {
                resolve(true);
            }
            resolve(true);
        });
        tester.once('listening', function() {
            tester.once('close', function() {
                resolve(false);
            }).close();
        });
        tester.listen(port);
    });
    return event_response;
}

/**
 * Helper function to start HarperDB.  If the hdb_boot properties file is not found, an install is started.
 */
async function startHarper() {
    let boot_props_stats = undefined;
    let settings_stats = undefined;
    let start_install = false;
    try {
        boot_props_stats = await fs.stat(env.BOOT_PROPS_FILE_PATH);
        settings_stats = await fs.stat(env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
    } catch(err) {
        if(err.errno === ENOENT_ERR_CODE) {
            // boot props not found, don't return and kick off install
            start_install = true;
        } else {
            logger.error(`start fail: ${err}`);
            return;
        }
    }
    if(start_install) {
        console.log(`Settings files not found, starting install process.`);
        try {
            await p_install_install();
            console.log('Install complete, starting HarperDB');
        } catch(err) {
            console.error('There was an error during install.  Exiting.');
            process.exit(1);
        }
    }
    env.initSync();
    await completeRun();
}

async function completeRun() {
    try {
        await checkPermission();
        let result = await kickOffExpress();
        if (result === SUCCESS_CODE) {
            foregroundHandler();
        } else {
            process.exit(1);
        }
    } catch(err) {
        console.error(err.message);
        process.exit(1);
    }
}

/**
 * if foreground is passed on the command line we do not exit the process
 * also if foreground is passed we setup the processExitHandler to call the stop handler which kills the hdb processes
 */
function foregroundHandler() {
    let is_foreground = isForegroundProcess();

    if (!is_foreground) {
        child.unref();
        exitInstall();
    }

    process.on('exit', processExitHandler.bind(null, {is_foreground: is_foreground}));

    //catches ctrl+c event
    process.on('SIGINT', processExitHandler.bind(null, {is_foreground: is_foreground}));

    // catches "kill pid"
    process.on('SIGUSR1', processExitHandler.bind(null, {is_foreground: is_foreground}));
    process.on('SIGUSR2', processExitHandler.bind(null, {is_foreground: is_foreground}));
}

/**
 * if is_foreground we call the stop function which kills the hdb processes
 * @param options
 * @param err
 */
async function processExitHandler(options) {
    if (options.is_foreground) {
        try {
            await stop.stop();
        } catch(err) {
            console.log(err);
        }
    }
}

/**
 * check to see if any of the cli arguments are 'foreground'
 * @returns {boolean}
 */
function isForegroundProcess(){
    let is_foreground = false;
    for (let arg of process.argv) {
        if (arg === FOREGROUND_ARG) {
            is_foreground = true;
            break;
        }
    }
    return is_foreground;
}

async function checkPermission() {
    try {
        checkPermissions.checkPermission();
    } catch(err) {
        throw err;
    }
    return SUCCESS_CODE;
}

async function kickOffExpress() {
    try {
        if (env.get('MAX_MEMORY')) {
            child = fork(path.join(__dirname, '../server/hdb_express.js'), [`--max-old-space-size=${env.get('MAX_MEMORY')}`, `${env.get('PROJECT_DIR')}/server/hdb_express.js`], {
                detached: true,
                stdio: 'ignore'
            });
        } else {
            child = fork(path.join(__dirname, '../server/hdb_express.js'), {
                detached: true,
                stdio: 'ignore'
            });
        }
    } catch(err) {
        console.error(`There was an error starting the REST server.  Please try again.`);
        return FAILURE_CODE;
    }

    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'../utility/install/ascii_logo.txt'))));
    console.log(colors.magenta(`|------------- HarperDB ${pjson.version} successfully started ------------|`));
    return SUCCESS_CODE;
}

function exitInstall(){
    process.exit(0);
}

module.exports ={
    run:run
};
