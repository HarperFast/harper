"use strict";

const check_jwt_tokens = require('../../utility/install/checkJWTTokensExist');
const cluster = require('cluster');
const env = require('../../utility/environment/environmentManager');
const global_schema = require('../../utility/globalSchema');
const harper_logger = require('../../utility/logging/harper_logger');
const os = require('os');
const user_schema = require('../../security/user');
const util = require('util');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

/**
 * Function called to start up HDB server clustering process - this method is called from customFunctionServer as the "parent" process
 * that creates/manages the forked child processes and ensures all processes are communicating with one another
 *
 * @param num_workers - the number of processes to fork - this represents the number of server instances that will be built
 * @returns {Promise<void>}
 */
async function serverParent(num_workers) {
    harper_logger.notify('starting Custom Functions serverParent');
    check_jwt_tokens();
    global.isCustomFunctionMaster = cluster.isMaster;

    process.on('uncaughtException', function (err) {
        let message = `Found an uncaught exception with message: ${err.message}${os.EOL}Stack: ${err.stack}${os.EOL} Terminating Custom Functions Server.`;
        console.error(message);
        harper_logger.fatal(message);
        process.exit(1);
    });

    try {
        //Launch child server processes
        await launch(num_workers);
    } catch(e) {
        harper_logger.error(e);
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

    await p_schema_to_global();
    await user_schema.setUsersToGlobal();

    harper_logger.notify(`Custom Functions successfully started`);
    harper_logger.info(`Custom Functions Parent ${process.pid} is running`);
    harper_logger.info(`Custom Functions Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
    harper_logger.info(`Kicking off ${num_workers} Custom Functions processes.`);

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
    global.custom_functions_forks = forks;
}

module.exports = serverParent;
