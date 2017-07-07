#!/usr/bin/env node
"use strict";
const fs = require('fs'),
    util = require('util'),
    path = require('path'),
    winston = require('winston'),
    install = require('../utility/install/installer.js'),
    colors = require("colors/safe"),
    PropertiesReader = require('properties-reader'),
    async = require('async');

var hdb_boot_properties = null,
    hdb_properties = null;
var fork = require('child_process').fork;

winston.configure({
    transports: [
        new (winston.transports.File)({filename: '../hdb.log'})
    ]
});


// TODO need to check if hdb is already running and stop it first before running again.

run();

function run() {

    fs.stat(`${process.cwd()}/../hdb_boot_properties.file`, function(err, stats){
        if(err){
            if(err.errno === -2){
                install.install(function (err, result) {
                    if (err) {
                        console.log(err);
                        winston.log('error', `start fail: ${err}`);
                        return;
                    }
                    hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
                    hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                    completeRun();
                    return;


                });
            }else{
                winston.log('error', `start fail: ${err}`);
                return;
            }

        }else{
            hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
            console.log(hdb_boot_properties.get('settings_path'));
            // doesn't do a null check.
            fs.stat(hdb_boot_properties.get('settings_path'), function(err, stats) {
                if (err) {
                    if (err.errno === -2) {
                        install.install(function (err, result) {
                            if (err) {
                                console.log(err);
                                winston.log('error', `start fail: ${err}`);
                                return;
                            }
                            hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
                            hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                            completeRun();
                            return;


                        });
                    } else {
                        winston.log('error', `start fail: ${err}`);
                        return;
                    }

                } else {

                    hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
                    completeRun();
                    return;
                }
            });
        }




    });



}

function completeRun() {
    async.waterfall([
       kickOffExpress
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
    console.log(colors.magenta('|------------- HarperDB succesfully started ------------|'));
    callback();
}


function exitInstall(){
    process.exit(0);
}

//check lk exists and is valid.
//turn on express sever






