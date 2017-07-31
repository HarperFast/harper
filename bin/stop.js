#!/usr/bin/env node

module.exports = {
    stop:stop
}

function stop(callback){
    const spawn = require('child_process').spawn,
        winston = require('../utility/logging/winston_logger');

    var terminal = spawn('bash');
    terminal.stderr.on('data', function (data) {
        winston.info('error',`Express server failed to run: ${data}`);
        winston.info('|------------- HarperDB failed stopped ------------|');
        //Here is where the error output goes
    });

    terminal.stdout.on('data', function(data){
        if(callback){
            callback();
        }
        winston.info(`Express Server stopped`);
    });
    terminal.stdin.write(`kill $(ps -ef | grep [h]db_ | awk '{print $2}'); echo done;`);
    terminal.stdin.end();




}



