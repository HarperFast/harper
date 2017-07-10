#!/usr/bin/env node
const spawn = require('child_process').spawn,

    winston = require('winston');


stop();
function stop(){

    var terminal = spawn('bash');
    terminal.stderr.on('data', function (data) {
        winston.info('error',`Express server failed to run: ${data}`);
        winston.info('|------------- HarperDB successfully stopped ------------|');
        //Here is where the error output goes
    });

    terminal.stdout.on('data', function(data){
        winston.info('info', `Express Server stopped`);
    });
    terminal.stdin.write(`kill $(ps -ef | grep [h]db_ | awk '{print $2}') 2> /dev/null && kill $(ps -ef | grep [i]notify | awk '{print $2}') 2> /dev/null`);
    terminal.stdin.end();




}



