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
class AddUserRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    async publishToRoom(msg) {

    }

    async inboundMsgHandler(req, worker) {
        let user = req.data;
        log.trace('AlterUser handler');
        try {
            let current_user = worker.hdb_users[user.username];
            if (current_user !== undefined) {
                Object.keys(user).forEach((attribute)=>{
                    current_user[attribute] = user[attribute];
                });

                worker.hdb_users[user.username] = current_user;

                let set_result = await worker.exchange_set(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, worker.hdb_users);
                worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS, worker.hdb_users);
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = AddUserRoom;