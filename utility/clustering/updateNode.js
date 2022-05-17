'use strict';

const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const { addUpdateNodeValidator } = require('../../validation/clustering/addUpdateNodeValidator');
const hdb_logger = require('../logging/harper_logger');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const hdb_utils = require('../common_utils');
const nats_utils = require('../../server/nats/utility/natsUtils');
const clustering_utils = require('./clusterUtilities');
const env_manager = require('../environment/environmentManager');

const local_node_name = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = updateNode;

/**
 * Updates subscriptions between nodes
 * @param req - request from API. An object containing a node_name and an array of subscriptions.
 * @returns {Promise<string>}
 */
async function updateNode(req) {
	hdb_logger.trace(`updateNode called with ${JSON.stringify(req)}`);
	clustering_utils.checkClusteringEnabled();
	const validation = addUpdateNodeValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const remote_node_name = req.node_name;
	const record = await clustering_utils.getNodeRecord(remote_node_name);
	if (hdb_utils.isEmptyOrZeroLength(record)) {
		throw handleHDBError(
			new Error(),
			`Node '${remote_node_name}' has not been added, perform add_node to proceed.`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	// Sanitize the input from API and build two objects, one that will be used to update hdb_nodes table
	// the other that will be sent to the remote node. The remote node subscriptions have the reverse of the the local node subs.
	const { node_record, remote_payload } = clustering_utils.buildNodePayloads(
		req.subscriptions,
		local_node_name,
		remote_node_name,
		hdb_terms.OPERATIONS_ENUM.UPDATE_NODE,
		record[0].subscriptions
	);

	// Create local streams for all the tables in the subscriptions array.
	// This needs to happen before any streams are added to the work queue on either nodes.
	// If the stream has already been created nothing will happen.
	await nats_utils.createTableStreams(req.subscriptions);

	hdb_logger.trace(`updateNode sending remote payload: ${JSON.stringify(remote_payload)}`);
	let reply;
	try {
		// Send update node request to remote node.
		reply = await nats_utils.request(`${remote_node_name}.${nats_terms.REQUEST_SUFFIX}`, remote_payload);
	} catch (req_err) {
		hdb_logger.error(`updateNode received error from request: ${req_err}`);
		let error_msg = nats_utils.requestErrorHandler(req_err, 'update_node', remote_node_name);
		throw handleHDBError(new Error(), error_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', error_msg);
	}

	// If an error is received from the remote node abort add node and throw error
	if (reply.status === nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
		const err_msg = `Error returned from remote node ${remote_node_name}: ${reply.message}`;
		throw handleHDBError(new Error(), err_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', err_msg);
	}

	hdb_logger.trace(reply.message);

	// The request above is sent before the stream update and upsert in case an error occurs and request is rejected.
	// Update the work queue stream with the new subscriptions.
	for (let i = 0, sub_length = req.subscriptions.length; i < sub_length; i++) {
		hdb_logger.trace(
			`update node updating work stream for node: ${remote_node_name} subscription: ${JSON.stringify(
				req.subscriptions[i]
			)}`
		);
		await nats_utils.updateWorkStream(req.subscriptions[i], remote_node_name);
	}

	// Update record in hdb_nodes table.
	await clustering_utils.upsertNodeRecord(node_record);

	return `Successfully updated '${remote_node_name}'`;
}
