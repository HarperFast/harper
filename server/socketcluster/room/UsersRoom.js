"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */

// 'this' is typically stomped by the worker when invoked, so we store 'this' to make this object accessible.
let self = undefined;
class UsersRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
        self = this;
    }

    publishToRoom(msg, worker, existing_hdb_header) {
        super.publishToRoom(msg, worker, existing_hdb_header);
    }

    inboundMsgHandler(req, worker, response) {
        if(!worker) {
            worker = this;
        }
        if(!req) {
            return;
        }
        if(!req.data || !req.data.users) {
            log.info('Invalid users in request.');
            return;
        }
        try {
            log.trace('WatchUsers handler');
            if(req.data.users && typeof req.data.users === 'object' && !Array.isArray(req.data.users)) {
                worker.hdb_users = req.data.users;
            } else {
                worker.hdb_users = {};
            }
        } catch(e) {
            log.error(e);
        }
    }
}

module.exports = UsersRoom;