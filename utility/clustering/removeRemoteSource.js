'use strict';

const remove_remote_source_validator = require('../../validation/clustering/removeRemoteSourceValidator');
const hdb_logger = require('../logging/harper_logger');
const nats_terms = require('../../server/nats/utility/natsTerms');
const hdb_terms = require('../hdbTerms');
const cluster_utils = require('../../utility/clustering/clusterUtilities');
const hdb_utils = require('../common_utils');
const nats_utils = require('../../server/nats/utility/natsUtils');
const env_manager = require('../environment/environmentManager');
const UpdateRemoteResponseObject = require('./UpdateRemoteResponseObject');
const { NodeSubscription } = require('./NodeObject');
const DeleteObject = require('../../dataLayer/DeleteObject');
const _delete = require('../../dataLayer/delete');
const { broadcast } = require('../../server/threads/manageThreads');

const node_name = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = removeRemoteSource;

/**
 * Used by a "remote node" when a remove_node request is sent.
 * Will remove the source from work queue stream and delete the node record from hdb_nodes table.
 * @param req
 * @returns {Promise<UpdateRemoteResponseObject>}
 */
async function removeRemoteSource(req) {
	try {
		const validation = remove_remote_source_validator(req);
		if (validation) {
			hdb_logger.error(`Validation error in removeRemoteSource: ${validation.message}`);

			// If a validation error occurs return it to the originator node.
			return new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, validation.message);
		}

		const remote_node = req.node_name;
		let remote_node_record = await cluster_utils.getNodeRecord(remote_node);
		if (hdb_utils.isEmptyOrZeroLength(remote_node_record)) {
			const no_node_err = `No record found for node '${remoteNode}'`;
			hdb_logger.error(no_node_err);
			return new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, no_node_err);
		}

		remote_node_record = remote_node_record[0];

		// For each subscription to remote node set both publish and subscribe to false so that all streams are removed from work queue.
		for (let i = 0, sub_length = remote_node_record.subscriptions.length; i < sub_length; i++) {
			const subscription = remote_node_record.subscriptions[i];
			hdb_logger.trace(
				`remove remote source removing subscription: ${subscription.schema}.${subscription.table} for node: ${remote_node}`
			);

			const false_sub = new NodeSubscription(subscription.schema, subscription.table, false, false);
			await nats_utils.updateConsumerIterator(subscription.schema, subscription.table, remote_node, 'stop');
			await nats_utils.updateRemoteConsumer(false_sub, remote_node);
		}

		// Delete nodes record from hdb_nodes table
		const delete_qry = new DeleteObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, [
			remote_node,
		]);
		await _delete.deleteRecord(delete_qry);
		broadcast({
			type: 'nats_update',
		});

		return new UpdateRemoteResponseObject(
			nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS,
			`Node ${node_name} successfully removed node '${remoteNode}'.`
		);
	} catch (err) {
		hdb_logger.error(err);
		const err_msg = err.message ? err.message : err;

		// If an error occurs return it to the originator node.
		return new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, err_msg);
	}
}
