"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');
const {inspect} = require('util');

/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */
class WorkerRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    publishToRoom(msg) {

    }

    inboundMsgHandler(input, response) {
        try {
            log.trace('WorkerRoomSubscriptionHandler handler');
            console.log('Handling Room message: ' + inspect(input));
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = WorkerRoom;