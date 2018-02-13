#!/usr/bin/env node

module.exports = {
    stop: stop
}



function stop(callback) {

    const spawn = require('child_process').spawn,
        winston = require('../utility/logging/winston_logger'),
        check_permission = require('../utility/check_permissions');

    check_permission.checkPermission(function(err){
        if(err){
            return console.error(err);
        }

        var terminal = spawn('bash');
        terminal.stderr.on('data', function (data) {
            console.trace("How did we get here folks?");
            console.error(data);
            winston.info('error', `HarperDB server failed to run: ${data}`);
            winston.info('|------------- HarperDB failed stopped ------------|');
            //Here is where the error output goes
        });

        terminal.stdout.on('data', function (data) {
            if (callback) {
                callback();
            }
            console.log(`HarperDB Server stopped`);
            winston.info(`HarperDB Server stopped`);
        });
        terminal.stdin.write(`kill $(ps -ef | grep [h]db_ | awk '{print $2}'); echo done;`);
        terminal.stdin.end();
    });




}



