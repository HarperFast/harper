"use strict";

const WorkerIF = require('./WorkerIF');
const SCServer = require('../handlers/SCServer');
const types = require('../types');
const {promisify} = require('util');
const log = require('../../../utility/logging/harper_logger');
const NodeConnector = require('../connector/NodeConnector');
const password_utility = require('../../../utility/password');
const get_cluster_user = require('../../../utility/common_utils').getClusterUser;
const terms = require('../../../utility/hdbTerms');
const {inspect} = require('util');

let worker_subscriptions = {};

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
            next();
        } catch(err) {
            log.error(`got an error checking for rooms.`);
            log.error(err);
            return next(err);
        }
    }

    ensureRoomExists(channel) {
        if(!this.getRoom(channel)) {
            // TODO - we will need a way to distinguish from the req if this room is
            // for a core connection or a cluster connection.
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

        this.on('masterMessage', this.masterMessageHandler.bind(this));
        this.hdb_workers = [];
        this.hdb_users = {};

        this.exchange_get = promisify(this.exchange.get).bind(this.exchange);
        this.exchange_set = promisify(this.exchange.set).bind(this.exchange);
        this.exchange_remove = promisify(this.exchange.remove).bind(this.exchange);

        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.checkNewRoom.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.messagePrepMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.evalRoomPublishInMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.evalRoomPublishInRules.bind(this));

        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_HANDSHAKE_SC, this.evalRoomHandshakeSCMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_OUT, this.evalRoomPublishOutMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_OUT, this.evalRoomPublishOutRules.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_SUBSCRIBE, this.checkNewRoom.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_SUBSCRIBE, this.evalRoomSubscribeMiddleware.bind(this));
        new SCServer(this);

        this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.HDB_USERS);
        this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.HDB_WORKERS);
        if(this.isLeader){
            log.trace('Calling processArgs');
            this.processArgs().then(hdb_data=>{
                if(hdb_data && hdb_data.nodes && hdb_data.cluster_user) {
                    this.node_connector = new NodeConnector(hdb_data.nodes, hdb_data.cluster_user, this);
                }
            });
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.ADD_USER);
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.ALTER_USER);
            this.ensureRoomExists(terms.INTERNAL_SC_CHANNELS.DROP_USER);
        }
    }

    async processArgs() {
        log.trace('processArgs');
        try{
            let data = process.argv[2];
            let hdb_data = JSON.parse(data);
            if(hdb_data !== undefined) {
                await this.setHDBDatatoExchange(hdb_data);
                log.info('hdb_data successfully set to exchange');
                return hdb_data;
            }
        } catch(e){
            log.error(e);
        }
    }

    masterMessageHandler(data, respond) {
        log.trace('masterMessageHandler.');
        try {
            if (data.hdb_data !== undefined) {
                this.setHDBDatatoExchange(data.hdb_data).then(() => {
                    log.info('hdb_data successfully set to exchange');
                });
            }
            respond();
        }catch(e){
            respond(e);
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
                await this.exchange_set(terms.INTERNAL_SC_CHANNELS.HDB_USERS, users);
                await this.exchange.publish(terms.INTERNAL_SC_CHANNELS.HDB_USERS, users);
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

        req.socket.emit('login', 'send login credentials', (error, credentials)=>{
            if(error){
                console.error(error);
                return false;
            }

            if(!credentials || !credentials.username || !credentials.password){
                console.error('Invalid credentials');
                return false;
            }

            this.handleLoginResponse(req, credentials).then(()=>{
                log.info('socket successfully authenticated');
            });
        });

        next();
    }

    async handleLoginResponse(req, credentials) {
        log.trace('handleLoginResponse');
        try {
            let users = Object.values(this.hdb_users);
            let found_user = get_cluster_user(users, credentials.username);

            if (found_user === undefined || !password_utility.validate(found_user.password, credentials.password)) {
                req.socket.destroy();
                return log.error('invalid user, access denied');
            }

            //we may need to handle this scenario: https://github.com/SocketCluster/socketcluster/issues/343
            //set the JWT to expire in 1 day
            req.socket.setAuthToken({username: credentials.username}, {expiresIn: '1d'});
        } catch(e){
            log.error(e);
        }
    }
}
new ClusterWorker();