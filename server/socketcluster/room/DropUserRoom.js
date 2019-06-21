"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const {inspect} = require('util');

/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */

// 'this' is typically stomped by the worker when invoked, so we store 'this' to make this object accessible.
let self = undefined;
class DropUserRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
        self = this;
    }

    async publishToRoom(msg, worker, existing_hdb_header) {
        super.publishToRoom(msg, worker, existing_hdb_header);
    }

    async inboundMsgHandler(req, worker, response) {
        log.trace('DropUser handler');
        if(!worker) {
            worker = this;
        }
        if(!req) {
            return;
        }
        if(!req || !req.data || !req.data.user) {
            log.info('User not found in alter user request');
            return;
        }
        let user = req.data.user;
        try {
            if (worker.hdb_users[user.username] !== undefined) {
                delete worker.hdb_users[user.username];

                let set_result = await worker.exchange_set(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, worker.hdb_users);
                worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, worker.hdb_users);
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = DropUserRoom;