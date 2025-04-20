'use strict';

const removeRemoteSourceValidator = require('../../validation/clustering/removeRemoteSourceValidator.js');
const hdbLogger = require('../logging/harper_logger.js');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const hdbTerms = require('../hdbTerms.ts');
const clusterUtils = require('../../utility/clustering/clusterUtilities.js');
const hdbUtils = require('../common_utils.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const envManager = require('../environment/environmentManager.js');
const UpdateRemoteResponseObject = require('./UpdateRemoteResponseObject.js');
const { NodeSubscription } = require('./NodeObject.js');
const DeleteObject = require('../../dataLayer/DeleteObject.js');
const _delete = require('../../dataLayer/delete.js');
const { broadcast } = require('../../server/threads/manageThreads.js');

const node_name = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = removeRemoteSource;

/**
 * Used by a "remote node" when a removeNode request is sent.
 * Will remove the source from work queue stream and delete the node record from hdbNodes table.
 * @param req
 * @returns {Promise<UpdateRemoteResponseObject>}
 */
async function removeRemoteSource(req) {
	try {
		const validation = removeRemoteSourceValidator(req);
		if (validation) {
			hdbLogger.error(`Validation error in removeRemoteSource: ${validation.message}`);

			// If a validation error occurs return it to the originator node.
			return new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, validation.message);
		}

		const remoteNode = req.node_name;
		let remoteNodeRecord = await clusterUtils.getNodeRecord(remoteNode);
		if (hdbUtils.isEmptyOrZeroLength(remoteNodeRecord)) {
			const noNodeErr = `No record found for node '${remoteNode}'`;
			hdbLogger.error(noNodeErr);
			return new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, noNodeErr);
		}

		remoteNodeRecord = remoteNodeRecord[0];

		// For each subscription to remote node set both publish and subscribe to false so that all streams are removed from work queue.
		for (let i = 0, subLength = remoteNodeRecord.subscriptions.length; i < subLength; i++) {
			const subscription = remoteNodeRecord.subscriptions[i];
			hdbLogger.trace(
				`remove remote source removing subscription: ${subscription.schema}.${subscription.table} for node: ${remoteNode}`
			);

			const falseSub = new NodeSubscription(subscription.schema, subscription.table, false, false);
			await natsUtils.updateConsumerIterator(subscription.schema, subscription.table, remoteNode, 'stop');
			await natsUtils.updateRemoteConsumer(falseSub, remoteNode);
		}

		// Delete nodes record from hdbNodes table
		const deleteQry = new DeleteObject(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, [
			remoteNode,
		]);
		await _delete.deleteRecord(deleteQry);
		broadcast({
			type: 'nats_update',
		});

		return new UpdateRemoteResponseObject(
			natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS,
			`Node ${node_name} successfully removed node '${remoteNode}'.`
		);
	} catch (err) {
		hdbLogger.error(err);
		const errMsg = err.message ? err.message : err;

		// If an error occurs return it to the originator node.
		return new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, errMsg);
	}
}
