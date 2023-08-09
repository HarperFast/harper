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
const review_subscriptions = require('./reviewSubscriptions');
const { Node, NodeSubscription } = require('./NodeObject');
const { broadcast } = require('../../server/threads/manageThreads');

const UNSUCCESSFUL_MSG =
	'Unable to create subscriptions due to schema and/or tables not existing on the local or remote node';
const PART_SUCCESS_MSG =
	'Some subscriptions were unsuccessful due to schema and/or tables not existing on the local or remote node';
const local_node_name = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = addNode;

/**
 * Adds a node to the cluster.
 * @param req - request from API. An object containing a node_name and an array of subscriptions.
 * @param skip_validation - if true will skip check for existing record. This is here to accommodate
 * upgrades to HDB 4.0.0, this upgrade had to force an addNode when record already exists in hdb nodes.
 * @returns {Promise<{added: (undefined|*), skipped}>}
 */
async function addNode(req, skip_validation = false) {
	hdb_logger.trace('addNode called with:', req);
	clustering_utils.checkClusteringEnabled();
	const validation = addUpdateNodeValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const remote_node_name = req.node_name;
	// Skip option is here to accommodate upgrades from pre 4.0.0 HDB versions.
	if (!skip_validation) {
		const record = await clustering_utils.getNodeRecord(remote_node_name);
		if (!hdb_utils.isEmptyOrZeroLength(record)) {
			throw handleHDBError(
				new Error(),
				`Node '${remote_node_name}' has already been added, perform update_node to proceed.`,
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}
	}

	// This function requests a describe all from remote node, from the response it will decide if it should/can create
	// schema/tables for each subscription in the request. A schema/table needs to exist on at least the local or remote node
	// to be able to be created and a subscription added.
	const { added, skipped } = await review_subscriptions(req.subscriptions, remote_node_name);

	const response = {
		message: undefined,
		added,
		skipped,
	};

	// If there are no subs to be added there is no point messaging remote node.
	if (added.length === 0) {
		response.message = UNSUCCESSFUL_MSG;
		return response;
	}

	// Build payload that will be sent to remote node
	const remote_payload = clustering_utils.buildNodePayloads(
		added,
		local_node_name,
		hdb_terms.OPERATIONS_ENUM.ADD_NODE,
		await clustering_utils.getSystemInfo()
	);

	hdb_logger.trace('addNode sending remote payload:', remote_payload);
	let reply;
	try {
		// Send add node request to remote node.
		reply = await nats_utils.request(`${remote_node_name}.${nats_terms.REQUEST_SUFFIX}`, remote_payload);
	} catch (req_err) {
		hdb_logger.error(`addNode received error from request: ${req_err}`);
		const error_msg = nats_utils.requestErrorHandler(req_err, 'add_node', remote_node_name);
		throw handleHDBError(new Error(), error_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', error_msg);
	}

	// If an error is received from the remote node abort add node and throw error
	if (reply.status === nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
		const err_msg = `Error returned from remote node ${remote_node_name}: ${reply.message}`;
		throw handleHDBError(new Error(), err_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', err_msg);
	}

	hdb_logger.trace(reply);

	// The request above is sent before the stream update and upsert in case an error occurs and request is rejected.
	// Update the work queue stream with the new subscriptions.
	let subs_for_record = [];
	for (let i = 0, sub_length = added.length; i < sub_length; i++) {
		const added_sub = added[i];
		hdb_logger.trace('Add node updating work stream for node:', remote_node_name, 'subscriptions:', added_sub);
		await nats_utils.updateWorkStream(added_sub, remote_node_name);
		if (added[i].start_time === undefined) delete added[i].start_time;
		subs_for_record.push(
			new NodeSubscription(added_sub.schema, added_sub.table, added_sub.publish, added_sub.subscribe)
		);
	}

	// Add new node record to hdb_nodes table.
	const node_record = new Node(remote_node_name, subs_for_record, reply.system_info);
	await clustering_utils.upsertNodeRecord(node_record);
	broadcast({
		type: 'nats_update',
	});
	if (skipped.length > 0) {
		response.message = PART_SUCCESS_MSG;
	} else {
		response.message = `Successfully added '${remote_node_name}' to manifest`;
	}

	return response;
}
