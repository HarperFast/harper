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
class WorkerRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    publishToRoom(msg, msg_type_enum, worker) {
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
            switch(req.data.type) {
                case types.WORKER_ROOM_MSG_TYPE_ENUM.STATUS: {
                    let num_workers = 1;
                    let responses_recieved = 0;
                    let response = this.buildRoomMsg('temp', types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE);
                    //this.publishToRoom(response, types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE, this);
                    worker.exchange.publish(req.channel, response);
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