"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const {inspect} = require('util');
const RoomMessageObjects = require('./RoomMessageObjects');

/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */

// 'this' is typically stomped by the worker when invoked, so we store 'this' to make this object accessible.
let self = undefined;
class AddUserRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
        self = this;
    }

    async publishToRoom(msg, worker, existing_hdb_header) {
        super.publishToRoom(msg, worker, existing_hdb_header);
    }

    async inboundMsgHandler(req, worker, response) {
        if(!worker) {
            worker = this;
        }
        if(!req) {
            return;
        }
        let user = req.user;
        if(!user) {
            log.info('User not found in alter user request');
            return;
        }
        log.trace('AlterUser handler');
        try {
            let current_user = worker.hdb_users[user.username];
            if (current_user !== undefined) {
                Object.keys(user).forEach((attribute)=>{
                    current_user[attribute] = user[attribute];
                });

                worker.hdb_users[user.username] = current_user;
                let hdb_users_msg = new RoomMessageObjects.SyncHdbUsersMessage();
                hdb_users_msg.users = worker.hdb_users;
                let set_result = await worker.exchange_set(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, worker.hdb_users);
                worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, hdb_users_msg);
            }
        } catch(e) {
            log.error(e);
        }
    }
}

module.exports = AddUserRoom;