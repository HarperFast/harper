"use strict";

const all_children_stopped_event = require('../events/AllChildrenStoppedEvent');
const check_jwt_tokens = require('../utility/install/checkJWTTokensExist');
const cluster = require('cluster');
const cluster_utilities = require('./clustering/clusterUtilities');
const env = require('../utility/environment/environmentManager');
const global_schema = require('../utility/globalSchema');
const harper_logger = require('../utility/logging/harper_logger');
const hdb_license = require('../utility/registration/hdb_license');
const os = require('os');
const RestartEventObject = require('./RestartEventObject');
const sio_server_stopped_event = require('../events/SioServerStoppedEvent');
const user_schema = require('../security/user');
const util = require('util');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

async function serverParent(num_workers) {
    check_jwt_tokens();
    global.isMaster = cluster.isMaster;

    process.on('uncaughtException', function (err) {
        let message = `Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack} ${os.EOL} Terminating HDB.`;
        console.error(message);
        harper_logger.fatal(message);
        process.exit(1);
    });

    let restart_event_tracker = new RestartEventObject();
    let restart_in_progress = false;
    //TODO - WHAT CAUSES THIS - THIS IS MEANT AS A WAY TO INDICATE A USER IS TRYING TO STOP OR RESTART - DOES FASTIFY HAVE A BETTER WAY TO DO THIS?
    // Consume AllChildrenStopped Event.
    all_children_stopped_event.allChildrenStoppedEmitter.on(all_children_stopped_event.EVENT_NAME,(msg) => {
        harper_logger.info(`Got all children stopped event.`);
        try {
            restart_event_tracker.express_connections_stopped = true;
            if(restart_event_tracker.isReadyForRestart()) {
                if(!restart_in_progress) {
                    restart_in_progress = true;
                    cluster_utilities.restartHDB();
                }
            }
        } catch(err) {
            harper_logger.error(`Error tracking allchildrenstopped event.`);
        }
    });

    // Consume SocketIOServerStopped event.
    sio_server_stopped_event.sioServerStoppedEmitter.on(sio_server_stopped_event.EVENT_NAME, (msg) => {
        harper_logger.info(`Got sio server stopped event.`);
        try {
            restart_event_tracker.sio_connections_stopped = true;
            if(restart_event_tracker.isReadyForRestart()) {
                if(!restart_in_progress) {
                    restart_in_progress = true;
                    cluster_utilities.restartHDB();
                }
            }
        } catch(err) {
            harper_logger.error(`Error tracking sio server stopped event.`);
        }
    });

    await launch(num_workers)
        .catch(e => {
            harper_logger.error(e);
        });
}

async function launch(num_workers) {
    let license_values = hdb_license.licenseSearch();
    global.clustering_on = env.get('CLUSTERING');

    await p_schema_to_global();
    await user_schema.setUsersToGlobal();

    harper_logger.notify(`HarperDB successfully started`);
    harper_logger.info(`Parent ${process.pid} is running`);
    harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);

    harper_logger.info(`Kicking off ${num_workers} HDB processes.`);

    // Fork workers.
    let forks = [];
    for (let i = 0; i < num_workers; i++) {
        try {
            let forked = cluster.fork({hdb_license: JSON.stringify(license_values)});
            // assign handler for messages expected from child processes.
            forked.on('message', cluster_utilities.clusterMessageHandler);
            forked.on('error',(err) => {
                harper_logger.fatal('There was an error starting the HDB Child process.');
                harper_logger.fatal(err);
            });
            forked.on('disconnect',(err) => {
                harper_logger.error('HDB child has been disconnected.');
                harper_logger.error(err);
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
