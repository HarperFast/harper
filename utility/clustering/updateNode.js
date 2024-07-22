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
const { cloneDeep } = require('lodash');
const review_subscriptions = require('./reviewSubscriptions');
const { Node, NodeSubscription } = require('./NodeObject');
const { broadcast } = require('../../server/threads/manageThreads');
const { setNode: plexus_set_node } = require('../../server/replication/setNode');

const UNSUCCESSFUL_MSG =
	'Unable to update subscriptions due to schema and/or tables not existing on the local or remote node';
const PART_SUCCESS_MSG =
	'Some subscriptions were unsuccessful due to schema and/or tables not existing on the local or remote node';
const local_node_name = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = updateNode;

/**
 * Updates subscriptions between nodes.
 * Also called by set_node_replication
 * @param req - request from API. An object containing a node_name and an array of subscriptions.
 * @returns {Promise<{message: undefined, updated: [], skipped: []}>}
 */
async function updateNode(req) {
	hdb_logger.trace('updateNode called with:', req);
	if (
		env_manager.get(hdb_terms.CONFIG_PARAMS.REPLICATION_URL) ??
		env_manager.get(hdb_terms.CONFIG_PARAMS.REPLICATION_HOSTNAME)
	) {
		return plexus_set_node(req);
	}

	clustering_utils.checkClusteringEnabled();
	const validation = addUpdateNodeValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const remote_node_name = req.node_name;
	let record;
	let existing_record = await clustering_utils.getNodeRecord(remote_node_name);
	if (existing_record.length > 0) record = cloneDeep(existing_record);

	// This function requests a describe all from remote node, from the response it will decide if it should/can create
	// schema/tables for each subscription in the request. A schema/table needs to exist on at least the local or remote node
	// to be able to be created and a subscription added.
	const { added, skipped } = await review_subscriptions(req.subscriptions, remote_node_name);

	const response = {
		message: undefined,
		updated: added,
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
		hdb_terms.OPERATIONS_ENUM.UPDATE_NODE,
		await clustering_utils.getSystemInfo()
	);

	for (let i = 0, sub_length = added.length; i < sub_length; i++) {
		// The remote node reply has an array called 'successful' that contains all the subs its was able to establish.
		const sub = added[i];
		hdb_logger.trace(`updateNode updating work stream for node: ${remote_node_name} subscription:`, sub);
		if (added[i].start_time === undefined) delete added[i].start_time;
	}

	hdb_logger.trace('updateNode sending remote payload:', remote_payload);
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

	hdb_logger.trace(reply);

	// The call to updateRemoteConsumer will, depending on subs, either add/remove a consumer for this node on
	// the remote node. If consumer is added, a msg iterator will be init for that consumer. Conversely, if a
	// consumer is removed, anu existing msg iterator will e stopped.
	for (let i = 0, sub_length = added.length; i < sub_length; i++) {
		const added_sub = added[i];
		await nats_utils.updateRemoteConsumer(added_sub, remote_node_name);
		if (added_sub.subscribe === true) {
			await nats_utils.updateConsumerIterator(added_sub.schema, added_sub.table, remote_node_name, 'start');
		} else {
			await nats_utils.updateConsumerIterator(added_sub.schema, added_sub.table, remote_node_name, 'stop');
		}
	}

	if (!record) record = [new Node(remote_node_name, [], reply.system_info)];
	await updateNodeTable(record[0], added, reply.system_info);

	if (skipped.length > 0) {
		response.message = PART_SUCCESS_MSG;
	} else {
		response.message = `Successfully updated '${remote_node_name}'`;
	}

	return response;
}

/**
 * Takes the existing hdb_nodes record and the updated subs and combines them then
 * updates the table.
 * @param existing_record
 * @param updated_subs
 * @param system_info
 * @returns {Promise<void>}
 */
async function updateNodeTable(existing_record, updated_subs, system_info) {
	let updated_record = existing_record;
	for (let i = 0, sub_length = updated_subs.length; i < sub_length; i++) {
		const update_sub = updated_subs[i];

		// Search existing subs for node and update and matching one
		let match_found = false;
		for (let j = 0, e_sub_length = existing_record.subscriptions.length; j < e_sub_length; j++) {
			const existing_sub = updated_record.subscriptions[j];
			// If there is an existing matching subscription in the hdb_nodes table update it.
			if (existing_sub.schema === update_sub.schema && existing_sub.table === update_sub.table) {
				existing_sub.publish = update_sub.publish;
				existing_sub.subscribe = update_sub.subscribe;
				match_found = true;
				break;
			}
		}

		// If no matching subscription is found add subscription to new sub array
		if (!match_found) {
			updated_record.subscriptions.push(
				new NodeSubscription(update_sub.schema, update_sub.table, update_sub.publish, update_sub.subscribe)
			);
		}
	}

	updated_record.system_info = system_info;
	await clustering_utils.upsertNodeRecord(updated_record);
	broadcast({
		type: 'nats_update',
	});
}
