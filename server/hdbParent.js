"use strict";

const log = require('../utility/logging/harper_logger');
const env = require('../utility/environment/environmentManager');
const global_schema = require('../utility/globalSchema');
const cluster_utilities = require('./clustering/clusterUtilities');
const search = require('../data_layer/search');
const hdb_license = require('../utility/registration/hdb_license');
const {promisify} = require('util');

const PROPS_ENV_KEY = 'NODE_ENV';
const NUM_CPU_INCREMENT_AMOUNT = 16;
const CPU_DEFAULT_AMOUNT = 4;

// promisified functions
const p_global_set_schema_global = promisify(global_schema.setSchemaDataToGlobal);
const p_search_search_by_value = promisify(search.searchByValue);

async function init(cluster_instance, num_cpu, num_worker) {
    let node_env_value = env.get(PROPS_ENV_KEY);
    process.env['NODE_ENV'] = node_env_value;
    let numCPUs = num_cpu;
    let num_workers = num_worker;

    process.on('uncaughtException', function (err) {
        console.error(`HarperDB has encountered an unrecoverable error.  Please check the logs and restart.`);
        log.fatal(`Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack}. Terminating HDB.`);
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
    let data = null;
    let licenses = null;
    try {
        data = await p_global_set_schema_global();
        licenses = await p_search_search_by_value(licenseKeySearch);

        await Promise.all(licenses.map(async (license) => {
            try {
                let license_validation = await hdb_license.validateLicense(license.license_key, license.company);
                if (license_validation.valid_machine && license_validation.valid_date && license_validation.valid_license) {
                    enterprise = true;
                    cluster_utilities.setEnterprise(true);
                    if (num_workers > numCPUs) {
                        if (numCPUs === CPU_DEFAULT_AMOUNT) {
                            numCPUs = NUM_CPU_INCREMENT_AMOUNT;
                        } else {
                            numCPUs += NUM_CPU_INCREMENT_AMOUNT;
                        }
                    }
                }
            } catch(e){
                log.error(e);
            }
        }));
        log.info(`Master ${process.pid} is running`);
        log.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
        log.info(`Number of processes allowed by license is:${numCPUs}, number of cores on this machine: ${num_workers}`);
        numCPUs = (numCPUs > num_workers ? num_workers : numCPUs);
        log.info(`Kicking off ${numCPUs} HDB processes.`);

        // Fork workers.
        let forks = [];
        for (let i = 0; i < numCPUs; i++) {
            try {
                let forked = cluster_instance.fork();
                // assign handler for messages expected from child processes.
                forked.on('message', cluster_utilities.clusterMessageHandler);
                forks.push(forked);
            } catch (e) {
                log.fatal(`Had trouble kicking off new HDB processes.  ${e}`);
            }
        }

        global.forks = forks;
        global.forkClusterMsgQueue = {};
    } catch(err) {
        return log.error(err);
    }
}

module.exports = {
    init: init
};