#!/usr/bin/env node
const fs = require('fs'),
    util = require('util'),
    path = require('path'),
    winston = require('winston'),
    install = require('../utility/install/installer.js'),
    colors = require("colors/safe"),
    PropertiesReader = require('properties-reader');
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
    try {
        hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
        console.log(hdb_boot_properties.get('settings_path'));
        // doesn't do a null check.
        hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
        completeRun();
        return;
    }catch(e){
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
    }

}

function completeRun() {
    kickOffTriggers();
    kickOffExpress();
setTimeout(exitInstall, 5000);
}

function kickOffExpress(){

var child = fork(path.join(__dirname,'../server/hdb_express.js'),{
  detached: true,
  stdio: 'ignore'
});

child.unref();


/*
    var terminal2 = spawn('bash');
    terminal2.stderr.on('data', function (data) {
        winston.log('error',`Express server failed to run: ${data}`);
        //Here is where the error output goes
    });

    terminal2.stdout.on('data', function(data){
        winston.log('info', `Express Server started`);
    });

    terminal2.stdin.write(`../node_modules/pm2/bin/pm2 start ../utility/devops/ecosystem.config.js`);
    terminal2.stdin.end();
*/
    console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname,'../utility/install/ascii_logo.txt'))));
    console.log(colors.magenta('|------------- HarperDB succesfully started ------------|'));
}

function kickOffTriggers(){
var child = fork(path.join(__dirname,'../triggers/hdb_schema_triggers.js'),{
    detchecd: true,
    stdio: 'ignore'
});

child.unref;
/*
    //spin up schema trigger
    var terminal = spawn('bash');
    terminal.stderr.on('data', function (data) {
        if(data.indexOf('Beware: since -r was given') < 0){
            winston.log('error',`Schema trigger failed to run: ${data}`);
            kickOffTriggers();
        }else{
            winston.log('info',`Schema trigger started: ${data}`);
        }


    });
    terminal.stdin.write(`../node_modules/pm2/bin/pm2 start ../triggers/hdb_schema_triggers.js`);
    terminal.stdin.end();
*/
}


function exitInstall(){process.exit(0);}

//check lk exists and is valid.
//turn on express sever






