"use strict";

const cluster = require('cluster');
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
const user_schema = require('../security/user');
const os = require('os');
const job_runner = require('./jobRunner');
const hdb_util = require('../utility/common_utils');
const guidePath = require('path');
// Leaving global_schema and search here so we can load them early.  They are used in other modules and should be loaded before.
const global_schema = require('../utility/globalSchema');
const fs = require('fs');
const cluster_utilities = require('./clustering/clusterUtilities');
const all_children_stopped_event = require('../events/AllChildrenStoppedEvent');
const sio_server_stopped_event = require('../events/SioServerStoppedEvent');
const signalling = require('../utility/signalling');
const terms = require('../utility/hdbTerms');
const hdb_errors = require('../utility/errors/commonErrors');
const RestartEventObject = require('./RestartEventObject');
const util = require('util');
const promisify = util.promisify;
const hdb_license = require('../utility/registration/hdb_license');

const p_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);

const DEFAULT_SERVER_TIMEOUT = 120000;
const PROPS_SERVER_TIMEOUT_KEY = 'SERVER_TIMEOUT_MS';
const PROPS_PRIVATE_KEY = 'PRIVATE_KEY';
const PROPS_CERT_KEY = 'CERTIFICATE';
const PROPS_HTTP_ON_KEY = 'HTTP_ON';
const PROPS_HTTP_SECURE_ON_KEY = 'HTTPS_ON';
const PROPS_HTTP_PORT_KEY = 'HTTP_PORT';
const PROPS_HTTP_SECURE_PORT_KEY = 'HTTPS_PORT';
const PROPS_CORS_KEY = 'CORS_ON';
const PROPS_CORS_WHITELIST_KEY = 'CORS_WHITELIST';
const PROPS_ENV_KEY = 'NODE_ENV';
const ENV_PROD_VAL = 'production';
const ENV_DEV_VAL = 'development';
const TRUE_COMPARE_VAL = 'TRUE';
const REPO_RUNNING_PROCESS_NAME = `server/${terms.HDB_PROC_NAME}`;

let node_env_value = env.get(PROPS_ENV_KEY);
let running_from_repo = false;

// If NODE_ENV is empty, it will show up here as '0' rather than '' or length of 0.
if (node_env_value === undefined || node_env_value === null || node_env_value === 0) {
    node_env_value = ENV_PROD_VAL;
} else if (node_env_value !== ENV_PROD_VAL || node_env_value !== ENV_DEV_VAL) {
    node_env_value = ENV_PROD_VAL;
}

// decide if we are running from inside a repo (and executing server/hdb_express) rather than on an installed version.
process.argv.forEach((arg) => {
    if(arg.endsWith(REPO_RUNNING_PROCESS_NAME)) {
        running_from_repo = true;
        global.running_from_repo = true;
    }
});

process.env['NODE_ENV'] = node_env_value;

let num_hdb_processes = undefined;
let numCPUs = 4;
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

if(DEBUG){
    numCPUs = 1;
}

global.isMaster = cluster.isMaster;
global.clustering_on = false;

/**
 * Kicks off the clustering server and processes.  Only called with a valid license installed.
 */

cluster.on('exit', (dead_worker, code, signal) => {
    if(code === terms.RESTART_CODE_NUM) {
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
});

if (cluster.isMaster &&( numCPUs >= 1 || DEBUG )) {
    global.isMaster = cluster.isMaster;

    process.on('uncaughtException', async function (err) {
        let os = require('os');
        let message = `Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack} ${os.EOL} Terminating HDB.`;
        console.error(message);
        harper_logger.fatal(message);
        process.exit(1);
    });

    let restart_event_tracker = new RestartEventObject();
    let restart_in_progress = false;
    // Consume AllChildrenStopped Event.
    all_children_stopped_event.allChildrenStoppedEmitter.on(all_children_stopped_event.EVENT_NAME, async (msg) => {
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
    sio_server_stopped_event.sioServerStoppedEmitter.on(sio_server_stopped_event.EVENT_NAME, async (msg) => {
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

    try {
        launch().then(() => {

        });
    } catch(e){
        harper_logger.error(e);
    }

    async function launch() {
        let license_values = hdb_license.licenseSearch();
        global.clustering_on = env.get('CLUSTERING');

        await p_schema_to_global();
        await user_schema.setUsersToGlobal();

        harper_logger.notify(`HarperDB successfully started`);
        harper_logger.info(`Master ${process.pid} is running`);
        harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
        harper_logger.info(`Number of processes allowed by license is:${numCPUs}, number of cores on this machine: ${num_workers}`);
        numCPUs = (numCPUs > num_workers ? num_workers : numCPUs);
        harper_logger.info(`Kicking off ${numCPUs} HDB processes.`);

        // Fork workers.
        let forks = [];
        for (let i = 0; i < numCPUs; i++) {
            try {
                let forked = cluster.fork({hdb_license: JSON.stringify(license_values)});
                // assign handler for messages expected from child processes.
                forked.on('message', cluster_utilities.clusterMessageHandler);
                forked.on('error', (err) => {
                   harper_logger.fatal('There was an error starting the HDB Child process.');
                   harper_logger.fatal(err);
                });
                forked.on('disconnect', (err) => {
                   harper_logger.error('HDB child has been disconnected.');
                   harper_logger.error(err);
                });
                forked.on('listening', (address) => {
                    harper_logger.info(`HDB child process is listening`);
                });
                forked.on('online', (address) => {
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
} else {
    harper_logger.info('In express' + process.cwd());
    harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
    const express = require('express');
    const bodyParser = require('body-parser');
    const auth = require('../security/auth');
    const passport = require('passport');
    const pjson = require(`${__dirname}/../package.json`);
    const server_utilities = require('./serverUtilities');
    const cors = require('cors');
    const compression = require('compression');
    const spawn_cluster_connection = require('./socketcluster/connector/spawnSCConnection');

    const app = express();

    const SC_WORKER_NAME_PREFIX = 'worker_';
    global.clustering_on = false;


    let props_cors = env.get(PROPS_CORS_KEY);
    let props_cors_whitelist = env.get(PROPS_CORS_WHITELIST_KEY);

    if (props_cors && (props_cors === true || props_cors.toUpperCase() === TRUE_COMPARE_VAL)) {
        let cors_options = {
            origin: true,
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: false
        };
        if (props_cors_whitelist && props_cors_whitelist.length > 0) {
            let whitelist = props_cors_whitelist.split(',');
            cors_options.origin = (origin, callback) => {
                if (whitelist.indexOf(origin) !== -1) {
                    return callback(null, true);
                }
                return callback(new Error(`domain ${origin} is not whitelisted`));
            };
        }
        app.use(cors(cors_options));
    }

    app.use(bodyParser.json({limit: '1gb'})); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(function (error, req, res, next) {
        if (error instanceof SyntaxError) {
            res.status(hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST).send({error: 'invalid JSON: ' + error.message.replace('\n', '')});
        } else if (error) {
            res.status(hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST).send({error: error.message});
        } else {
            next();
        }
    });

    app.use(passport.initialize());

    // This handles all get requests for the studio
    app.use(compression());
    app.use(express.static(guidePath.join(__dirname,'../docs')));
    app.get('*', function (req, res) {
        return res.sendFile(guidePath.join(__dirname,'../docs', 'index.html'));
    });

    // Recent security posts recommend disabling this header.
    app.disable('x-powered-by');
    app.set('etag', false); // turn off

    app.post('/', function (req, res) {
        // Per the body-parser docs, any request which does not match the bodyParser.json middleware will be returned with
        // an empty body object.
        if(!req.body || Object.keys(req.body).length === 0) {
            return res.status(hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST).send({error: "Invalid JSON."});
        }

        auth.authorize(req, res, function (err, user) {
            if (err) {
                harper_logger.warn(err);
                harper_logger.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err.stack}"`);
                if (typeof err === 'string') {
                    return res.status(hdb_errors.HTTP_STATUS_CODES.UNAUTHORIZED).send({error: err});
                }
                return res.status(hdb_errors.HTTP_STATUS_CODES.UNAUTHORIZED).send(err);
            }
            req.body.hdb_user = user;
            req.body.hdb_auth_header = req.headers.authorization;

            server_utilities.chooseOperation(req.body, (err, operation_function) => {
                if (err) {
                    harper_logger.error(err);
                    if(err.response && err.response === server_utilities.UNAUTH_RESPONSE) {
                        return res.status(hdb_errors.HTTP_STATUS_CODES.FORBIDDEN).send(err);
                    }
                    if (typeof err === 'string') {
                        return res.status(hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: err});
                    }
                    return res.status(hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send(err);
                }

                server_utilities.processLocalTransaction(req, res, operation_function, function () {});
            });
        });
    });

    /**
     * this function strips away the cached environments from global when a schema item is removed
     * @param msg
     */
    function removeSchemaFromLMDBMap(msg){
        try{
            if(global.lmdb_map !== undefined && msg.operation !== undefined){
                let keys = Object.keys(global.lmdb_map);
                let cached_environment = undefined;
                switch (msg.operation.operation) {
                    case 'drop_schema':
                        for(let x = 0; x < keys.length; x ++){
                            let key = keys[x];
                            if(key.startsWith(`${msg.operation.schema}.`)){
                                delete global.lmdb_map[key];
                            }
                        }
                        break;
                    case 'drop_table':
                        delete global.lmdb_map[`${msg.operation.schema}.${msg.operation.table}`];
                        break;
                    case 'drop_attribute':
                        cached_environment = global.lmdb_map[`${msg.operation.schema}.${msg.operation.table}`];
                        if(cached_environment !== undefined && typeof cached_environment.dbis === 'object' && cached_environment.dbis[`${msg.operation.attribute}`] !== undefined){
                            delete cached_environment.dbis[`${msg.operation.attribute}`];
                        }
                        break;
                    default:
                        break;
                }
            }
        } catch(e){
            harper_logger.error(e);
        }
    }

    process.on('message', (msg) => {
        switch (msg.type) {
            case 'schema':
                removeSchemaFromLMDBMap(msg);
                global_schema.schemaSignal((err) => {
                    if (err) {
                        harper_logger.error(err);
                    }
                });
                break;
            case 'user':
                user_schema.setUsersToGlobal((err) => {
                    if (err) {
                        harper_logger.error(err);
                    }
                });
                break;
            case 'job':
                job_runner.parseMessage(msg.runner_message).then((result) => {
                    harper_logger.info(`completed job with result: ${JSON.stringify(result)}`);
                }).catch(function isError(e) {
                    harper_logger.error(e);
                });
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.RESTART:
                harper_logger.info(`Server close event received for process ${process.pid}`);
                harper_logger.debug(`calling shutdown`);
                let force = (msg.force_shutdown === undefined? true : msg.force_shutdown);
                shutDown(force).then(() => {
                    harper_logger.info(`Completed shut down`);
                    process.exit(terms.RESTART_CODE_NUM);
                });
                break;
            default:
                harper_logger.info(`Received unknown signaling message ${msg.type}, ignoring message`);
                break;
        }
    });

    process.on('uncaughtException', function (err) {
        let os = require('os');
        let message = `Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack} ${os.EOL} Terminating HDB.`;
        console.error(message);
        harper_logger.fatal(message);
        process.exit(1);
    });

    let httpServer = undefined;
    let secureServer = undefined;
    let server_connections = {};

    process.on('close', () => {
       harper_logger.info(`Server close event received for process ${process.pid}`);
    });

    async function setUp(){
        try {
            harper_logger.trace('Configuring child process.');
            await p_schema_to_global();
            await user_schema.setUsersToGlobal();
            spawn_cluster_connection(true);
            let license = await hdb_license.getLicense();
        } catch(e) {
            harper_logger.error(e);
        }
    }

    async function shutDown(force_bool) {
        harper_logger.debug(`calling shutdown`);
        let target_server = (httpServer ? httpServer : secureServer);
        if(target_server) {
            harper_logger.warn(`Process pid:${process.pid} - SIGINT received, closing connections and finishing existing work.`);
            harper_logger.info(`There are ${Object.keys(server_connections).length} connections.`);
            for (let conn of Object.keys(server_connections)) {
                harper_logger.info(`Closing connection ${util.inspect(server_connections[conn])}`);
                server_connections[conn].destroy();
            }
            setTimeout(() => {
                harper_logger.info(`Timeout occurred during client disconnect.  Took longer than ${terms.RESTART_TIMEOUT_MS}ms.`);
                hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
            }, terms.RESTART_TIMEOUT_MS);
            target_server.close(function () {
                harper_logger.warn(`Process pid:${process.pid} - Work completed, shutting down`);
                hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
            });
        }
    }

    try {
        const http = require('http');
        const httpsecure = require('https');

        const privateKey = env.get(PROPS_PRIVATE_KEY);
        const certificate = env.get(PROPS_CERT_KEY);
        const credentials = {key: fs.readFileSync(`${privateKey}`), cert: fs.readFileSync(`${certificate}`)};
        const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY);
        const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
        const props_http_on = env.get(PROPS_HTTP_ON_KEY);

        global.isMaster = cluster.isMaster;

        harper_logger.debug(`child process ${process.pid} starting up.`);

        setUp().then(()=>{});

        let keep_alive_timeout = env.get(terms.HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY);
        let headers_timeout = env.get(terms.HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY);

        if (props_http_secure_on &&
            (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            secureServer = httpsecure.createServer(credentials, app);

            if(keep_alive_timeout !== undefined){
                secureServer.keepAliveTimeout = keep_alive_timeout;
            }

            if(headers_timeout !== undefined){
                secureServer.headersTimeout = headers_timeout;
            }

            secureServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            secureServer.listen(env.get(PROPS_HTTP_SECURE_PORT_KEY), function () {
                harper_logger.info(`HarperDB ${pjson.version} HTTPS Server running on ${env.get(PROPS_HTTP_SECURE_PORT_KEY)}`);
                signalling.signalChildStarted();
            });
        }

        if (props_http_on &&
            (props_http_on === true || props_http_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            harper_logger.debug(`child process starting up http server.`);
            httpServer = http.createServer(app);
            httpServer.on('connection', function(conn) {
                let key = conn.remoteAddress + ':' + conn.remotePort;
                server_connections[key] = conn;
                conn.on('close', function() {
                    harper_logger.debug(`removing connection for ${key}`);
                    delete server_connections[key];
                });
            });

            if(keep_alive_timeout !== undefined){
                httpServer.keepAliveTimeout = keep_alive_timeout;
            }

            if(headers_timeout !== undefined){
                httpServer.headersTimeout = headers_timeout;
            }

            httpServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            httpServer.listen(env.get(PROPS_HTTP_PORT_KEY), function () {
                harper_logger.info(`HarperDB ${pjson.version} HTTP Server running on ${env.get(PROPS_HTTP_PORT_KEY)}`);
                signalling.signalChildStarted();
            });
        }


    } catch (e) {
        harper_logger.error(e);
    }
}
