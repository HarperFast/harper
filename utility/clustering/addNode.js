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
const reviewSubscriptions = require('./reviewSubscriptions.js');
const { Node, NodeSubscription } = require('./NodeObject.js');
const { broadcast } = require('../../server/threads/manageThreads.js');
const { setNode: plexusSetNode } = require('../../server/replication/setNode.ts');
const envMgr = require('../environment/environmentManager.js');
const terms = require('../hdbTerms.ts');

const UNSUCCESSFUL_MSG =
	'Unable to create subscriptions due to schema and/or tables not existing on the local or remote node';
const PART_SUCCESS_MSG =
	'Some subscriptions were unsuccessful due to schema and/or tables not existing on the local or remote node';
const localNodeName = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = addNode;

/**
 * Adds a node to the cluster.
 * @param req - request from API. An object containing a node_name and an array of subscriptions.
 * @param skipValidation - if true will skip check for existing record. This is here to accommodate
 * upgrades to HDB 4.0.0, this upgrade had to force an addNode when record already exists in hdb nodes.
 * @returns {Promise<{added: (undefined|*), skipped}>}
 */
async function addNode(req, skipValidation = false) {
	hdbLogger.trace('addNode called with:', req);
	if (
		envManager.get(hdbTerms.CONFIG_PARAMS.REPLICATION_URL) ||
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
	// Skip option is here to accommodate upgrades from pre 4.0.0 HDB versions.
	if (!skipValidation) {
		const record = await clusteringUtils.getNodeRecord(remoteNodeName);
		if (!hdbUtils.isEmptyOrZeroLength(record)) {
			throw handleHDBError(
				new Error(),
				`Node '${remoteNodeName}' has already been added, perform update_node to proceed.`,
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
	const { added, skipped } = await reviewSubscriptions(req.subscriptions, remoteNodeName);

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
	const remotePayload = clusteringUtils.buildNodePayloads(
		added,
		localNodeName,
		hdbTerms.OPERATIONS_ENUM.ADD_NODE,
		await clusteringUtils.getSystemInfo()
	);

	let subsForRecord = [];
	for (let i = 0, subLength = added.length; i < subLength; i++) {
		const addedSub = added[i];
		if (added[i].start_time === undefined) delete added[i].start_time;
		subsForRecord.push(
			new NodeSubscription(addedSub.schema, addedSub.table, addedSub.publish, addedSub.subscribe)
		);
	}

	hdbLogger.trace('addNode sending remote payload:', remotePayload);
	let reply;
	try {
		// Send add node request to remote node.
		reply = await natsUtils.request(`${remoteNodeName}.${natsTerms.REQUEST_SUFFIX}`, remotePayload);
	} catch (reqErr) {
		hdbLogger.error(`addNode received error from request: ${reqErr}`);

		// If an error occurs during the request to remote node, undo any consumers that might have been added on tihs node
		for (let i = 0, subLength = added.length; i < subLength; i++) {
			const addedSub = added[i];
			addedSub.publish = false;
			addedSub.subscribe = false;
			await natsUtils.updateRemoteConsumer(addedSub, remoteNodeName);
		}

		const errorMsg = natsUtils.requestErrorHandler(reqErr, 'add_node', remoteNodeName);
		throw handleHDBError(new Error(), errorMsg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', errorMsg);
	}

	// If an error is received from the remote node abort add node and throw error
	if (reply.status === natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
		const errMsg = `Error returned from remote node ${remoteNodeName}: ${reply.message}`;
		throw handleHDBError(new Error(), errMsg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', errMsg);
	}

	hdbLogger.trace(reply);

	// If this node is subscribed to the other node we create a consumer on the other node
	// and then init a msg iterator on this node for the newly created consumer.
	for (let i = 0, subLength = added.length; i < subLength; i++) {
		const addedSub = added[i];
		await natsUtils.updateRemoteConsumer(addedSub, remoteNodeName);
		if (addedSub.subscribe === true) {
			await natsUtils.updateConsumerIterator(addedSub.schema, addedSub.table, remoteNodeName, 'start');
		}
	}

	// Add new node record to hdbNodes table.
	const nodeRecord = new Node(remoteNodeName, subsForRecord, reply.system_info);
	await clusteringUtils.upsertNodeRecord(nodeRecord);
	broadcast({
		type: 'nats_update',
	});
	if (skipped.length > 0) {
		response.message = PART_SUCCESS_MSG;
	} else {
		response.message = `Successfully added '${remoteNodeName}' to manifest`;
	}

	return response;
}
