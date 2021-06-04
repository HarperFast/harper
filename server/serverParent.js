"use strict";

const all_children_stopped_event = require('../events/AllChildrenStoppedEvent');
const check_jwt_tokens = require('../utility/install/checkJWTTokensExist');
const { closeEnvironment } = require('../utility/lmdb/environmentUtility');
const cluster = require('cluster');
const cluster_utilities = require('./clustering/clusterUtilities');
const env = require('../utility/environment/environmentManager');
const global_schema = require('../utility/globalSchema');
const harper_logger = require('../utility/logging/harper_logger');
const os = require('os');
const RestartEventObject = require('./RestartEventObject');
const user_schema = require('../security/user');
const util = require('util');
const hdb_terms = require('../utility/hdbTerms');
const IPCClient = require('./ipc/IPCClient');
const hdbParentIpcHandlers = require('./ipc/hdbParentIpcHandlers');
const child_process = require('child_process');
const path = require('path');

const HDB_SERVER_CWD = __dirname;

const {
    handleBeforeExit,
    handleExit,
    handleSigint,
    handleSigquit,
    handleSigterm
} = require('./serverHelpers/serverHandlers');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

/**
 * Function called to start up HDB server clustering process - this method is called from hdbServer as the "parent" process
 * that creates/manages the forked child processes and ensures all processes are communicating with one another
 *
 * @param num_workers - the number of processes to fork - this represents the number of server instances that will be built
 * @returns {Promise<void>}
 */
async function serverParent(num_workers) {
    check_jwt_tokens();
    global.isMaster = cluster.isMaster;
    global.service = hdb_terms.SERVICES.HDB_CORE;

    try {
        // Instantiate new instance of HDB IPC client and assign it to global.
        global.hdb_ipc = new IPCClient(process.pid, hdbParentIpcHandlers);
    } catch(err) {
        harper_logger.error('Error instantiating new instance of IPC client in HDB server parent');
        harper_logger.error(err);
        throw err;
    }

    process.on('uncaughtException', function (err) {
        let message = `Found an uncaught exception with message: ${err.message}${os.EOL}Stack: ${err.stack}${os.EOL}Terminating HDB.`;
        console.error(message);
        const final_logger = harper_logger.finalLogger();
        final_logger.fatal(message);
        process.exit(1);
    });

    process.on('beforeExit', handleBeforeExit);
    process.on('exit', handleExit);
    process.on('SIGINT', handleSigint);
    process.on('SIGQUIT', handleSigquit);
    process.on('SIGTERM', handleSigterm);

    let restart_event_tracker = new RestartEventObject();

    // Handles restart operation for all processes
    all_children_stopped_event.allChildrenStoppedEmitter.on(all_children_stopped_event.EVENT_NAME,(msg) => {
        harper_logger.info(`Got all children stopped event.`);
        try {
            restart_event_tracker.fastify_connections_stopped = true;
            if(restart_event_tracker.isReadyForRestart()) {
                restartHDB();
            }
        } catch(err) {
            harper_logger.error(`Error tracking all children stopped event.`);
        }
    });

    try {
        //Launch child server processes
        await launch(num_workers);
    } catch(e) {
        harper_logger.error(e);
    }
}

function restartHDB() {
    try {
        const args = path.join(HDB_SERVER_CWD, 'restartHDBServer.js');
        let child = child_process.spawn('node', [args], {detached:true, stdio: "ignore"});
        child.unref();
    } catch (err) {
        let msg = `There was an error restarting HarperDB.  Please restart manually. ${err}`;
        console.log(msg);
        harper_logger.error(msg);
        throw err;
    }
}

/**
 * Forks the process (to build child processes that will run servers) and sets the forked processes to a global value for
 * to allow parent process to effectively manage all child processes.
 *
 * Also ensures other important global values - e.g. schema, users - are updated/set
 *
 * @param num_workers
 * @returns {Promise<void>}
 */
async function launch(num_workers) {
    global.clustering_on = env.get('CLUSTERING');

    await p_schema_to_global();

    //we need to close all of the environments on the parent process & delete the references.
    let keys = Object.keys(global.lmdb_map);
    for(let x = 0, length = keys.length; x < length; x++){
        closeEnvironment(global.lmdb_map[keys[x]]);
    }
    delete global.lmdb_map;

    await user_schema.setUsersToGlobal();

    harper_logger.notify(`HarperDB successfully started`);
    harper_logger.info(`Parent ${process.pid} is running`);
    harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);

    harper_logger.info(`Kicking off ${num_workers} HDB processes.`);

    // Fork workers.
    let forks = [];
    for (let i = 0; i < num_workers; i++) {
        try {
            let forked = cluster.fork();

            forked.on('error',(err) => {
                harper_logger.fatal('There was an error starting the HDB Child process.');
                harper_logger.fatal(err);
            });
            forked.on('disconnect',(err) => {
                harper_logger.error('HDB child has been disconnected.');
                if (err) {
                    harper_logger.error(err);
                }
            });
            forked.on('listening',(address) => {
                harper_logger.info(`HDB child process is listening`);
            });
            forked.on('online',(address) => {
                harper_logger.info(`HDB child process is online.`);
            });

            harper_logger.debug(`kicked off fork.`);
            forks.push(forked);
        } catch (e) {
            harper_logger.fatal(`Had trouble kicking off new HDB processes.  ${e}`);
        }
    }
    global.forks = forks;
}

module.exports = serverParent;
