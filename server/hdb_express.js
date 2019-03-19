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
const global_schema = require('../utility/globalSchema');
const cluster_utilities = require('./clustering/clusterUtilities');
const workers = require('./hdbWorker');
const search = require('../data_layer/search');
const enterprise_util = require('../utility/enterpriseInitialization');

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
    global.isMaster = cluster.isMaster;

    process.on('uncaughtException', function (err) {
        let os = require('os');
        let message = `Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack} ${os.EOL} Terminating HDB.`;
        console.error(message);
        harper_logger.fatal(message);

        process.exit(1);
    });

    let enterprise = false;
    global.delegate_callback_queue = [];
    let licenseKeySearch = {
        operation: 'search_by_value',
        schema: 'system',
        table: 'hdb_license',
        hash_attribute: 'license_key',
        search_attribute: "license_key",
        search_value: "*",
        get_attributes: ["*"]
    };
    global_schema.setSchemaDataToGlobal((err, data)=> {
        search.searchByValue(licenseKeySearch, function (err, licenses) {
            const hdb_license = require('../utility/registration/hdb_license');
            if (err) {
                return harper_logger.error(err);
            }

            Promise.all(licenses.map(async (license) => {
                try {
                    let license_validation = await hdb_license.validateLicense(license.license_key, license.company);
                    if (license_validation.valid_machine && license_validation.valid_date && license_validation.valid_license) {
                        enterprise = true;
                        cluster_utilities.setEnterprise(true);
                        if (num_workers > numCPUs) {
                            if (numCPUs === 4) {
                                numCPUs = 16;
                            } else {
                                numCPUs += 16;
                            }
                        }
                    }
                } catch(e){
                    harper_logger.error(e);
                }
            })).then(() => {
                harper_logger.info(`Master ${process.pid} is running`);
                harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
                harper_logger.info(`Number of processes allowed by license is:${numCPUs}, number of cores on this machine: ${num_workers}`);
                numCPUs = (numCPUs > num_workers ? num_workers : numCPUs);
                harper_logger.info(`Kicking off ${numCPUs} HDB processes.`);

                // Fork workers.
                let forks = [];
                for (let i = 0; i < numCPUs; i++) {
                    try {
                        let forked = cluster.fork();
                        // assign handler for messages expected from child processes.
                        forked.on('message', cluster_utilities.clusterMessageHandler);
                        forks.push(forked);
                    } catch (e) {
                        harper_logger.fatal(`Had trouble kicking off new HDB processes.  ${e}`);
                    }
                }

                global.forks = forks;
                global.forkClusterMsgQueue = {};
            });
        });
    });
} else {
    workers.init();
}
