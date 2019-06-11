"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */
class UsersRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    publishToRoom(msg) {

    }

    inboundMsgHandler(users, response) {
        try {
            log.trace('WatchUserSubscriptionHandler handler');
            if(users && typeof users === 'object') {
                this.hdb_users = users;
            } else {
                this.hdb_users = {};
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = UsersRoom;