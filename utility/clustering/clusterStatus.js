'use strict';

const cluster_utils = require('./clusterUtilities');
const nats_utils = require('../../server/nats/utility/natsUtils');
const env_mgr = require('../environment/environmentManager');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const hdb_utils = require('../common_utils');
const hdb_logger = require('../logging/harper_logger');
const { RemotePayloadObject } = require('./RemotePayloadObject');
const { ErrorCode } = require('nats');

const clustering_enabled = env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED);
const this_node_name = env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = clusterStatus;

/**
 * Function will msg all the remote nodes in the hdb_nodes table. From the replies
 * it gets back from each node and the details in the hdb_nodes table it will
 * generate a status object. All the status objects are pushed to an array and returned.
 * @returns {Promise<{is_enabled: *, node_name: *, connections: *[]}>}
 */
async function clusterStatus() {
	const response = {
		node_name: this_node_name,
		is_enabled: clustering_enabled,
		connections: [],
	};

	// If clustering is not enabled return response with empty connections.
	if (!clustering_enabled) return response;

	// If clustering is enabled but there are no records in the hdb_nodes table, return response with empty connections.
	const all_node_records = await cluster_utils.getAllNodeRecords();
	if (hdb_utils.isEmptyOrZeroLength(all_node_records)) return response;

	// For all the records in the hdb_nodes table build a status for each one.
	// Each call to buildNodeStatus is pushed to a promises array so that we can utilize
	// Promise.allSettled which runs all the promises in parallel.
	let promises = [];
	for (let i = 0, rec_length = all_node_records.length; i < rec_length; i++) {
		promises.push(buildNodeStatus(all_node_records[i], response.connections));
	}

	await Promise.allSettled(promises);

	return response;
}

async function buildNodeStatus(node_record, connections) {
	const remote_node_name = node_record.name;
	const remote_payload = new RemotePayloadObject(hdb_terms.OPERATIONS_ENUM.CLUSTER_STATUS, this_node_name, undefined);
	let reply;
	let elapsed_time;
	let status = nats_terms.CLUSTER_STATUS_STATUSES.OPEN;
	try {
		const start_time = Date.now();
		reply = await nats_utils.request(nats_terms.REQUEST_SUBJECT(remote_node_name), remote_payload);
		elapsed_time = Date.now() - start_time;

		// If an error occurs any value that we rely on from the remote node will be set to undefined.
		// If the remote node replies with an error, set status to closed and log error.
		if (reply.status === nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
			status = nats_terms.CLUSTER_STATUS_STATUSES.CLOSED;
			hdb_logger.error(`Error getting node status from ${remote_node_name} ${hdb_utils.stringifyObj(reply)}`);
		}
	} catch (err) {
		// If the request to the remote node fails set status accordingly and log error.
		hdb_logger.error(`Error getting node status from ${remote_node_name} ${hdb_utils.stringifyObj(err)}`);
		if (err.code === ErrorCode.NoResponders) status = nats_terms.CLUSTER_STATUS_STATUSES.NO_RESPONDERS;
		else if (err.code === ErrorCode.Timeout) status = nats_terms.CLUSTER_STATUS_STATUSES.TIMEOUT;
		else status = nats_terms.CLUSTER_STATUS_STATUSES.CLOSED;
	}

	const node_status = new NodeStatusObject(
		remote_node_name,
		status,
		reply?.message?.ports?.clustering,
		reply?.message?.ports?.operations_api,
		elapsed_time,
		reply?.message?.uptime,
		node_record.subscriptions
	);

	connections.push(node_status);
}

/**
 * Constructs an object that will be used as the complete status of one remote node.
 * @param node_name
 * @param status
 * @param port_clustering
 * @param port_operations_api
 * @param latency
 * @param uptime
 * @param subs
 * @constructor
 */
function NodeStatusObject(node_name, status, port_clustering, port_operations_api, latency, uptime, subs) {
	this.node_name = node_name;
	this.status = status;
	this.ports = {
		clustering: port_clustering,
		operations_api: port_operations_api,
	};
	this.latency_ms = latency;
	this.uptime = uptime;
	this.subscriptions = subs;
}
