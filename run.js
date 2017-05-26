const fs = require('fs'),
    spawn = require('child_process').spawn,
    util = require('util')
    winston = require('winston'),
    install = require('./installer.js'),
    settings = require('./settings');

winston.configure({
    transports: [
        new (winston.transports.File)({filename: 'startup_error.log'})
    ]
});

run();

// check settings.js if null run install
function run() {
    winston.log('lets get this party started!');
    if (settings && settings.PROJECT_DIR && settings.HDB_ROOT) {
        completeRun();
        return
    }else{
        install.install(function (err, result) {
            if (err) {
                console.log(err);
                winston.log('error', `start fail: ${err}`);
                return;
            }
            completeRun();
            return;

        });
    }





}

function completeRun() {



    //spin up schema trigger
    var terminal = spawn('bash');
    terminal.stderr.on('data', function (data) {
        //winston.log('error',`Schema trigger failed to run: ${data}`);
        console.log('' + data);
        //Here is where the error output goes
    });
    terminal.stdin.write(`node ./triggers/schema_triggers.js`);
    terminal.stdin.end();

    var terminal2 = spawn('bash');
    terminal2.stderr.on('data', function (data) {
        //winston.log('error',`Express server failed to run: ${data}`);
        console.log('' + data);
        //Here is where the error output goes
    });





    terminal2.stdin.write(`node ./server/express.js`);
    terminal2.stdin.end();




}


//check lk exists and is valid.
//turn on express sever






