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
        log.info(`Worker: ${this.id} subscribed to topic: ${roomIF_object.topic}`);
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
        this.evalRoomRules(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT)
            .then((result) => {
                if(result) {
                    return next(result);
                }
                return next();
            })
            .catch((err) => {
                return next(types.ERROR_CODES.MIDDLEWARE_ERROR);
            });
    }

    /**
     * Evaluate the room rules for middleware type PUBLISH_IN
     * @param req - The request
     * @param next - next function to call;
     */
    evalRoomPublishInRules(req, next) {
        this.evalRoomRules(req, next, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN)
            .then((result) => {
                if(result) {
                    return next(result);
                }
                return next();
            })
            .catch((err) => {
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
        if(!req.hdb_header) {
            return types.ERROR_CODES.MIDDLEWARE_SWALLOW;
        }

        // get the room
        let room = this.getRoom(req.channel);
        if(!room) {
            return types.ERROR_CODES.MIDDLEWARE_ERROR;
        }
        // eval rules

        try {
            let connector_type = types.CONNECTOR_TYPE_ENUM.CORE;
            if(req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE]) {
                connector_type = req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE];
            }
            room.evalRules(req, this, connector_type, middleware_type).then(rules_result=>{
                if(!rules_result) {
                    return types.ERROR_CODES.WORKER_RULE_FAILURE;
                }
                //next();
                return;
            });
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
