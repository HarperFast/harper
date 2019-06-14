"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const RoomMessageObjects = require('./RoomMessageObjects');
const hdb_utils = require('../../../utility/common_utils');
const cluster_utils = require('../util/clusterUtils');
const cluster_status_event = require('../../../events/ClusterStatusEmitter');

const {inspect} = require('util');

const STATUS_TIMEOUT_MS = 4000000;
const TIMEOUT_ERR_MSG = 'Timeout trying to get cluster status.';
let self = undefined;
/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */

class ClusterStatusBucket {
    constructor(request_id, num_expected_responses) {
        this.orig_request_id = request_id;
        this.num_expected_responses = num_expected_responses;
        this.responses_received = 1;
        self = this;
    }
}


// If we have more than 1 process, we need to get the status from the master process which has that info stored
// in global.  We subscribe to an event that master will emit once it has gathered the data.  We want to build
// in a timeout in case the event never comes.
const timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, TIMEOUT_ERR_MSG);
const event_promise = new Promise((resolve) => {
    cluster_status_event.clusterEmitter.on(cluster_status_event.EVENT_NAME, (msg) => {
        log.info(`Got cluster status event response: ${inspect(msg)}`);
        //if(msg.originator_msg_id === )
        //this.addStatusResponseValues(new RoomMessageObjects.HdbCoreClusterStatusResponseMessage(), msg);
        try {
            timeout_promise.cancel();
        } catch(err) {
            log.error('Error trying to cancel timeout.');
        }
        resolve(msg);
    });
});

class CoreRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
    }

    publishToRoom(msg, worker, existing_hdb_header) {
        self.super(msg, worker, existing_hdb_header);
        try {
            log.info(`Called publishToRoom in CoreRoom with topic: ${self.topic}.  Not defined.`);
            worker.exchange.publish(self.topic, msg);
        } catch(err) {
            log.error(`Error publishing to channel ${self.topic}.`);
            log.error(err);
            return;
        }
    }

    async inboundMsgHandler(req, worker, response) {
        if(!worker) {
            worker = this;
        }
        if(!req) {
            return;
        }

        let msg_type = req.type;
        if(!req) {
            log.info('Invalid request sent to core room inboundMsgHandler.');
        }
        if(!worker) {
            log.info('Invalid worker sent to core room inboundMsgHandler');
        }
        switch(msg_type) {
            case types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS: {
                try {
                    let get_cluster_status_msg = new RoomMessageObjects.GetClusterStatusMessage();
                    get_cluster_status_msg.request_id = req.data.id;
                    get_cluster_status_msg.requestor_channel = req.channel;
                    get_cluster_status_msg.worker_request_owner = worker.id;
                    get_cluster_status_msg.hdb_header = req.hdb_header;
                    worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM, get_cluster_status_msg);

                    let status_bucket_obj = new ClusterStatusBucket(req.data.id, worker.hdb_workers.length);
                    let cluster_status_response = new RoomMessageObjects.HdbCoreClusterStatusResponseMessage();
                    cluster_status_response.hdb_header = req.hdb_header;
                    // insert the status for this worker
                    cluster_utils.getWorkerStatus(cluster_status_response, worker);
                    if(worker.hdb_workers.length === 1) {
                        self.publishToRoom(cluster_status_response, worker, req.hdb_header);
                        return;
                    }
                    // Wait for cluster status event to fire then respond to client
                    let result = await Promise.race([event_promise, timeout_promise.promise]);
                    if (result === TIMEOUT_ERR_MSG) {
                        cluster_status_response.error = TIMEOUT_ERR_MSG;
                        self.publishToRoom(cluster_status_response, worker, req.hdb_header);
                    } else {
                        status_bucket_obj.responses_received++;
                        self.addStatusResponseValues(cluster_status_response, result);
                        if (status_bucket_obj.responses_received === status_bucket_obj.num_expected_responses) {
                            self.publishToRoom(cluster_status_response, worker, req.hdb_header);
                        }
                    }
                } catch(err) {
                    self.publishToRoom({"error": "There was an error getting cluster status.", type: hdb_terms.CLUSTERING_MESSAGE_TYPES.CLUSTER_STATUS_RESPONSE}, worker, req.hdb_header);
                }
                break;
            }
            default:
                log.info(`Got unrecognized core room message type ${msg_type}`);
                break;
        }
    }

    addStatusResponseValues(status_obj, response_msg) {
        if(!status_obj) {
            throw new Error('Invalid object passed to addStatusResponseValues.');
        }
        if(!response_msg) {
            throw new Error('Invalid msg passed to addStatusResponsevalues');
        }
        //status_obj.inbound_connections
        if(response_msg.inbound_connections && response_msg.inbound_connections.length > 0) {
            for(let i=0; i<response_msg.inbound_connections.length; i++) {
                let conn = response_msg.inbound_connections[i];
                if(conn) {
                    status_obj.inbound_connections.push(conn);
                }
            }
        }
        if(response_msg.outbound_connections && response_msg.outbound_connections.length > 0) {
            for(let i=0; i<response_msg.outbound_connections.length; i++) {
                let conn = response_msg.outbound_connections[i];
                if(conn) {
                    status_obj.outbound_connections.push(conn);
                }
            }
        }
        if(response_msg.bidirectional_connections && response_msg.bidirectional_connections.length > 0) {
            for(let i=0; i<response_msg.bidirectional_connections.length; i++) {
                let conn = response_msg.bidirectional_connections[i];
                if(conn) {
                    status_obj.bidirectional_connections.push(conn);
                }
            }
        }
    }
}

module.exports = CoreRoom;