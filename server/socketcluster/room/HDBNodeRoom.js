"use strict";

const RoomIF = require('./RoomIF');
const log = require('../../../utility/logging/harper_logger');
/**
 * This is a room that handles messages on the hdb_internal:hdb_node channel.  Rooms should not be instantiated directly, instead the room factory should be used.
 */

// 'this' is typically stomped by the worker when invoked, so we store 'this' to make this object accessible.
let self = undefined;
class HDBNodeRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
        self = this;
    }

    /**
     * This function is bound to the watcher for this channel.  Since it is bound, 'this' will be replaced by the binder
     * (typically the Worker).  We accept a worker as a parameter in case this function needs to be called in another
     * case.
     * @param req - The inbound request on this topic/channel
     * @param worker - The worker that owns this room.
     * @param response - a function that can be called as part of the response.
     * @returns {Promise<void>}
     */
    inboundMsgHandler(req, worker, response) {
        log.info('Got node update message.');
    }
}

module.exports = HDBNodeRoom;