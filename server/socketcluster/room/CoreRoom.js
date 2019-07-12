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

// 'this' is typically stomped by the worker when invoked, so we store 'this' to make this object accessible.
let self = undefined;

/**
 * This is a room that handles messages between an HDB child and a socketcluster worker..  Rooms should not be instantiated directly, instead the room factory should be used.
 */

/**
 * In the case where we are handling multiple cluster status requests, we store an internal map with the source message id as
 * a key.  This bucket is the data structure used to track responses bby workers for each status request that is pending.
 */
class ClusterStatusBucket {
    constructor(num_expected_responses) {
        this.num_expected_responses = num_expected_responses;
        // Start at one as we assume this worker has already added its status
        this.responses_received = 1;
        this.response_msg = undefined;
    }
}

/**
 * Takes a response message from another worker and appends its connection info into the cluster status response message.
 * @param cluster_status_response_message -
 * @param response_msg
 */
function addStatusResponseValues(cluster_status_response_message, response_msg) {
    log.trace(`addStatusResponseValues`);
    try {
        if (!cluster_status_response_message) {
            log.info('Invalid object passed to addStatusResponseValues.');
            return null;
        }
        if (!response_msg) {
            log.info('Invalid msg passed to addStatusResponseValues');
            return null;
        }
        if (response_msg.inbound_connections && response_msg.inbound_connections.length > 0) {
            for (let i = 0; i < response_msg.inbound_connections.length; i++) {
                let conn = response_msg.inbound_connections[i];
                if (conn) {
                    cluster_status_response_message.inbound_connections.push(conn);
                }
            }
        }
        if (response_msg.outbound_connections && response_msg.outbound_connections.length > 0) {
            for (let i = 0; i < response_msg.outbound_connections.length; i++) {
                let conn = response_msg.outbound_connections[i];
                if (conn) {
                    cluster_status_response_message.outbound_connections.push(conn);
                }
            }
        }
        if (response_msg.bidirectional_connections && response_msg.bidirectional_connections.length > 0) {
            for (let i = 0; i < response_msg.bidirectional_connections.length; i++) {
                let conn = response_msg.bidirectional_connections[i];
                if (conn) {
                    cluster_status_response_message.bidirectional_connections.push(conn);
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

    /**
     * Publish to to channel this room represents.  The super call will assign all values in the existing_hdb_header parameter into
     * the message before it is published.
     * @param msg - The message that will be posted to the channel
     * @param worker - The worker that owns this room
     * @param existing_hdb_header - an existing hdb header which will have its keys appended to msg.
     * @returns {Promise<void>}
     */
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

    /**
     * This function is bound to the watcher for this channel.  Since it is bound, 'this' will be replaced by the binder
     * (typically the Worker).  We accept a worker as a parameter in case this function needs to be called in another
     * case.
     * @param req - The inbound request on this topic/channel
     * @param worker - The worker that owns this room.
     * @param response - a function that can be called as part of the response.
     * @returns {Promise<void>}
     */
    async inboundMsgHandler(req, worker, response) {
        if(!worker) {
            worker = this;
        }
        if(!req) {
            log.info('Invalid request sent to core room inboundMsgHandler.');
            return;
        }
        let msg_type = req.type;
        let result = undefined;
        let cluster_status_response = new RoomMessageObjects.HdbCoreClusterStatusResponseMessage();
        switch(msg_type) {
            case types.CORE_ROOM_MSG_TYPE_ENUM.GET_CLUSTER_STATUS: {
                try {
                    let get_cluster_status_msg = new RoomMessageObjects.GetClusterStatusMessage();
                    get_cluster_status_msg.requestor_channel = req.channel;
                    get_cluster_status_msg.worker_request_owner = worker.id;
                    if(worker.hdb_workers.length > 1) {
                        if(!get_cluster_status_msg.hdb_header) {
                            get_cluster_status_msg.hdb_header = {};
                            get_cluster_status_msg.hdb_header['worker_originator_id'] = worker.id;
                            get_cluster_status_msg.__originator[worker.id] = '';
                            // copy the hdb_header since we can't use publishToRoom()
                            if(req.hdb_header) {
                                let header_keys = Object.keys(req.hdb_header);
                                for(let i=0; i<header_keys.length; ++i) {
                                    if(header_keys[i] === "__originator") {
                                        continue;
                                    }
                                    get_cluster_status_msg.hdb_header[header_keys[i]] = req.hdb_header[header_keys[i]];
                                }
                            }
                        }
                        // We are posting to the hdb_workers room to get status from other workers, so we can't use this.publishToRoom.
                        worker.exchange.publish(hdb_terms.INTERNAL_SC_CHANNELS.WORKER_ROOM, get_cluster_status_msg);
                    }

                    cluster_status_response.hdb_header = req.hdb_header;
                    cluster_status_response.cluster_staatus_request_id = req.id;
                    // insert the status for this worker
                    cluster_utils.getWorkerStatus(cluster_status_response, worker);
                    let status_bucket_obj = new ClusterStatusBucket(worker.hdb_workers.length);
                    status_bucket_obj.response_msg = cluster_status_response;
                    self.cluster_status_request_buckets[get_cluster_status_msg.request_id] = status_bucket_obj;
                    if(worker.hdb_workers.length === 1) {
                        self.publishToRoom(cluster_status_response, worker, req.hdb_header);
                        result = cluster_status_response;
                        return result;
                    }
                    // create an array of all workers other than 'this' so we can use as iterable in promise.all() below.
                    let workers = [];
                    for(let i=1; i<worker.hdb_workers.length; i++) {
                        workers.push(worker.hdb_workers[i]);
                    }
                    await Promise.all(
                        workers.map(async worker => {
                            // If we have more than 1 process, we need to get the status from the master process which has that info stored
                            // in global.  We subscribe to an event that master will emit once it has gathered the data.  We want to build
                            // in a timeout in case the event never comes.
                            let timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, TIMEOUT_ERR_MSG);
                            let event_promise = socket_cluster_utils.createEventPromise(socket_cluster_status_event.EVENT_NAME, socket_cluster_status_event.socketClusterEmitter, timeout_promise);
                            let result = await Promise.race([event_promise, timeout_promise.promise]);
                            if (result === TIMEOUT_ERR_MSG) {
                                cluster_status_response.error = TIMEOUT_ERR_MSG;
                                cluster_status_response.outbound_connections = [];
                                cluster_status_response.inbound_connections = [];
                            } else {
                                let stored_bucket = self.cluster_status_request_buckets[result.originator_msg_id];
                                if(!stored_bucket) {
                                    log.error('no stored status bucket found.  Cluster status failure.');
                                    // expect this to be caught locally
                                    throw new Error(`Error recovering cluster status bucket.`);
                                }
                                stored_bucket.responses_received++;
                                addStatusResponseValues(self.cluster_status_request_buckets[result.originator_msg_id].response_msg, result);
                                if (stored_bucket.responses_received === stored_bucket.num_expected_responses) {
                                    log.info(`All workers responded to status request, responding to child.`);
                                }
                            }
                        })
                    );
                    log.trace(`Posting cluster status response message`);
                    self.publishToRoom(cluster_status_response, worker, req.hdb_header);
                } catch(err) {
                    log.error(`Cluster status error`);
                    log.error(err);
                    cluster_status_response.owning_worker_id = this.id;
                    cluster_status_response.outbound_connections = [];
                    cluster_status_response.inbound_connections = [];
                    cluster_status_response.error = "There was an error getting cluster status.";
                }
                result = cluster_status_response;
                break;
            }
            case types.CORE_ROOM_MSG_TYPE_ENUM.HDB_TRANSACTION: {
                // This is where we will send transactions to the cluster.
                log.info(`Sending transaction to cluster.`);
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