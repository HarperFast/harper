"use strict";

const WorkerIF = require('./WorkerIF');
let express = require('express');
const room_factory = require('../room/roomFactory');
const SCServer = require('../handlers/SCServer');
const types = require('../types');
const {inspect} = require('util');
const {promisify} = require('util');
const log = require('../../../utility/logging/harper_logger');

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
        try {
            if(!req || !req.channel) {
                log.error('Got an invalid request.');
                return next('Got an invalid request.');
            }
            if(!this.getRoom(req.channel)) {
                // TODO - we will need a way to distinguish from the req if this room is
                // for a core connection or a cluster connection.
                let newRoom = room_factory.createRoom(req.channel, types.ROOM_TYPE.STANDARD);
                this.addRoom(newRoom);
                next();
            } else {
                next();
            }
        } catch(err) {
            log.error(`got an error checking for rooms.`);
            log.error(err);
            return next(err);
        }
    }

    /**
     * Run this worker.
     */
    run() {
        console.log('Running ClusterWorker');
        log.debug('Cluster Worker starting up.');
        let app = express();
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.checkNewRoom.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.messagePrepMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.evalRoomPublishInMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_IN, this.evalRoomRules.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_HANDSHAKE_SC, this.evalRoomHandshakeSCMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_PUBLISH_OUT, this.evalRoomPublishOutMiddleware.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_SUBSCRIBE, this.checkNewRoom.bind(this));
        this.scServer.addMiddleware(this.scServer.MIDDLEWARE_SUBSCRIBE, this.evalRoomSubscribeMiddleware.bind(this));
        let sc_server = new SCServer(this);

        this.hdb_workers = [];
        this.transaction_map = {};

        this.exchange_get = promisify(this.exchange.get).bind(this.exchange);
        this.exchange_set = promisify(this.exchange.set).bind(this.exchange);
    }


    /**
     * Evaluate room rules via the decision matrix.  Since middleware always has the same parameter, we can't
     * make this a middlewareIF object, as the rules generally need the worker.
     *
     * This should always be called at the end of the middleware chain for a connector.
     * @param req - The request
     * @param next - The next function that should be called if this is successful.
     */
    // TODO: Can middleware be async?
    async evalRoomRules(req, next) {
        if(!req.hdb_header) {
            return next(types.ERROR_CODES.MIDDLEWARE_SWALLOW);
        }

        // get the room
        let room = this.getRoom(req.channel);
        if(!room) {
            return next(types.ERROR_CODES.MIDDLEWARE_ERROR);
        }
        // eval rules
        let rules_result = undefined;
        try {
            let connector_type = types.CONNECTOR_TYPE_ENUM.CORE;
            if(req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE]) {
                connector_type = req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE];
            }
            rules_result = await room.evalRules(req, this, connector_type);
        } catch(err) {
            log.error(err);
            return next(types.ERROR_CODES.WORKER_RULE_ERROR);
        }
        if(!rules_result) {
            return next(types.ERROR_CODES.WORKER_RULE_FAILURE);
        }
        next();
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
}
new ClusterWorker();