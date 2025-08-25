'use strict';

const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const removeNodeValidator = require('../../validation/clustering/removeNodeValidator.js');
const hdbLogger = require('../logging/harper_logger.js');
const clusteringUtils = require('./clusterUtilities.js');
const hdbUtils = require('../common_utils.js');
const hdbTerms = require('../hdbTerms.ts');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const envManager = require('../environment/environmentManager.js');
const { RemotePayloadObject } = require('./RemotePayloadObject.js');
const { NodeSubscription } = require('./NodeObject.js');
const DeleteObject = require('../../dataLayer/DeleteObject.js');
const _delete = require('../../dataLayer/delete.js');
const { broadcast } = require('../../server/threads/manageThreads.js');
const { setNode: plexusSetNode } = require('../../server/replication/setNode.ts');

const node_name = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = removeNode;

/**
 * Removes a node from the cluster.
 * @param req - request from API. An object with the node_name.
 * @returns {Promise<string>}
 */
async function removeNode(req) {
	hdbLogger.trace('removeNode called with:', req);
	if (
		envManager.get(hdbTerms.CONFIG_PARAMS.REPLICATION_URL) ??
		envManager.get(hdbTerms.CONFIG_PARAMS.REPLICATION_HOSTNAME)
	) {
		return plexusSetNode(req);
	}

	clusteringUtils.checkClusteringEnabled();
	const validation = removeNodeValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const remoteNodeName = req.node_name;
	let record = await clusteringUtils.getNodeRecord(remoteNodeName);
	if (hdbUtils.isEmptyOrZeroLength(record)) {
		throw handleHDBError(
			new Error(),
			`Node '${remoteNodeName}' was not found.`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	record = record[0];
	const remotePayload = new RemotePayloadObject(hdbTerms.OPERATIONS_ENUM.REMOVE_NODE, node_name, []);
	let reply;
	let remoteNodeError = false;

	for (let i = 0, subLength = record.subscriptions.length; i < subLength; i++) {
		const subscription = record.subscriptions[i];
		if (subscription.subscribe === true) {
			await natsUtils.updateConsumerIterator(subscription.schema, subscription.table, remoteNodeName, 'stop');
		}

		try {
			await natsUtils.updateRemoteConsumer(
				new NodeSubscription(subscription.schema, subscription.table, false, false),
				remoteNodeName
			);
		} catch (err) {
			// Not throwing err so that if remote node is unreachable it doesn't stop it from being removed from this node
			hdbLogger.error(err);
		}
	}

	try {
		// Send remove node request to remote node.
		reply = await natsUtils.request(`${remoteNodeName}.${natsTerms.REQUEST_SUFFIX}`, remotePayload);
		hdbLogger.trace('Remove node reply from remote node:', remoteNodeName, reply);
	} catch (reqErr) {
		hdbLogger.error('removeNode received error from request:', reqErr);
		remoteNodeError = true;
	}

	// Delete nodes record from hdbNodes table
	const deleteQry = new DeleteObject(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, [
		remoteNodeName,
	]);
	await _delete.deleteRecord(deleteQry);

	broadcast({
		type: 'nats_update',
	});
	// If an error is received from the remote node let user know.
	if (reply?.status === natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR || remoteNodeError) {
		hdbLogger.error('Error returned from remote node:', remoteNodeName, reply?.message);
		return `Successfully removed '${remoteNodeName}' from local manifest, however there was an error reaching remote node. Check the logs for more details.`;
	}

	return `Successfully removed '${remoteNodeName}' from manifest`;
}
