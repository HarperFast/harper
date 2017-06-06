const fs = require('fs'),
    spawn = require('child_process').spawn,
    util = require('util')
    winston = require('winston'),
    install = require('./installer.js'),
    colors = require("colors/safe"),
    PropertiesReader = require('properties-reader');
var hdb_boot_properties = null,
    hdb_properties = null;

winston.configure({
    transports: [
        new (winston.transports.File)({filename: 'startup.log'})
    ]
});




run();


function run() {
    try {
        hdb_boot_properties = PropertiesReader('/etc/hdb_boot_properties.file');
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
            hdb_boot_properties = PropertiesReader('/etc/hdb_boot_properties.file');
            hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));
            completeRun();
            return;

        });
    }














}

function completeRun() {

    kickOffTriggers();
    kickOffExpress();





}

function kickOffExpress(){

    var terminal2 = spawn('bash');
    terminal2.stderr.on('data', function (data) {
        winston.log('error',`Express server failed to run: ${data}`);
        //Here is where the error output goes
    });

    terminal2.stdout.on('data', function(data){
        winston.log('info', `Express Server started`);
    });

    terminal2.stdin.write(`./node_modules/pm2/bin/pm2 start ./server/express.js`);
    terminal2.stdin.end();

    console.log(colors.magenta('' + fs.readFileSync(`./utility/install/ascii_logo`)));
    console.log(colors.magenta('|------------- HarperDB succesfully started ------------|'));

}

function kickOffTriggers(){

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
    terminal.stdin.write(`./node_modules/pm2/bin/pm2 start ./triggers/schema_triggers.js`);
    terminal.stdin.end();
}




//check lk exists and is valid.
//turn on express sever






