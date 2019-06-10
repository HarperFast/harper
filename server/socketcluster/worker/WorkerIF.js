"use strict";

let SCWorker = require('socketcluster/scworker');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
const room_factory = require('../room/roomFactory');

/**
 * This is a super class that is used to represent some kind of worker clustering will use for message passing.  Since Javascript doesn't have enforceable interfaces,
 * this is used as more of a super class.  Any subclasses will need to implement the functions described here.
 */
class WorkerIF extends SCWorker{
    constructor() {
        super();
        this.rooms = {};
        this.subscriptions = [];
    }

    /**
     * Decides which room to create based on the topic name.
     * @param topic_name_string
     */
    createRoom(topic_name_string) {
        if(!topic_name_string) {
            log.debug(`Invalid topic name sent to create room.`);
            return;
        }
        let created_room = undefined;
        try {
            switch (topic_name_string) {
                case terms.INTERNAL_SC_CHANNELS.WORKER_ROOM: {
                    created_room = room_factory.createRoom(topic_name_string, types.ROOM_TYPE.WORKER_ROOM);
                    break;
                }

                default:
                    // default to a standard room.
                    created_room = room_factory.createRoom(topic_name_string, types.ROOM_TYPE.STANDARD);
                    break;
            }
        } catch(err) {
            log.error('There was an error creating a new SC room.');
            log.error(err);
        }
        return created_room;
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

    addSubscription(subscription_if_object) {
        if(!subscription_if_object) {
            log.info('Got invalid subscription handler in addSubscription.');
            return;
        }
        for(let i=0; i<this.subscriptions.length; i++) {
            if(this.subscriptions.topic === subscription_if_object.topic) {
                log.info(`subscription ${subscription_if_object.topic} has already been added`);
                return;
            }
        }
        this.subscriptions.push(subscription_if_object);
        this.exchange.subscribe(terms.INTERNAL_SC_CHANNELS.ADD_USER);
        if(subscription_if_object.handler !== undefined && subscription_if_object.handler !== {}) {
            this.exchange.watch(terms.INTERNAL_SC_CHANNELS.ADD_USER, subscription_if_object.handler);
        }
        log.info(`Worker: ${this.id} subscribed to topic: ${subscription_if_object.topic}`);
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
     * Get and evaluate the middleware for PublishIn.  Will call next middleware if all middleware passes, and swallow
     * the message if it fails.
     * @param req - the request
     * @param next - the next middleware function to call.
     * @returns {*}
     */
    evalRoomPublishInMiddleware(req, next) {
        log.trace(`evaluating room publish in middleware`);
        let result = this.evalRoomMiddleware(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
        if(!result) {
            return next();
        }
        // TODO: There was a problem in the middleware, parse the returned ERROR_CODE and log appropriately.
        log.info(`There was a failure in middleware.`);
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
        log.trace(`evaluating room publish out middleware`);
        let result = this.evalRoomMiddleware(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT);
        if(!result) {
            return next();
        }
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
