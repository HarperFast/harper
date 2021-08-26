"use strict";

const WorkerIF = require('./WorkerIF');
const SCServer = require('../handlers/SCServer');
const types = require('../types');
const {promisify} = require('util');
const log = require('../../../utility/logging/harper_logger');
const sc_utils = require('../util/socketClusterUtils');
const terms = require('../../../utility/hdbTerms');
const RoomMessageObjects = require('../room/RoomMessageObjects');
const clean_lmdb = require('../../../utility/lmdb/cleanLMDBMap');
const cluster_data = require('../util/clusterData');
const IPCClient = require('../../ipc/IPCClient');
const ipc_server_handlers = require('../../ipc/serverHandlers');
const ipc_schema_handler = ipc_server_handlers.schema;
const { validateEvent } = require('../../../server/ipc/utility/ipcUtils');
// NOTE: The cluster worker doesn't use the environment manager yet, but some of the commands need values in there.
// We initialize this here so the manager is always ready and initialized when a rule needs it.
const env = require('../../../utility/environment/environmentManager');
env.initSync();

/**
 * Represents a WorkerIF implementation for socketcluster.
 */
class ClusterWorker extends WorkerIF {
    constructor() {
        super();
    }

    /**
     * Check to see if a room exists for a given message when it is received.  If the room does not exist, it will be
     * created before moving on to the next middleware.
     * @param req
     * @param next
     * @returns {*}
     */
    checkNewRoom(req, next) {
        log.trace('In checkNewRoom');
        try {
            if(!req || !req.channel) {
                log.error('Got an invalid request.');
                return next('Got an invalid request.');
            }
            this.ensureRoomExists(req.channel);
            return next();
        } catch(err) {
            log.error(`got an error checking for rooms.`);
            log.error(err);
            return next(err);
        }
    }

    /**
     * If a room does not yet exist for the specified channel, create one.  Will also subscribe to and watch the channel.
     * @param channel - the name of the channel to watch.
     */
    ensureRoomExists(channel) {
        if(!this.getRoom(channel)) {
            log.debug(`Creating room:  ${channel}`);
            let newRoom = this.createRoom(channel);
            if (newRoom) {
                this.addRoom(newRoom);
            }
        }
    }

    /**
     * Run this worker.
     */
    run() {
        log.debug('Cluster Worker starting up.');

        try {
            const sc_worker_ipc_handlers = {
                [terms.IPC_EVENT_TYPES.SCHEMA]: this.parentMessageHandler.bind(this),
                [terms.IPC_EVENT_TYPES.CLUSTER_STATUS_REQUEST]: this.clusterStatusHandler.bind(this)
            };
            global.hdb_ipc = new IPCClient(process.pid, sc_worker_ipc_handlers);
            log.trace('Instantiated IPC client in socket cluster worker');
        } catch(err) {
            log.error('Error instantiating new instance of IPC client in socket cluster worker');
            log.error(err);
            throw err;
        }

        this.hdb_workers = [];
        this.hdb_users = {};

        this.exchange_get = promisify(this.exchange.get).bind(this.exchange);
        this.exchange_set = promisify(this.exchange.set).bind(this.exchange);
        this.exchange_remove = promisify(this.exchange.remove).bind(this.exchange);
        log.trace('Calling processArgs');
        this.processArgs().then(()=> {
            log.error('set middleware');
            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.checkNewRoom.bind(this));
            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.messagePrepMiddleware.bind(this));
            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.evalRoomPublishInMiddleware.bind(this));
            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.evalRoomPublishInRules.bind(this));

            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_HANDSHAKE_SC, this.evalRoomHandshakeSCMiddleware.bind(this));
            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_OUT, this.evalRoomPublishOutMiddleware.bind(this));

            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_SUBSCRIBE, this.checkNewRoom.bind(this));
            this.scServer.addMiddleware(this.scServer.MIDDLEWARE_SUBSCRIBE, this.evalRoomSubscribeMiddleware.bind(this));
            new SCServer(this);

            // Create a room for and subscribe to internal hdb channels.
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.HDB_USERS);
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.HDB_WORKERS);
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.WORKER_ROOM);

            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.ADD_USER);
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.ALTER_USER);
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.DROP_USER);
        });
    }

    async processArgs() {
        log.trace('processArgs');
        try{

            let hdb_data = await cluster_data();

            let users = {};
            if(hdb_data && hdb_data.users) {
                hdb_data.users.forEach((user) => {
                    users[user.username] = user;
                });
            }
            this.hdb_users = users;

            if(hdb_data !== undefined && this.isLeader) {
                await this.setHDBDatatoExchange(hdb_data);
                log.info('hdb_data successfully set to exchange');
                return hdb_data;
            }
        } catch(e){
            log.error(e);
        }
    }

    syncSchemaMetadata(msg) {
            if (global.hdb_schema !== undefined && typeof global.hdb_schema === 'object' && msg !== undefined) {
                // eslint-disable-next-line default-case
                switch (msg.operation) {
                    case 'drop_schema':
                        delete global.hdb_schema[msg.schema];
                        break;
                    case 'drop_table':
                        if (global.hdb_schema[msg.schema] !== undefined) {
                            delete global.hdb_schema[msg.schema][msg.table];
                        }
                        break;
                }
            }
    }

    clusterStatusHandler(event){
        let cluster_status_response = sc_utils.getWorkerStatus(this);
        global.hdb_ipc.emitToServer({type: terms.IPC_EVENT_TYPES.CLUSTER_STATUS_RESPONSE+ event.message.id, message: cluster_status_response});
    }

    async parentMessageHandler(event) {
        log.trace(`parentMessageHandler received event`);
        const validate = validateEvent(event);
        if (validate) {
            log.error(validate);
            return;
        }

        try {
            if (event.message !== undefined) {
                this.setHDBDatatoExchange(event.message).then(() => {
                    log.info('hdb_data successfully set to exchange');
                });
            }

            if(event.type && event.type === 'schema'){
                clean_lmdb(event.message, true);
                await ipc_schema_handler(event);
            }

        }catch(e){
            log.error(`Error in cluster worker parent message handler ${e}`);
            throw e;
        }
    }

    async setHDBDatatoExchange(hdb_data) {
        log.trace('setHDBDatatoExchange');
        try {
            if (hdb_data.schema !== undefined) {
                await this.exchange_set('hdb_schema', hdb_data.schema);
            }

            //convert the users array into an object where the key is the username, this allows for easier searching of users
            if (hdb_data.users !== undefined) {
                let users = {};
                hdb_data.users.forEach((user) => {
                    users[user.username] = user;
                });
                this.hdb_users = users;
                let hdb_users_msg = new RoomMessageObjects.SyncHdbUsersMessage();
                hdb_users_msg.users = users;
                // Don't post the message to the exchange, just the users.
                await this.exchange_set(terms.INTERNAL_SC_CHANNELS.HDB_USERS, users);
                await this.exchange.publish(terms.INTERNAL_SC_CHANNELS.HDB_USERS, hdb_users_msg);
            }

            if (hdb_data.nodes !== undefined) {
                await this.exchange_set('hdb_nodes', hdb_data.nodes);
            }
        }catch(e){
            log.error(e);
        }
    }

    /**
     * This needs to happen on IN, and needs to be before we evaluate the room middleware, as the data source designates
     * which middleware collection to evaluate.  It would be nice to move this to a middleware type somehow, but
     * RoomIF.evalMiddlware needs this setting.
     * @param req - The request
     * @param next - the next function to call.
     */
    messagePrepMiddleware(req, next) {
        log.debug('Preparing message for processing.');
        req.hdb_header = {};
        if(req.data) {
            req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE] = (req.data.__transacted === undefined ?
                types.CONNECTOR_TYPE_ENUM.CLUSTER :
                types.CONNECTOR_TYPE_ENUM.CORE);
        }
        next();
    }

    /**
     * Get and evaluate the middleware for authenticate.  Will call next middleware if all middleware passes, and swallow
     * the message if it fails.
     * @param req - the request
     * @param next - the next middleware function to call.
     * @returns {*}
     */
    evalRoomHandshakeSCMiddleware(req, next) {
        // TODO: We should be able to make this a premade middleware.
        log.trace('starting evalRoomHandshakeSCMiddleware');

        sc_utils.requestAndHandleLogin(req.socket, this.hdb_users);

        next();
    }
}
new ClusterWorker();