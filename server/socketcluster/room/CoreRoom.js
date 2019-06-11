"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const RoomMessageObjects = require('./RoomMessageObjects');
const {inspect} = require('util');
/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */
class CoreRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    publishToRoom(msg) {
        log.info(`Called publishToRoom in CoreRoom with topic: ${this.topic}.  Not defined.`);
    }

    inboundMsgHandler(req, worker, response) {
        if(!req.data || !req.data.type) {
            log.info(`Invalid request received from HDB child.`);
            log.trace(inspect(req));
            return false;
        }
        let msg_type = req.data.type;
        if(!req) {
            log.info('Invalid request sent to core room inboundMsgHandler.');
        }
        if(!worker) {
            log.info('Invalid worker sent to core room inboundMsgHandler');
        }
        switch(msg_type) {
            case types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS: {
                let get_cluster_status_msg = new RoomMessageObjects.GetClusterStatusMessage();
                get_cluster_status_msg.request_id = req.data.id;
                get_cluster_status_msg.requestor_channel = req.channel;
                get_cluster_status_msg.worker_request_owner = worker.id;
                worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM, get_cluster_status_msg);
                //return types.ERROR_CODES.WORKER_RULE_FAILURE;
                break;
            }
            default:
                log.info(`Got unrecognized core room message type ${msg_type}`);
                break;
        }
    }
}

module.exports = CoreRoom;