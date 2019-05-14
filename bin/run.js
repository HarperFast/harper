"use strict";
const fs = require('fs');
const util = require('util');
const path = require('path');
const net = require('net');
const install = require('../utility/install/installer.js');
const colors = require("colors/safe");
const logger = require('../utility/logging/harper_logger');
const PropertiesReader = require('properties-reader');
const async = require('async');
const pjson = require('../package.json');
const { isHarperRunning } = require('../utility/common_utils');
const HTTPSECURE_PORT_KEY = 'HTTPS_PORT';
const HTTP_PORT_KEY = 'HTTP_PORT';
const HTTPSECURE_ON_KEY = 'HTTPS_ON';
const HTTP_ON_KEY = 'HTTP_ON';
const stop = require('./stop');

const FOREGROUND_ARG = 'foreground';

let hdb_boot_properties = null;
let hdb_properties = null;
let fork = require('child_process').fork;

let child = undefined;

/***
 * Starts Harper DB.  If Harper is already running, or the port is in use, and error will be thrown and Harper will not
 * start.  If the hdb_boot_props file is not found, it is assumed an install needs to be performed.
 */
function run() {
  isHarperRunning().then(hdb_running => {
      if(hdb_running) {
          let run_err = 'HarperDB is already running.';
          console.log(run_err);
          logger.info(run_err);
          return;
      }

      try {
          arePortsInUse((err) => {
              if (err) {
                  console.log(err);
                  logger.info(err);
                  return;
              }
              startHarper();
          });
      } catch(err) {
          console.log(err);
          logger.info(err);
      }

  }).catch(err => {
      console.log(err);
      logger.error(err);
  });
}

function arePortsInUse(callback) {
    let httpsecure_port;
    let http_port;
    let httpsecure_on;
    let http_on;
    let tasks = [];
    // If this fails to find the boot props file, this must be a new install.  This will fall through,
    // pass the process and port check, and then hit the install portion of startHarper().
    try {
        hdb_properties = PropertiesReader(`${__dirname}/../hdb_boot_properties.file`);
        hdb_properties.append(hdb_properties.get('settings_path'));
        httpsecure_on = hdb_properties.get(HTTPSECURE_ON_KEY);
        http_on = hdb_properties.get(HTTP_ON_KEY);
        http_port = hdb_properties.get(HTTP_PORT_KEY);
        httpsecure_port = hdb_properties.get(HTTPSECURE_PORT_KEY);
    } catch (e) {
        logger.info('hdb_boot_props file not found, starting install.');
        startHarper();
        return;
    }

    if (http_on === 'FALSE' && httpsecure_on === 'FALSE') {
        let flag_err = 'http and https flags are both disabled.  Please check your settings file.';
        logger.error(flag_err);
        return callback(flag_err);
    }

    if (!http_port && !httpsecure_port) {
        let port_err = 'http and https ports are both undefined.  Please check your settings file.';
        logger.error(port_err);
        return callback(port_err);
    }

    if (http_port && http_on === 'TRUE') {
        tasks.push(function(cb) { return isPortTaken(http_port, cb); });
    }

    if (httpsecure_port && httpsecure_on === 'TRUE') {
        tasks.push(function(cb) { return isPortTaken(httpsecure_port, cb); });
    }

    async.parallel( tasks, function(err, results) {
        callback(err);
    });
}

/**
 * Checks to see if the port specified in the settings file is in use.
 * @param port - The port to check for running processes against
 * @param callback - Callback, returns (err, true/false)
 */
function isPortTaken(port, callback) {
    if(!port){
        return callback();
    }

    const tester = net.createServer()
        .once('error', function (err) {
            if (err.code != 'EADDRINUSE') {
                return callback(err);
            }
            callback(`Port ${port} is already in use.`);
        })
        .once('listening', function() {
            tester.once('close', function() {
                callback(null);
            }).close();
        })
        .listen(port);
}

/**
 * Helper function to start HarperDB.  If the hdb_boot properties file is not found, an install is started.
 */
function startHarper() {
    fs.stat(`${__dirname}/../hdb_boot_properties.file`, function(err, stats) {
        if(err) {
            if(err.errno === -2) {
                install.install(function (err) {
                    if (err) {
                        logger.error(err);
                        return;
                    }
                    hdb_boot_properties = PropertiesReader(`${__dirname}/../hdb_boot_properties.file`);
                    completeRun();
                    return;
                });
            } else {
                logger.error(`start fail: ${err}`);
                return;
            }
        } else {
            hdb_boot_properties = PropertiesReader(`${__dirname}/../hdb_boot_properties.file`);
            try {
                fs.stat(hdb_boot_properties.get('settings_path'), function (err, stats) {
                    if (err) {
                        if (err.errno === -2) {
                            install.install(function (err) {
                                if (err) {
                                    logger.error(err);
                                    return;
                                }
                                hdb_boot_properties = PropertiesReader(`${__dirname}/../hdb_boot_properties.file`);
                                completeRun();
                                return;
                            });
                        } else {
                            logger.error(`HarperDB ${pjson.version} start fail: ${err}`);
                            return;
                        }
                    } else {
                        completeRun();
                        return;
                    }
                });
            } catch (e) {
                console.error('There was a problem reading the boot properties file.  Please check the install logs.');
                logger.error('There was a problem reading the boot properties file. ' + e);
            }
        }
    });
}

function completeRun() {
    async.waterfall([
        checkPermission,
        kickOffExpress,
    ], (error, data) => {
        if (error)
            console.error(error);

        foregroundHandler();
    });
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
function processExitHandler(options, err) {
    if (options.is_foreground) {
        stop.stop((err) => {
            console.error(err);
        });
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

function checkPermission(callback) {
    let checkPermissions = require('../utility/check_permissions');
    try {
        checkPermissions.checkPermission();
    } catch(err) {
        console.error(err);
        return callback(err, null);
    }
    return callback(null, 'success');
}

function kickOffExpress(err, callback) {

    if (hdb_properties && hdb_properties.get('MAX_MEMORY')) {
        child = fork(path.join(__dirname,'../server/hdb_express.js'),[`--max-old-space-size=${hdb_properties.get('MAX_MEMORY')}`, `${hdb_properties.get('PROJECT_DIR')}/server/hdb_express.js`],{
            detached: true,
            stdio: 'ignore'
        });
    } else {
        child = fork(path.join(__dirname,'../server/hdb_express.js'),{
            detached: true,
            stdio: 'ignore'
        });
    }

    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'../utility/install/ascii_logo.txt'))));
    console.log(colors.magenta(`|------------- HarperDB ${pjson.version} successfully started ------------|`));
    return callback();
}

function increaseMemory(callback) {
    try {
        if (hdb_properties && hdb_properties.get('MAX_MEMORY')) {
            const {spawn} = require('child_process');
            const node = spawn('node', [`--max-old-space-size=${hdb_properties.get('MAX_MEMORY')}`, `${hdb_properties.get('PROJECT_DIR')}/server/hdb_express.js`]);

            node.stdout.on('data', (data) => {
                logger.info(`stdout: ${data}`);
            });

            node.stderr.on('data', (data) => {
                logger.error(`stderr: ${data}`);
            });

            node.on('close', (code) => {
                logger.log(`child process exited with code ${code}`);
            });
        } else {
            callback();
        }
    } catch(e){
        logger.error(e);
    }
}

function exitInstall(){
    process.exit(0);
}

module.exports ={
    run:run
};
