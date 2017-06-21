#!/usr/bin/env node
const spawn = require('child_process').spawn,

    winston = require('winston');


stop();
function stop(){

    var terminal = spawn('bash');
    terminal.stderr.on('data', function (data) {
        winston.log('error',`Express server failed to run: ${data}`);
        console.log('|------------- HarperDB successfully stopped ------------|');
        //Here is where the error output goes
    });

    terminal.stdout.on('data', function(data){
        winston.log('info', `Express Server stoped`);
    });
    terminal.stdin.write(`kill $(ps -ef | grep [h]db_ | awk '{print $2}') && kill $(ps -ef | grep [i]notify | awk '{print $2}')`);
    terminal.stdin.end();




}



