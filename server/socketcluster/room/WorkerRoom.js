"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const {inspect} = require('util');
const RoomMessageObjects = require('./RoomMessageObjects');
const socket_cluster_status_event = require('../../../events/SocketClusterStatusEmitter');

/**
 * This is a room that handles communication between socketcluster workers.  Rooms should not be instantiated directly, instead the room factory should be used.
 */

// 'this' is typically stomped by the worker when inboundMsgHandler is invoked, so we store 'this' to make this object accessible.
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

    inboundMsgHandler(req, worker, response) {
        log.trace('Evaluating message in WorkerRoom inboundMsgHandler');
        if(!worker) {
            worker = this;
        }
        if(!req) {
            return;
        }
        try {
            switch(req.type) {
                // The worker room got a 'GET_CLUSTER_STATUS message, if this worker isn't the requestor, respond.
                case types.WORKER_ROOM_MSG_TYPE_ENUM.GET_STATUS: {
                    // 'this' worker sent this message, ignore it.
                    if(req.worker_request_owner === worker.id) {
                        return;
                    }
                    let response = new RoomMessageObjects.GetClusterStatusMessage();
                    response.worker_request_owner_id = this.id;
                    response.originator_msg_id = req.request_id;
                    self.publishToRoom(response, worker, req.hdb_header);
                    break;
                }
                case types.CORE_ROOM_MSG_TYPE_ENUM.CLUSTER_STATUS_RESPONSE: {
                    if(!req) {
                        log.trace(`Got an invalid CLUSTER_STATUS_RESPONSE message.`);
                    }
                    socket_cluster_status_event.socketClusterEmitter.emit(socket_cluster_status_event.EVENT_NAME, req);
                    break;
                }
                default:
                    log.info('Got worker room message with invalid type.');
                    break;
            }
        } catch(e) {
            log.error(e);
        }
    }
}

module.exports = WorkerRoom;