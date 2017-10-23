#!/usr/bin/env node
"use strict";
const fs = require('fs'),
    util = require('util'),
    path = require('path'),
    ps = require('find-process'),
    install = require('../utility/install/installer.js'),
    colors = require("colors/safe"),
    basic_winston  = require('winston'),
    PropertiesReader = require('properties-reader'),
    async = require('async'),
    pjson = require('../package.json'),
    HTTPS_PORT_KEY = 'HTTPS_PORT',
    HTTP_PORT_KEY = 'HTTP_PORT',
    HTTPS_ON_KEY = 'HTTPS_ON',
    HDB_PROC_NAME = 'hdb_express.js';

let winston = null;
let hdb_boot_properties = null;
let hdb_properties = null;
let fork = require('child_process').fork;


/***
 * Starts Harper DB.  If Harper is already running, or the port is in use, and error will be thrown and Harper will not
 * start.  If the hdb_boot_props file is not found, it is assumed an install needs to be performed.
 */
function run() {
    basic_winston.configure({
        transports: [
            new (basic_winston.transports.File)({ filename: '../run_log.log',  level: 'verbose', handleExceptions: true,
                prettyPrint:true })
        ],exitOnError:false
    });
    let http_port = 9925;
    // If this fails to find the boot props file, this must be a new install.  This will fall through,
    // pass the process and port check, and then hit the install portion of startHarper().
    try {
        hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
        hdb_properties.append(hdb_properties.get('settings_path'));
        let https_on = hdb_properties.get(HTTPS_ON_KEY);
        if ( https_on === true ) {
            http_port = hdb_properties.get(HTTP_PORT_KEY);
        } else {
            http_port = hdb_properties.get(HTTPS_PORT_KEY);
        }
    } catch (e) {
        basic_winston.info('Could not find hdb_boot properties file, assuming this is a new install.');
    }

    ps('name', HDB_PROC_NAME).then(function (list) {
        if( list.length === 0 ) {
            isPortTaken(http_port, (err, found)=> {
                if( !found ) {
                    startHarper();
                } else {
                  console.log(`Port ${http_port} is in use`);
                  basic_winston.info(`Port ${http_port} is in use`);
                }
            });
        }
        else {
            console.log("HarperDB is already running.");
            basic_winston.info(`HarperDB is already running`);
        }
    }, function (err) {
        console.log(err.stack || err);
        basic_winston.error(err.stack || err);
    })
}

/**
 * Checks to see if the port specified in the settings file is in use.
 * @param port - The port to check for running processes against
 * @param fn - Callback, returns (err, true/false)
 */
function isPortTaken(port, fn) {
    var net = require('net')
    var tester = net.createServer()
        .once('error', function (err) {
            if (err.code != 'EADDRINUSE') return fn(err)
            fn(null, true)
        })
        .once('listening', function() {
            tester.once('close', function() { fn(null, false) })
                .close()
        })
        .listen(port)
}

/**
 * Helper function to start HarperDB.  If the hdb_boot properties file is not found, an install is started.
 */
function startHarper() {
    fs.stat(`${process.cwd()}/../hdb_boot_properties.file`, function(err, stats){
        if(err){
            if(err.errno === -2){
                install.install(function (err, result) {
                    if (err) {
                        basic_winston.error(err);
                        return;
                    }
                    hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
                    completeRun();
                    return;
                });
            }else{
                basic_winston.error(`start fail: ${err}`);
                return;
            }
        }else{
            hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
            try {
                fs.stat(hdb_boot_properties.get('settings_path'), function (err, stats) {
                    if (err) {
                        if (err.errno === -2) {
                            install.install(function (err, result) {
                                if (err) {
                                    basic_winston.error(err);
                                    return;
                                }
                                hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
                                completeRun();
                                return;
                            });
                        } else {
                            basic_winston.error(`HarperDB ${pjson.version} start fail: ${err}`);
                            return;
                        }
                    } else {
                        completeRun();
                        return;
                    }
                });
            }catch (e) {
                console.error('There was a problem reading the boot properties file.  Please check the install logs.');
                basic_winston.error('There was a problem reading the boot properties file. ' + e);
            }
        }
    });
}

function completeRun() {
    winston = require("../utility/logging/winston_logger");

    async.waterfall([
        checkPermission,
        kickOffExpress,
    ], (error, data) => {
        if(error)
            console.error(error);
        exitInstall();
    });
}

function checkPermission(callback){

    let checkPermissions = require('../utility/check_permissions');
    checkPermissions.checkPermission(function(err){
        if(err){
            console.error(err);
            return callback(err, null);
        }else{
            return callback(null, 'success');
        }
    });
}

function kickOffExpress(err, callback){
    if (hdb_properties && hdb_properties.get('MAX_MEMORY')) {
        var child = fork(path.join(__dirname,'../server/hdb_express.js'),[`--max-old-space-size=${hdb_properties.get('MAX_MEMORY')}`, `${hdb_properties.get('PROJECT_DIR')}/server/hdb_express.js`],{
            detached: true,
            stdio: 'ignore'
        });
    }else{
        var child = fork(path.join(__dirname,'../server/hdb_express.js'),{
            detached: true,
            stdio: 'ignore'
        });
    }

    child.unref();
    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'../utility/install/ascii_logo.txt'))));
    console.log(colors.magenta(`|------------- HarperDB ${pjson.version} successfully started ------------|`));
    return callback();
}

function increaseMemory(callback){
    try {
        if (hdb_properties && hdb_properties.get('MAX_MEMORY')) {
            const {spawn} = require('child_process');
            const node = spawn('node', [`--max-old-space-size=${hdb_properties.get('MAX_MEMORY')}`, `${hdb_properties.get('PROJECT_DIR')}/server/hdb_express.js`]);

            node.stdout.on('data', (data) => {
                winston.info(`stdout: ${data}`);
            });

            node.stderr.on('data', (data) => {
                winston.error(`stderr: ${data}`);
            });

            node.on('close', (code) => {
                winston.log(`child process exited with code ${code}`);
            });
        } else {
            callback();
        }
    }catch(e){
        winston.error(e);
    }
}

function exitInstall(){
    process.exit(0);
}

module.exports ={
    run:run
}


