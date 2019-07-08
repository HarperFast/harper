"use strict";

const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const {inspect} = require('util');
const CatchUp = require('../handlers/CatchUp');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const hdb_queue_path = env.getHdbBasePath() + '/clustering/transaction_log/';

class ConnectionDetails {
    constructor(id, host_address, host_port, state) {
        this.id = id;
        this.host_address = host_address;
        this.host_port = host_port;
        this.state = state;
        this.node_name = undefined;
        this.subscriptions = [];
    }
}

/**
 * Gets the status from the worker parameter and crams it into the status response message parameter.
 * @param status_response_msg - A status response message that will have the status added to.
 * @param worker - the worker to get status from.
 * @returns null
 */
function getWorkerStatus(status_response_msg, worker) {
    log.trace(`getWorkerStatus`);
    try {
        if (worker.node_connector && worker.node_connector.connections && worker.node_connector.connections.clients) {
            let client_keys = Object.keys(worker.node_connector.connections.clients);
            for (let i = 0; i < client_keys.length; i++) {
                let client = worker.node_connector.connections.clients[client_keys[i]];
                let conn = new ConnectionDetails('', client.options.hostname, client.options.port, client.state);
                if (client.additional_info) {
                    conn['subscriptions'] = [];
                    conn.node_name = client.additional_info.name;
                    for (let i = 0; i < client.additional_info.subscriptions.length; i++) {
                        let sub = client.additional_info.subscriptions[i];
                        if (sub.channel.indexOf(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) === 0) {
                            continue;
                        }
                        conn.subscriptions.push(sub);
                    }
                }
                status_response_msg.outbound_connections.push(conn);
            }
        }
        if (worker.scServer && worker.scServer.clients) {
            let client_keys = Object.keys(worker.scServer.clients);
            for (let i = 0; i < client_keys.length; i++) {
                let client = worker.scServer.clients[client_keys[i]];//worker.scServer.clients[i];
                let conn = new ConnectionDetails(client.id, client.remoteAddress, client.remotePort, client.state);
                if (client.exchange && client.exchange._channels) {
                    let channel_keys = Object.keys(client.exchange._channels);
                    for (let i = 0; i < channel_keys.length; i++) {
                        let sub = client.exchange._channels[channel_keys[i]];
                        if (sub.name.indexOf(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) === 0) {
                            continue;
                        }
                        conn.subscriptions.push({"channel": sub.name, "state": sub.state});
                    }
                }
                status_response_msg.inbound_connections.push(conn);
            }
        }
    } catch(err) {
        log.error(`There was an error getting worker status.`);
        log.error(err);
    }
}

/**
 * Creates a promise around an expected event and a timeout around that event.  If the event happens, the timeout will be
 * cancelled.  If it times out, we still send a resolve with the timeout message.
 * @param event_name - The name of the event we expect to get
 * @param event_emitter_object - The EventEmitter object to listen for the event on.
 * @param timeout_promise - A timeout promise object, which can be constructed with a function in common_utils.js.
 * @returns {Promise<any>}
 */
function createEventPromise(event_name, event_emitter_object, timeout_promise) {
    let event_promise = new Promise((resolve) => {
        event_emitter_object.on(event_name, (msg) => {
            let curr_timeout_promise = timeout_promise;
            //timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, TIMEOUT_ERR_MSG);
            log.info(`Got cluster status event response: ${inspect(msg)}`);
            try {
                curr_timeout_promise.cancel();
            } catch(err) {
                log.error('Error trying to cancel timeout.');
            }
            resolve(msg);
        });
    });
    return event_promise;
}

/**
 * Calls the Catchup class to read a specific transaction log with a time range.
 * Creates a catchup payload based on the results from Catchup and publishes to a socket
 * @param channel
 * @param start_timestamp
 * @param end_timestamp
 * @param socket
 * @returns {Promise<void>}
 */
async function catchupHandler(channel, start_timestamp, end_timestamp, socket){
    let catchup = new CatchUp(hdb_queue_path + channel, start_timestamp, end_timestamp);
    await catchup.run();

    if(Array.isArray(catchup.results) && catchup.results.length > 0) {
        let catchup_response = {
            channel: channel,
            operation:'catchup',
            transactions: catchup.results
        };

        socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catchup_response);
    }
}

module.exports = {
    getWorkerStatus,
    createEventPromise,
    catchupHandler
};