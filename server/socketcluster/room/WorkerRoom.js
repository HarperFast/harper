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
class WorkerRoom extends RoomIF {

    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
        self = this;
    }

    publishToRoom(msg, worker, existing_hdb_header) {
        super.publishToRoom(msg, worker, existing_hdb_header);
        worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM, msg);
    }

    buildRoomMsg(msg, worker_room_msg_type_enum) {
        if(!msg) {
            log.info('Invalid message sent to buildRoomMsg');
            return null;
        }
        if(!worker_room_msg_type_enum) {
            log.info('Invalid message type sent to buildRoomMsg');
            return null;
        }
        let built_msg = undefined;
        switch(worker_room_msg_type_enum) {
                // Note this is another types's value (CORE_ROOM_MSG_TYPE_ENUM), This worker may need to construct a message
                // that will be sent to an HDB child
            case types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE: {
                built_msg = new RoomMessageObjects.GetClusterStatusMessage();
                built_msg.worker_request_owner_id = this.id;
                break;
            }
            case types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS_RESPONSE: {
                built_msg = new RoomMessageObjects.WorkerStatusMessage();
                built_msg.owning_worker_id = this.id;
                built_msg.inbound_connections = ['Im a connection'].
                break;
            }
        }
        return built_msg;
    }

    inboundMsgHandler(req, worker, response) {
        if(!worker) {
            worker = this;
        }
        if(!req) {
            return;
        }
        let requesting_channel = req.channel;
        try {
            switch(req.type) {
                case types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS: {
                    // 'this' worker sent this message, ignore it.
                    if(req.worker_request_owner === this.id) {
                        return;
                    }
                    let num_workers = 1;
                    let responses_recieved = 0;
                    let response = self.buildRoomMsg('temp', types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE);
                    self.publishToRoom(response, this, req.hdb_header);
                    //worker.exchange.publish(req.channel, response);
                    // Get self cluster status

                    // If workers > 1, post message to worker room

                    // Wait for responses

                    //Collate responses

                    //Respond to HDBChild.
                    break;
                }
            }

        } catch(e) {
            log.error(e);
        }
    }
}

module.exports = WorkerRoom;