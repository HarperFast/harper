'use strict';

const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const remove_node_validator = require('../../validation/clustering/removeNodeValidator');
const hdb_logger = require('../logging/harper_logger');
const clustering_utils = require('./clusterUtilities');
const hdb_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const nats_utils = require('../../server/nats/utility/natsUtils');
const env_manager = require('../environment/environmentManager');
const { RemotePayloadObject } = require('./RemotePayloadObject');
const { NodeSubscription } = require('./NodeObject');
const DeleteObject = require('../../data_layer/DeleteObject');
const _delete = require('../../data_layer/delete');

const node_name = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = removeNode;

/**
 * Removes a node from the cluster.
 * @param req - request from API. An object with the node_name.
 * @returns {Promise<string>}
 */
async function removeNode(req) {
	hdb_logger.trace('removeNode called with:', req);
	clustering_utils.checkClusteringEnabled();
	const validation = remove_node_validator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const remote_node_name = req.node_name;
	let record = await clustering_utils.getNodeRecord(remote_node_name);
	if (hdb_utils.isEmptyOrZeroLength(record)) {
		throw handleHDBError(
			new Error(),
			`Node '${remote_node_name}' was not found.`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	record = record[0];
	const remote_payload = new RemotePayloadObject(hdb_terms.OPERATIONS_ENUM.REMOVE_NODE, node_name, []);
	let reply;
	try {
		// Send remove node request to remote node.
		reply = await nats_utils.request(`${remote_node_name}.${nats_terms.REQUEST_SUFFIX}`, remote_payload);
	} catch (req_err) {
		hdb_logger.error(`removeNode received error from request: ${req_err}`);
		const error_msg = nats_utils.requestErrorHandler(req_err, 'remove_node', remote_node_name);
		throw handleHDBError(new Error(), error_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', error_msg);
	}

	// If an error is received from the remote node abort remove node and throw error
	if (reply.status === nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
		const err_msg = `Error returned from remote node ${remote_node_name}: ${reply.message}`;
		throw handleHDBError(new Error(), err_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', err_msg);
	}
	hdb_logger.trace(reply.message);

	// The request above is sent before any local changes in case an error occurs and the remote node rejects the request.
	for (let i = 0, sub_length = record.subscriptions.length; i < sub_length; i++) {
		const subscription = record.subscriptions[i];
		hdb_logger.trace(
			`Remove node removing subscription: ${subscription.schema}.${subscription.table} for node: ${remote_node_name}`
		);

		// Get the schema/table from the sub but set both publish and subscribe to false so that all streams are removed from work queue.
		const false_sub = new NodeSubscription(subscription.schema, subscription.table, false, false);
		await nats_utils.updateWorkStream(false_sub, remote_node_name);
	}

	// Delete nodes record from hdb_nodes table
	const delete_qry = new DeleteObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, [
		remote_node_name,
	]);
	await _delete.deleteRecord(delete_qry);

	return `Successfully removed '${remote_node_name}' from manifest`;
}
