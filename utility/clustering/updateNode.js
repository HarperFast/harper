'use strict';

const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const { addUpdateNodeValidator } = require('../../validation/clustering/addUpdateNodeValidator.js');
const hdbLogger = require('../logging/harper_logger.js');
const hdbTerms = require('../hdbTerms.ts');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const hdbUtils = require('../common_utils.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const clusteringUtils = require('./clusterUtilities.js');
const envManager = require('../environment/environmentManager.js');
const { cloneDeep } = require('lodash');
const reviewSubscriptions = require('./reviewSubscriptions.js');
const { Node, NodeSubscription } = require('./NodeObject.js');
const { broadcast } = require('../../server/threads/manageThreads.js');
const { setNode: plexusSetNode } = require('../../server/replication/setNode.ts');

const UNSUCCESSFUL_MSG =
	'Unable to update subscriptions due to schema and/or tables not existing on the local or remote node';
const PART_SUCCESS_MSG =
	'Some subscriptions were unsuccessful due to schema and/or tables not existing on the local or remote node';
const localNodeName = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = updateNode;

/**
 * Updates subscriptions between nodes.
 * Also called by setNodeReplication
 * @param req - request from API. An object containing a node_name and an array of subscriptions.
 * @returns {Promise<{message: undefined, updated: [], skipped: []}>}
 */
async function updateNode(req) {
	hdbLogger.trace('updateNode called with:', req);
	if (
		envManager.get(hdbTerms.CONFIG_PARAMS.REPLICATION_URL) ??
		envManager.get(hdbTerms.CONFIG_PARAMS.REPLICATION_HOSTNAME)
	) {
		return plexusSetNode(req);
	}

	clusteringUtils.checkClusteringEnabled();
	const validation = addUpdateNodeValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const remoteNodeName = req.node_name;
	let record;
	let existingRecord = await clusteringUtils.getNodeRecord(remoteNodeName);
	if (existingRecord.length > 0) record = cloneDeep(existingRecord);

	// This function requests a describe all from remote node, from the response it will decide if it should/can create
	// schema/tables for each subscription in the request. A schema/table needs to exist on at least the local or remote node
	// to be able to be created and a subscription added.
	const { added, skipped } = await reviewSubscriptions(req.subscriptions, remoteNodeName);

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
	const remotePayload = clusteringUtils.buildNodePayloads(
		added,
		localNodeName,
		hdbTerms.OPERATIONS_ENUM.UPDATE_NODE,
		await clusteringUtils.getSystemInfo()
	);

	for (let i = 0, subLength = added.length; i < subLength; i++) {
		// The remote node reply has an array called 'successful' that contains all the subs its was able to establish.
		const sub = added[i];
		hdbLogger.trace(`updateNode updating work stream for node: ${remoteNodeName} subscription:`, sub);
		if (added[i].start_time === undefined) delete added[i].start_time;
	}

	hdbLogger.trace('updateNode sending remote payload:', remotePayload);
	let reply;
	try {
		// Send update node request to remote node.
		reply = await natsUtils.request(`${remoteNodeName}.${natsTerms.REQUEST_SUFFIX}`, remotePayload);
	} catch (reqErr) {
		hdbLogger.error(`updateNode received error from request: ${reqErr}`);
		let errorMsg = natsUtils.requestErrorHandler(reqErr, 'update_node', remoteNodeName);
		throw handleHDBError(new Error(), errorMsg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', errorMsg);
	}

	// If an error is received from the remote node abort add node and throw error
	if (reply.status === natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
		const errMsg = `Error returned from remote node ${remoteNodeName}: ${reply.message}`;
		throw handleHDBError(new Error(), errMsg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', errMsg);
	}

	hdbLogger.trace(reply);

	// The call to updateRemoteConsumer will, depending on subs, either add/remove a consumer for this node on
	// the remote node. If consumer is added, a msg iterator will be init for that consumer. Conversely, if a
	// consumer is removed, anu existing msg iterator will e stopped.
	for (let i = 0, subLength = added.length; i < subLength; i++) {
		const addedSub = added[i];
		await natsUtils.updateRemoteConsumer(addedSub, remoteNodeName);
		if (addedSub.subscribe === true) {
			await natsUtils.updateConsumerIterator(addedSub.schema, addedSub.table, remoteNodeName, 'start');
		} else {
			await natsUtils.updateConsumerIterator(addedSub.schema, addedSub.table, remoteNodeName, 'stop');
		}
	}

	if (!record) record = [new Node(remoteNodeName, [], reply.system_info)];
	await updateNodeTable(record[0], added, reply.system_info);

	if (skipped.length > 0) {
		response.message = PART_SUCCESS_MSG;
	} else {
		response.message = `Successfully updated '${remoteNodeName}'`;
	}

	return response;
}

/**
 * Takes the existing hdbNodes record and the updated subs and combines them then
 * updates the table.
 * @param existingRecord
 * @param updatedSubs
 * @param system_info
 * @returns {Promise<void>}
 */
async function updateNodeTable(existingRecord, updatedSubs, system_info) {
	let updatedRecord = existingRecord;
	for (let i = 0, subLength = updatedSubs.length; i < subLength; i++) {
		const updateSub = updatedSubs[i];

		// Search existing subs for node and update and matching one
		let matchFound = false;
		for (let j = 0, eSubLength = existingRecord.subscriptions.length; j < eSubLength; j++) {
			const existingSub = updatedRecord.subscriptions[j];
			// If there is an existing matching subscription in the hdbNodes table update it.
			if (existingSub.schema === updateSub.schema && existingSub.table === updateSub.table) {
				existingSub.publish = updateSub.publish;
				existingSub.subscribe = updateSub.subscribe;
				matchFound = true;
				break;
			}
		}

		// If no matching subscription is found add subscription to new sub array
		if (!matchFound) {
			updatedRecord.subscriptions.push(
				new NodeSubscription(updateSub.schema, updateSub.table, updateSub.publish, updateSub.subscribe)
			);
		}
	}

	updatedRecord.system_info = system_info;
	await clusteringUtils.upsertNodeRecord(updatedRecord);
	broadcast({
		type: 'nats_update',
	});
}
