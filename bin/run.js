#!/usr/bin/env node
"use strict";
const fs = require('fs'),
    util = require('util'),
    path = require('path'),
    install = require('../utility/install/installer.js'),
    colors = require("colors/safe"),
    basic_winston  = require('winston'),
    PropertiesReader = require('properties-reader'),
    async = require('async'),
    pjson = require('../package.json');

var hdb_boot_properties = null,
    hdb_properties = null;
var fork = require('child_process').fork;



// TODO need to check if hdb is already running and stop it first before running again.


function run() {
    basic_winston.configure({
        transports: [

            new (basic_winston.transports.File)({ filename: '../run_log.log',  level: 'verbose', handleExceptions: true,
                prettyPrint:true })
        ],exitOnError:false
    });


    fs.stat(`${process.cwd()}/../hdb_boot_properties.file`, function(err, stats){
        if(err){
            if(err.errno === -2){
                install.install(function (err, result) {
                    if (err) {
                        basic_winston.error(err);

                        return;
                    }
                    hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
                    hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                    completeRun();
                    return;


                });
            }else{
                basic_winston.error(`start fail: ${err}`);
                return;
            }

        }else{
            hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
            fs.stat(hdb_boot_properties.get('settings_path'), function(err, stats) {
                if (err) {
                    if (err.errno === -2) {
                        install.install(function (err, result) {
                            if (err) {
                                basic_winston.error(err);
                                return;
                            }
                            hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
                            hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                            completeRun();
                            return;


                        });
                    } else {
                        basic_winston.error(`HarperDB ${pjson.version} start fail: ${err}`);
                        return;
                    }

                } else {
                    const winston = require("../utility/logging/winston_logger");
                    hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                    completeRun();
                    winston.info(`HarperDB ${pjson.version} run complete`);
                    return;
                }
            });
        }




    });



}

function completeRun() {
    async.waterfall([
        kickOffExpress,
        increaseMemory
    ], (error, data) => {
        exitInstall();
    });
}

function kickOffExpress(callback){

    var child = fork(path.join(__dirname,'../server/hdb_express.js'),{
      detached: true,
      stdio: 'ignore'
    });

    child.unref();
    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'../utility/install/ascii_logo.txt'))));
    console.log(colors.magenta(`|------------- HarperDB ${pjson.version} successfully started ------------|`));
    callback();
}


function increaseMemory(callback){
    try {
        if (hdb_properties && hdb_properties.get('MAX_MEMORY')) {
            const {spawn} = require('child_process');
            const node = spawn('node  ', [`--max-old-space-size=${hdb_properties.get('MAX_MEMORY')}`, 'hdb_express.js']);

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

//check lk exists and is valid.
//turn on express sever



module.exports ={
    run:run
}


