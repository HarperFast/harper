"use strict";

const RoomIF = require('./RoomIF');
const types = require('../types');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const RoomMessageObjects = require('./RoomMessageObjects');
const hdb_utils = require('../../../utility/common_utils');
const socket_cluster_utils = require('../util/socketClusterUtils');
const cluster_utils = require('../util/socketClusterUtils');
const socket_cluster_status_event = require('../../../events/SocketClusterStatusEmitter');

const {inspect} = require('util');

const STATUS_TIMEOUT_MS = 10000;
const TIMEOUT_ERR_MSG = 'Timeout trying to get cluster status.';
const STATUS_BUCKET_ATTRIBUTE_NAME = 'status_bucket';
let self = undefined;
/**
 * This is a standard room that represents a socketcluster channel, as well as the middleware for that channel, and
 * worker rules for that channel.  Rooms should never be instantiated directly, instead the room factory should be used.
 */

class ClusterStatusBucket {
    constructor(num_expected_responses) {
        this.num_expected_responses = num_expected_responses;
        // Start at one as we assume this worker has already added its status
        this.responses_received = 1;
    }
}

// If we have more than 1 process, we need to get the status from the master process which has that info stored
// in global.  We subscribe to an event that master will emit once it has gathered the data.  We want to build
// in a timeout in case the event never comes.
function addStatusResponseValues(status_obj, response_msg) {
    try {
        if (!status_obj) {
            throw new Error('Invalid object passed to addStatusResponseValues.');
        }
        if (!response_msg) {
            throw new Error('Invalid msg passed to addStatusResponsevalues');
        }
        //status_obj.inbound_connections
        if (response_msg.data.inbound_connections && response_msg.data.inbound_connections.length > 0) {
            for (let i = 0; i < response_msg.data.inbound_connections.length; i++) {
                let conn = response_msg.data.inbound_connections[i];
                if (conn) {
                    status_obj.data.inbound_connections.push(conn);
                }
            }
        }
        if (response_msg.data.outbound_connections && response_msg.data.outbound_connections.length > 0) {
            for (let i = 0; i < response_msg.data.outbound_connections.length; i++) {
                let conn = response_msg.data.outbound_connections[i];
                if (conn) {
                    status_obj.data.outbound_connections.push(conn);
                }
            }
        }
        if (response_msg.data.bidirectional_connections && response_msg.data.bidirectional_connections.length > 0) {
            for (let i = 0; i < response_msg.data.bidirectional_connections.length; i++) {
                let conn = response_msg.data.bidirectional_connections[i];
                if (conn) {
                    status_obj.data.bidirectional_connections.push(conn);
                }
            }
        }
    } catch(err) {
        log.error(`Error adding status values`);
        throw err;
    }
}

class CoreRoom extends RoomIF {
    constructor(new_topic_string) {
        super();
        this.setTopic(new_topic_string);
        this.cluster_status_request_buckets = {};
        self = this;

    }

    publishToRoom(msg, worker, existing_hdb_header) {
        try {
            super.publishToRoom(msg, worker, existing_hdb_header);
            log.info(`Called publishToRoom in CoreRoom with topic: ${self.topic}.`);
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
        if(!req.data) {
            return;
        }
        let msg_type = req.data.type;
        if(!req) {
            log.info('Invalid request sent to core room inboundMsgHandler.');
        }
        if(!worker) {
            log.info('Invalid worker sent to core room inboundMsgHandler');
        }
        let result = undefined;
        let cluster_status_response = new RoomMessageObjects.HdbCoreClusterStatusResponseMessage();
        switch(msg_type) {
            case types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS: {
                try {
                    let get_cluster_status_msg = new RoomMessageObjects.GetClusterStatusMessage();
                    get_cluster_status_msg.data.requestor_channel = req.channel;
                    get_cluster_status_msg.data.worker_request_owner = worker.id;
                    if(worker.hdb_workers.length > 1) {
                        // We are posting to the hdb_workers room to get status from other workers, so we can't use this.publishToRoom.
                        if(!get_cluster_status_msg.hdb_header) {
                            get_cluster_status_msg.hdb_header = {};
                            get_cluster_status_msg.hdb_header['worker_originator_id'] = worker.id;
                            get_cluster_status_msg.data.__originator = worker.id;
                            if(req.hdb_header) {
                                let header_keys = Object.keys(req.hdb_header);
                                for(let i=0; i<header_keys.length; ++i) {
                                    get_cluster_status_msg.hdb_header[header_keys[i]] = req.hdb_header[header_keys[i]];
                                }
                            }
                        }
                        worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM, get_cluster_status_msg);
                    }

                    let status_bucket_obj = new ClusterStatusBucket(worker.hdb_workers.length);
                    self.cluster_status_request_buckets[get_cluster_status_msg.data.request_id] = status_bucket_obj;
                    cluster_status_response.data.hdb_header = req.data.hdb_header;
                    cluster_status_response.data.cluster_staatus_request_id = req.data.id;
                    // insert the status for this worker
                    cluster_utils.getWorkerStatus(cluster_status_response, worker);
                    if(worker.hdb_workers.length === 1) {
                        self.publishToRoom(cluster_status_response, worker, req.hdb_header);
                        result = cluster_status_response;
                        return result;
                    }
                    // create an array of all workers other than this one so we can use as iterable in promise.all() below.
                    let workers = [];
                    for(let i=1; i<worker.hdb_workers.length; i++) {
                        workers.push(worker.hdb_workers[i]);
                    }
                    await Promise.all(
                        workers.map(async worker => {
                            let timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, TIMEOUT_ERR_MSG);
                            let event_promise = socket_cluster_utils.createEventPromise(socket_cluster_status_event.EVENT_NAME, socket_cluster_status_event.clusterEmitter, timeout_promise);
                            let result = await Promise.race([event_promise, timeout_promise.promise]);
                            if (result === TIMEOUT_ERR_MSG) {
                                cluster_status_response.data.error = TIMEOUT_ERR_MSG;
                                cluster_status_response.data.outbound_connections = [];
                                cluster_status_response.data.inbound_connections = [];
                            } else {
                                let stored_bucket = self.cluster_status_request_buckets[result.data.cluster_status_request_id];
                                if(!stored_bucket) {
                                    log.error('no stored status bucket found.  Cluster status failure.');
                                    // expect this to be caught locally
                                    throw new Error(`Error recovering cluster status bucket.`);
                                }
                                stored_bucket.responses_received++;
                                addStatusResponseValues(cluster_status_response, result);
                                if (stored_bucket.responses_received === stored_bucket.num_expected_responses) {
                                    log.info(`All workers responded to status request, responding to child.`);
                                }
                            }
                        })
                    );
                } catch(err) {
                    log.error(`Cluster status error`);
                    log.error(err);
                    cluster_status_response.data.owning_worker_id = this.id;
                    cluster_status_response.data.outbound_connections = [];
                    cluster_status_response.data.inbound_connections = [];
                    cluster_status_response.data.error = "There was an error getting cluster status.";
                }
                log.info(`Posting cluster status response message`);
                try {
                    self.publishToRoom(cluster_status_response, worker, req.hdb_header);
                } catch(err) {
                    // we will try again to publish, if we fail again just exit.
                    log.error(`Got an exception publishing to room ${this.topic}.`);
                    log.error(err);
                    return;
                }
                result = cluster_status_response;
                break;
            }
            default:
                log.info(`Got unrecognized core room message type ${msg_type}`);
                break;
        }
        return result;
    }
}

module.exports = CoreRoom;