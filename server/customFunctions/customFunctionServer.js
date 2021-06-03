"use strict";
console.log('CALLED####');
const os = require('os');
const cluster = require('cluster');

const harper_logger = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');

const serverParent = require('./serverParent');
const serverChild = require('./serverChild');

const DEBUG = false;

try {
    env.initSync();
} catch(err) {
    harper_logger.error(`Got an error loading the environment.  Exiting.${err}`);
    process.exit(0);
}

const PROPS_ENV_KEY = 'NODE_ENV';
const ENV_PROD_VAL = 'production';
const ENV_DEV_VAL = 'development';
const REPO_RUNNING_PROCESS_NAME = `server/customFunctions/${terms.CUSTOM_FUNCTION_PROC_NAME}`;

let node_env_value = env.get(PROPS_ENV_KEY);
let running_from_repo = false;

// If NODE_ENV is empty, it will show up here as '0' rather than '' or length of 0.
if (node_env_value === undefined || node_env_value === null || node_env_value === 0 || node_env_value !== ENV_PROD_VAL || node_env_value !== ENV_DEV_VAL) {
    node_env_value = ENV_PROD_VAL;
}

// decide if we are running from inside a repo (and executing server/customFunctionServer) rather than on an installed version.
process.argv.forEach((arg) => {
    if (arg.endsWith(REPO_RUNNING_PROCESS_NAME)) {
        running_from_repo = true;
        global.running_from_repo = running_from_repo;
    }
});

process.env['NODE_ENV'] = node_env_value;

let num_cf_processes = undefined;
let num_workers = undefined;
let os_cpus = undefined;

//in an instance of having HDB installed on an android devices we don't have access to the cpu info so we need to handle the error and move on
try {
    num_cf_processes = env.get(terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES); // TODO do we need to start all the processes if there arent that many functions?
    os_cpus = os.cpus().length;
    num_workers = ((num_cf_processes && num_cf_processes > 0) ? num_cf_processes : os_cpus);
    // don't allow more processes than the machine has cores.
    if (num_workers > os_cpus) {
        num_workers = os_cpus;
        harper_logger.info(`${terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES} setting is higher than the number of cores on this machine (${os_cpus}).  Settings number of processes to ${os_cpus}`);
    }
} catch(e) {
    num_workers = terms.HDB_SETTINGS_DEFAULT_VALUES.MAX_CUSTOM_FUNCTION_PROCESSES;
    if (num_cf_processes) {
        num_workers = num_cf_processes;
    }
    harper_logger.info(e);
}

if (DEBUG) {
    num_workers = 1;
}

global.isMaster = cluster.isMaster;
global.clustering_on = false;

/**
 * Kicks off the custom function server and processes.
 */

if (cluster.isMaster && (num_workers >= 1)) {
    serverParent(num_workers);
} else {
    serverChild();
}
