"use strict";

let SCWorker = require('socketcluster/scworker');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
const room_factory = require('../room/roomFactory');
const WorkerObjects = require('./WorkerObjects');
const env = require('../../../utility/environment/environmentManager');

/**
 * This is a super class that is used to represent some kind of worker clustering will use for message passing.  Since Javascript doesn't have enforceable interfaces,
 * this is used as more of a super class.  Any subclasses will need to implement the functions described here.
 */
class WorkerIF extends SCWorker{
    constructor() {
        super();
        this.rooms = {};
        this.subscriptions = {};
    }

    /**
     * Decides which room to create based on the topic name.
     * @param topic_name_string
     */
    createRoom(topic_name_string) {
        log.trace('Creating Room');
        if(!topic_name_string) {
            log.debug(`Invalid topic name sent to create room.`);
            return;
        }
        let created_room = undefined;
        try {
            created_room = room_factory.createRoom(topic_name_string);
        } catch(err) {
            log.error('There was an error creating a new SC room.');
            log.error(err);
    }
        return created_room;
    }

    /**
     * Subscribe and watch the specified topic.
     * @param topic
     */
    addSubscription(topic) {
        try {
            if (!topic) {
                log.info('Got invalid subscription handler in addSubscription.');
                return;
            }
            let sub_keys = Object.keys(this.subscriptions);
            for (let i = 0; i < sub_keys.length; i++) {
                let sub_topic = this.subscriptions[sub_keys[i]];
                if (sub_topic.name === topic) {
                    log.info(`subscription ${topic} has already been added`);
                    return;
                }
            }
            this.subscriptions[topic] = new WorkerObjects.SubscriptionDefinition(topic, true, true);
            this.exchange.subscribe(topic);
            let room = this.getRoom(topic);
            if(!room) {
                log.info('No room found.');
                return;
             }
            this.exchange.watch(topic, this.rooms[topic].inboundMsgHandler.bind(this));
            log.info(`Worker: ${this.pid} subscribed to topic: ${topic}`);
        } catch(err) {
            log.error(`Got an error subscribing to topic: ${topic}`);
            log.error(err);
        }
    }


    /**
     * Add a room to a worker.  Throws an exception if a room already exists.
     * @param roomIF_object - a RoomIF subclass.
     * @throws
     */
    addRoom(roomIF_object) {
        log.trace(`Adding room ${roomIF_object.topic}`);
        if (!roomIF_object || !roomIF_object.topic) {
            throw new Error(`Invalid parameter passed to addRoom`);
        }
        if (this.rooms[roomIF_object.topic] !== undefined) {
            throw new Error(`Room: ${roomIF_object.topic} already exists.`);
        }
        this.rooms[roomIF_object.topic] = roomIF_object;
        this.addSubscription(roomIF_object.topic);
    }

    /**
     * Gets the room that represents the topic.
     * @param topic_name_string - Topic
     * @returns {null|*}
     */
    getRoom(topic_name_string) {
        log.trace(`trying to get room ${topic_name_string}`);
        if(this.rooms[topic_name_string] !== undefined) {
            return this.rooms[topic_name_string];
        }
        return null;
    }

    /**
     * Evaluates the middleware for the room that represents the channel topic.
     * @param req - the inbound request.
     * @param next -
     * @param middleware_type_enum
     * @returns {boolean|*}
     */
    evalRoomMiddleware(req, next, middleware_type_enum) {
        log.trace(`evaluating room middleware`);
        let room = this.getRoom(req.channel);
        if(!room) {
            // we should never get here if this is being properly called from
            // checkNewroomMiddleware
            log.error('No valid room was found in evalMiddleware.');
            return types.ERROR_CODES.MIDDLEWARE_ERROR;
        }
        return room.evalMiddleware(req,next,middleware_type_enum);
    }

    /**
     * Evaluate the room rules for middleware type PUBLISH_OUT
     * @param req - The request
     * @param next - next function to call;
     */
    evalRoomPublishOutRules(req, next) {
        log.trace(`****evaluating room publish out rules on message type: ${req.type}****`);
        this.evalRoomRules(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT)
            .then((result) => {
                if(result) {
                    log.trace(`****issue in room publish out rules****`);
                    return next(result);
                }
                log.trace(`****pass room publish out rules****`);
                return next();
            })
            .catch((err) => {
                log.trace(`****exception in room publish out rules****`);
                log.info(err);
                return next(types.ERROR_CODES.MIDDLEWARE_ERROR);
            });
    }

    /**
     * Evaluate the room rules for middleware type PUBLISH_IN
     * @param req - The request
     * @param next - next function to call;
     */
    evalRoomPublishInRules(req, next) {
        log.trace(`****evaluating room publish in rules on message type: ${req.type}****`);
        this.evalRoomRules(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN)
            .then((result) => {
                if(result) {
                    log.trace(`****issue in room publish in rules****`);
                    return next(result);
                }
                log.trace(`****pass room publish in rules****`);
                return next();
            })
            .catch((err) => {
                log.trace(`****exception in room publish in rules****`);
                log.info(err);
                return next(types.ERROR_CODES.MIDDLEWARE_ERROR);
            });
    }

    /**
     * Evaluate room rules via the decision matrix.  Since middleware always has the same parameter, we can't
     * make this a middlewareIF object, as the rules generally need the worker.
     *
     * This should always be called at the end of the middleware chain for a connector.
     * @param req - The request
     * @param next - The next function that should be called if this is successful.
     */
    async evalRoomRules(req, next, middleware_type) {
        if(req.data.data) {
            let data_keys = Object.keys(req.data.data);
            for(let i=0; i<data_keys.length; i++) {
                if(data_keys[i] === 'data') {
                    continue;
                }
                req.data[data_keys[i]] = req.data.data[data_keys[i]];
            }
        }
        if(!req.hdb_header && !req.data.hdb_header) {
            log.trace('failed hdb_header check');
            return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
        }

        let room = this.getRoom(req.channel);
        if(!room) {
            log.trace('failed rules room check');
            return types.ERROR_CODES.MIDDLEWARE_ERROR;
        }

        // eval rules
        try {
            let connector_type = types.CONNECTOR_TYPE_ENUM.CORE;
            if(req.hdb_header && req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE]) {
                connector_type = req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE];
            } else if(req.data.hdb_header && req.data.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE]) {
                connector_type = req.data.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE];
            }
            let rules_result = await room.evalRules(req, this, connector_type, middleware_type);
            if(!rules_result) {
                return types.ERROR_CODES.WORKER_RULE_FAILURE;
            }
            return;
        } catch(err) {
            log.error(err);
            return types.ERROR_CODES.WORKER_RULE_ERROR;
        }
    }

    /**
     * Get and evaluate the middleware for PublishIn.  Will call next middleware if all middleware passes, and swallow
     * the message if it fails.
     * @param req - the request
     * @param next - the next middleware function to call.
     * @returns {*}
     */
    evalRoomPublishInMiddleware(req, next) {
        log.debug(`____evaluating room publish in middleware on message type: ${req.type}____`);
        let result = this.evalRoomMiddleware(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
        if(!result) {
            log.trace(`____passed all publish in middleware____`);
            return next();
        }
        // TODO: There was a problem in the middleware, parse the returned ERROR_CODE and log appropriately.
        log.info(`There was a failure in middleware.`);
        log.debug(`____finished evaluating room publish in middleware____`);
        return next(`There was a middleware failure. ${result}`);
    }

    /**
     * Get and evaluate the middleware for publishOut.  Will call next middleware if all middleware passes, and swallow
     * the message if it fails.
     * @param req - the request
     * @param next - the next middleware function to call.
     * @returns {*}
     */
    evalRoomPublishOutMiddleware(req, next) {
        log.debug(`____evaluating room publish out middleware on message type: ${req.type}____`);
        let result = this.evalRoomMiddleware(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT);
        if(!result) {
            log.trace(`____passed all publish out middleware____`);
            return next();
        }
        log.debug(`____finished evaluating room publish out middleware____`);
        // There was a problem in the middleware, parse the returned ERROR_CODE and log appropriately.
        log.info(`There was a failure in middleware.`);
        return next(`There was a middleware failure. ${result}`);
    }

    /**
     * Get and evaluate the middleware for subscribe.  Will call next middleware if all middleware passes, and swallow
     * the message if it fails.
     * @param req - the request
     * @param next - the next middleware function to call.
     * @returns {*}
     */
    evalRoomSubscribeMiddleware(req, next) {
        log.trace(`evaluating room subscribe middleware`);
        let result = this.evalRoomMiddleware(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE);
        if(!result) {
            return next();
        }
        // There was a problem in the middleware, parse the returned ERROR_CODE and log appropriately.
        log.info(`There was a failure in middleware.`);
        return next(`There was a middleware failure. ${result}`);
    }

    /**
     * Get and evaluate the middleware for authenticate.  Will call next middleware if all middleware passes, and swallow
     * the message if it fails.
     * @param req - the request
     * @param next - the next middleware function to call.
     * @returns {*}
     */
    evalRoomAuthenticateMiddleware(req, next) {
        log.trace(`evaluating room authenticate middleware`);
        let result = this.evalRoomMiddleware(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE);
        if(!result) {
            return next();
        }
        // There was a problem in the middleware, parse the returned ERROR_CODE and log appropriately.
        log.info(`There was a failure in middleware.`);
        return next(`There was a middleware failure. ${result}`);
    }

    run() {
        throw new Error('Not Implemented.');
    }
}

module.exports = WorkerIF;
