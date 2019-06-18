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
class WatchHDBWorkersRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
        self = this;
    }

    publishToRoom(msg, worker, existing_hdb_header) {
        super.publishToRoom(msg, worker, existing_hdb_header);
    }

    inboundMsgHandler(req, worker, response) {
        log.trace('WatchWorkers Room handler');
        if(!worker) {
            worker = this;
        }
        if(!req) {
            return;
        }
        try {
            if(req && Array.isArray(req.data)) {
                for(let i=0; i<req.data.length; i++) {
                    if(!worker.hdb_workers.includes(req.data[i])) {
                        worker.hdb_workers.push(req.data[i]);
                    }
                }
            } else {
                worker.hdb_workers = [];
            }
        }catch(e){
            log.error(e);
        }
    }
}

module.exports = WatchHDBWorkersRoom;