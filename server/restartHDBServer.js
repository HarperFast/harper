'use strict';

const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const hdb_license = require('../utility/registration/hdb_license');
const env = require('../utility/environment/environmentManager');
const stop = require('../bin/stop');
const path = require('path');
const fork = require('child_process').fork;

const HDB_SERVER_CWD = __dirname;
const HDB_STOP_ERR = 'Restart had an error trying to stop HDB server.';
let run_in_foreground;

/**
 * This function it used by HDB serverParent to stop all HDB core processes and then restart them.
 */
(async function restartHDBServer() {
    try {
        try {
            await hdb_utils.stopProcess(path.join(HDB_SERVER_CWD, hdb_terms.HDB_PROC_NAME));
        } catch(err) {
            console.error(HDB_STOP_ERR);
            throw err;
        }

        const hdb_args = hdb_utils.createForkArgs(path.join(HDB_SERVER_CWD, hdb_terms.HDB_PROC_NAME));
        const license = hdb_license.licenseSearch();
        const foreground_env = env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.RUN_IN_FOREGROUND);
        run_in_foreground = foreground_env === 'true' || foreground_env === true || foreground_env === 'TRUE';
        const mem_value = license.ram_allocation ? hdb_terms.MEM_SETTING_KEY + license.ram_allocation
            : hdb_terms.MEM_SETTING_KEY + hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT;

        let options = {
            detached: true,
            stdio: 'ignore',
            execArgv: [mem_value]
        };

        //if LOG_TO_STDSTREAM in settings = true we do not want to ignore the stdio so that logging gets pushed to the terminal.
        const log_to_streams = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_STDSTREAMS);
        if(!hdb_utils.isEmpty(log_to_streams) && log_to_streams.toString().toLowerCase() === 'true'){
            delete options.stdio;
        }

        const hdb_child = fork(hdb_args[0], [hdb_args[1]], options);

        if (!run_in_foreground) {
            hdb_child.unref();
            process.exit(0);
        }

        process.on('exit', processExitHandler);

        //catches ctrl+c event
        process.on('SIGINT', processExitHandler);

        // catches "kill pid"
        process.on('SIGUSR1', processExitHandler);
        process.on('SIGUSR2', processExitHandler);
    } catch(err) {
        console.error(err);
        throw err;
    }
})();

/**
 * If running in foreground and exit event occurs stop is called
 * @returns {Promise<void>}
 */
async function processExitHandler() {
    if (run_in_foreground) {
        try {
            await stop.stop();
        } catch(err) {
            console.error(err);
        }
    }
}