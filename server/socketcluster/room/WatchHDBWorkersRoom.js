"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const log = require('../../../utility/logging/harper_logger');

/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */
class WatchHDBWorkersRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    publishToRoom(msg) {

    }

    inboundMsgHandler(req, worker, response) {
        log.trace('WatchWorkers Room handler');
        if(!req) {
            return;
        }
        try {
            if(req.data && req.data.workers && Array.isArray(req.data.workers)) {
                worker.hdb_workers = req.data.workers;
            } else {
                worker.hdb_workers = [];
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = WatchHDBWorkersRoom;