#!/usr/bin/env node

module.exports = {
    stop: stop
}



function stop(callback) {
    let PropertiesReader = require('properties-reader'),
    hdb_boot_properties =  PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
    hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));

    if (require("os").userInfo().username != hdb_boot_properties.get('install_user')) {
        if(callback)
            callback(`Must run as ${hdb_boot_properties.get('install_user')}`)
        return console.error(`Error: Must stop as ${hdb_boot_properties.get('install_user')}`);

    }
    const spawn = require('child_process').spawn,
        winston = require('../utility/logging/winston_logger');

    var terminal = spawn('bash');
    terminal.stderr.on('data', function (data) {
        console.error(data);
        winston.info('error', `Express server failed to run: ${data}`);
        winston.info('|------------- HarperDB failed stopped ------------|');
        //Here is where the error output goes
    });

    terminal.stdout.on('data', function (data) {
        if (callback) {
            callback();
        }
        console.log(`Express Server stopped`);
        winston.info(`Express Server stopped`);
    });
    terminal.stdin.write(`kill $(ps -ef | grep [h]db_ | awk '{print $2}'); echo done;`);
    terminal.stdin.end();


}



