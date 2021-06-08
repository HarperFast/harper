"use strict";

const cluster = require('cluster');
const os = require('os');
const util = require('util');
const child_process = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const fg = require('fast-glob');

const all_cf_children_stopped_event = require('../../events/AllCFChildrenStoppedEvent');
const check_jwt_tokens = require('../../utility/install/checkJWTTokensExist');

const env = require('../../utility/environment/environmentManager');
const global_schema = require('../../utility/globalSchema');
const harper_logger = require('../../utility/logging/harper_logger');
const RestartEventObject = require('../RestartEventObject');
const user_schema = require('../../security/user');
const hdb_terms = require('../../utility/hdbTerms');
const IPCClient = require('../ipc/IPCClient');
const hdbParentIpcHandlers = require('../ipc/hdbParentIpcHandlers');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

/**
 * Function called to start up HDB server clustering process - this method is called from customFunctionServer as the "parent" process
 * that creates/manages the forked child processes and ensures all processes are communicating with one another
 *
 * @param num_workers - the number of processes to fork - this represents the number of server instances that will be built
 * @returns {Promise<void>}
 */
async function serverParent(num_workers) {
    check_jwt_tokens();
    global.isCustomFunctionMaster = cluster.isMaster;
    global.service = hdb_terms.SERVICES.CUSTOM_FUNCTIONS;

    try {
        // Instantiate new instance of HDB IPC client and assign it to global.
        global.hdb_ipc = new IPCClient(process.pid, hdbParentIpcHandlers);
    } catch(err) {
        harper_logger.error('Error instantiating new instance of IPC client in Custom Functions server parent');
        harper_logger.error(err);
        throw err;
    }

    process.on('uncaughtException', function (err) {
        let message = `Found an uncaught exception with message: ${err.message}${os.EOL}Stack: ${err.stack}${os.EOL} Terminating Custom Functions Server.`;
        console.error(message);
        harper_logger.fatal(message);
        process.exit(1);
    });

    let restart_event_tracker = new RestartEventObject();

    // Handles restart operation for all processes
    all_cf_children_stopped_event.allCFChildrenStoppedEmitter.on(all_cf_children_stopped_event.EVENT_NAME, (msg) => {
        harper_logger.info(`Got all custom function children stopped event.`);
        try {
            restart_event_tracker.fastify_connections_stopped = true;
            if(restart_event_tracker.isReadyForRestart()) {
                restartCF();
            }
        } catch(err) {
            harper_logger.error(`Error tracking all custom function children stopped event.`);
        }
    });

    try {
        //Launch child server processes
        await launch(num_workers);
    } catch(e) {
        harper_logger.error(e);
    }
}

function restartCF() {
    const CF_SERVER_CWD = path.resolve(__dirname, '../customFunctions');
    try {
        const args = path.join(CF_SERVER_CWD, 'restartCFServer.js');
        let child = child_process.spawn('node', [args], {detached:true, stdio: "ignore"});
        child.unref();
    } catch (err) {
        let msg = `There was an error restarting Custom Functions.  Please restart manually. ${err}`;
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
    global.custom_functions_on = env.get('CUSTOM_FUNCTIONS');

    const CF_ROUTES_DIR = env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);

    await p_schema_to_global();
    await user_schema.setUsersToGlobal();

    harper_logger.notify(`Custom Functions successfully started`);
    harper_logger.info(`Custom Functions Parent ${process.pid} is running`);
    harper_logger.info(`Custom Functions Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
    harper_logger.info(`Kicking off ${num_workers} Custom Functions processes.`);

    if (!fs.existsSync(CF_ROUTES_DIR)){
        fs.mkdirSync(CF_ROUTES_DIR);
    }

    const route_project_folders = fg.sync(`${CF_ROUTES_DIR}/*`, { onlyDirectories: true });

    if (route_project_folders.length === 0) {
        fs.copySync(path.join(__dirname, 'template'), CF_ROUTES_DIR);
    }

    // Fork workers.
    let forks = [];
    for (let i = 0; i < num_workers; i++) {
        try {
            let forked = cluster.fork();
            forked.on('error',(err) => {
                harper_logger.fatal('There was an error starting the Custom Functions Child process.');
                harper_logger.fatal(err);
            });
            forked.on('disconnect',(err) => {
                harper_logger.error('Custom Functions child has been disconnected.');
                if (err) {
                    harper_logger.error(err);
                }
            });
            forked.on('listening',() => {
                harper_logger.info('Custom Functions child process is listening');
            });
            forked.on('online',() => {
                harper_logger.info('Custom Functions child process is online.');
            });

            harper_logger.debug(`kicked off fork.`);
            forks.push(forked);
        } catch (e) {
            harper_logger.fatal(`Had trouble kicking off new Custom Function processes.  ${e}`);
        }
    }

    global.forks = forks;
}

module.exports = serverParent;
