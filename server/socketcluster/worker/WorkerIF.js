"use strict";
const RoomIF = require('../room/RoomIF');
const SCWorker = require('socketcluster/scworker');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');
const password_utility = require('../../../utility/password');

/**
 * This is a super class that is used to represent some kind of worker clustering will use for message passing.  Since Javascript doesn't have enforceable interfaces,
 * this is used as more of a super class.  Any subclasses will need to implement the functions described here.
 */
class WorkerIF extends SCWorker{
    constructor() {
        super();
        this.rooms = {};
        //throw new Error('Should not instantiate Interface.');
        // TODO: rooms list.
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

    /**
     * Get and evaluate the middleware for authenticate.  Will call next middleware if all middleware passes, and swallow
     * the message if it fails.
     * @param req - the request
     * @param next - the next middleware function to call.
     * @returns {*}
     */
    evalRoomHandshakeSCMiddleware(req, next) {
        // TODO: We should be able to make this a premade middleware.
        console.log('sc shaking hands');

        req.socket.emit('login', 'send login credentials', (error, credentials)=>{
            if(error){
                return console.error(error);
            }

            if(!credentials || !credentials.username || !credentials.password){
                return console.error('Invalid credentials');
            }

            this.exchange.get('hdb_users', (err, users)=>{
                let found_user = undefined;
                users.forEach(user=>{
                    if(user.username === credentials.username && user.role.role === 'super_user' && password_utility.validate(user.password, credentials.password)){
                        found_user = user;
                    }
                });

                if(found_user === undefined) {
                    req.socket.destroy();
                    return log.error('invalid credentials, access denied');
                }

                //we may need to handle this scenario: https://github.com/SocketCluster/socketcluster/issues/343
                req.socket.setAuthToken({username: credentials.username}, {expiresIn: '1d'});

            });
        });

        next();
    }

    run() {
        throw new Error('Not Implemented.');
    }
}

module.exports = WorkerIF;
