const cluster = require('cluster');
const DEBUG = false;
const harper_logger = require('../utility/logging/harper_logger');
// We want to kick off the mgr initSync as soon as possible.
const env = require('../utility/environment/environmentManager');
try {
    env.initSync();
} catch(err) {
    process.exit(0);
}

const os = require('os');
const hdb_terms = require('../utility/hdbTerms');
// Leaving global_schema and search here so we can load them early.  They are used in other modules and should be loaded before.
const global_schema = require('../utility/globalSchema');
const search = require('../data_layer/search');
const cluster_utilities = require('./clustering/clusterUtilities');
const workers = require('./hdbWorker');
const parent = require('./hdbParent');

const PROPS_ENV_KEY = 'NODE_ENV';
const ENV_PROD_VAL = 'production';
const ENV_DEV_VAL = 'development';

let node_env_value = env.get(PROPS_ENV_KEY);

// If NODE_ENV is empty, it will show up here as '0' rather than '' or length of 0.
if (node_env_value === undefined || node_env_value === null || node_env_value === 0) {
    node_env_value = ENV_PROD_VAL;
} else if (node_env_value !== ENV_PROD_VAL || node_env_value !== ENV_DEV_VAL) {
    node_env_value = ENV_PROD_VAL;
}

process.env['NODE_ENV'] = node_env_value;

let num_hdb_processes = undefined;
let numCPUs = 4;
let num_workers = undefined;
let os_cpus = undefined;

//in an instance of having HDB installed on an android devices we don't have access to the cpu info so we need to handle the error and move on
try {
    num_hdb_processes = env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES);
    os_cpus = os.cpus().length;
    num_workers = ((num_hdb_processes && num_hdb_processes > 0) ? num_hdb_processes: os_cpus);
    // don't allow more processes than the machine has cores.
    if(num_workers > os_cpus) {
        num_workers = os_cpus;
        harper_logger.info(`${hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES} setting is higher than the number of cores on this machine (${os_cpus}).  Settings number of processes to ${os_cpus}`);
    }
} catch(e){
    num_workers = hdb_terms.HDB_SETTINGS_DEFAULT_VALUES.MAX_HDB_PROCESSES;
    if(num_hdb_processes) {
        num_workers = num_hdb_processes;
    }
    harper_logger.info(e);
}

if(DEBUG){
    numCPUs = 1;
}

global.isMaster = cluster.isMaster;
global.clustering_on = false;

cluster.on('exit', (dead_worker, code, signal) => {
    harper_logger.info(`worker ${dead_worker.process.pid} died with signal ${signal} and code ${code}`);
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
});

if (cluster.isMaster &&( numCPUs >= 1 || DEBUG )) {
    try {
        parent.init(cluster, numCPUs, num_workers);
    } catch(err) {
        harper_logger.error(`Got an error initializing the HDB Parent. ${err}`);
    }
} else {
    try {
        workers.init();
    } catch(err) {
        harper_logger.error(`Got an error initializing an HDB worker. ${err}`);
    }
}
