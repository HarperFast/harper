"use strict";

const DEBUG = false;

const harper_logger = require('../utility/logging/harper_logger');
// We want to kick off the mgr initSync as soon as possible.
const env = require('../utility/environment/environmentManager');
try {
    env.initSync();
} catch(err) {
    harper_logger.error(`Got an error loading the environment.  Exiting.${err}`);
    process.exit(0);
}

// Leaving global_schema here so we can load them early.  They are used in other modules and should be loaded before.
const global_schema = require('../utility/globalSchema');

const os = require('os');
const cluster = require('cluster');
const cluster_utilities = require('./clustering/clusterUtilities');
const terms = require('../utility/hdbTerms');

const serverParent = require('./serverParent');
const serverChild = require('./serverChild');

const PROPS_ENV_KEY = 'NODE_ENV';
const ENV_PROD_VAL = 'production';
const ENV_DEV_VAL = 'development';
const REPO_RUNNING_PROCESS_NAME = `server/${terms.HDB_PROC_NAME}`;

let node_env_value = env.get(PROPS_ENV_KEY);
let running_from_repo = false;

// If NODE_ENV is empty, it will show up here as '0' rather than '' or length of 0.
if (node_env_value === undefined || node_env_value === null || node_env_value === 0 || node_env_value !== ENV_PROD_VAL || node_env_value !== ENV_DEV_VAL) {
    node_env_value = ENV_PROD_VAL;
}

// decide if we are running from inside a repo (and executing server/hdbServer) rather than on an installed version.
process.argv.forEach((arg) => {
    if(arg.endsWith(REPO_RUNNING_PROCESS_NAME)) {
        running_from_repo = true;
        global.running_from_repo = running_from_repo;
    }
});

process.env['NODE_ENV'] = node_env_value;

let num_hdb_processes = undefined;
let num_workers = undefined;
let os_cpus = undefined;

//in an instance of having HDB installed on an android devices we don't have access to the cpu info so we need to handle the error and move on
try {
    num_hdb_processes = env.get(terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES);
    os_cpus = os.cpus().length;
    num_workers = ((num_hdb_processes && num_hdb_processes > 0) ? num_hdb_processes: os_cpus);
    // don't allow more processes than the machine has cores.
    if(num_workers > os_cpus) {
        num_workers = os_cpus;
        harper_logger.info(`${terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES} setting is higher than the number of cores on this machine (${os_cpus}).  Settings number of processes to ${os_cpus}`);
    }
} catch(e){
    num_workers = terms.HDB_SETTINGS_DEFAULT_VALUES.MAX_HDB_PROCESSES;
    if(num_hdb_processes) {
        num_workers = num_hdb_processes;
    }
    harper_logger.info(e);
}

if (DEBUG){
    num_workers = 1;
}

global.isMaster = cluster.isMaster;
global.clustering_on = false;

/**
 * Kicks off the clustering server and processes.  Only called with a valid license installed.
 */

cluster.on('exit', handleClusterExit);

if (cluster.isMaster &&( num_workers >= 1 || DEBUG )) {
    serverParent(num_workers);
} else {
    serverChild();
}

function handleClusterExit(dead_worker, code, signal) {
    if (code === terms.RESTART_CODE_NUM) {
        harper_logger.info(`Received restart code, disabling process auto restart.`);
        return;
    }
    harper_logger.fatal(`worker ${dead_worker.process.pid} died with signal ${signal} and code ${code}`);
    let new_worker = undefined;
    try {
        new_worker = cluster.fork();
        new_worker.on('message', cluster_utilities.clusterMessageHandler);
        harper_logger.info(`kicked off replacement worker with new pid=${new_worker.process.pid}`);
    } catch (e) {
        harper_logger.fatal(`FATAL error trying to restart a dead_worker with pid ${dead_worker.process.pid}.  ${e}`);
        return;
    }
    for (let a_fork in global.forks) {
        if (global.forks[a_fork].process.pid === dead_worker.process.pid) {
            global.forks[a_fork] = new_worker;
            harper_logger.trace(`replaced dead fork in global.forks with new fork that has pid ${new_worker.process.pid}`);
        }
    }
}
