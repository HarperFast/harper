'use strict';

const hdb_terms = require('../../utility/hdbTerms');
const hdb_utils = require('../../utility/common_utils');
const cluster_utils = require('../../utility/clustering/clusterUtilities');
const hdb_log = require('../../utility/logging/harper_logger');
const cluster_status = require('../../utility/clustering/clusterStatus');
const add_node = require('../../utility/clustering/addNode');
const pm2_utils = require('../../utility/pm2/utilityFunctions');
const global_schema = require('../../utility/globalSchema');
const remove_node = require('../../utility/clustering/removeNode');
const semver_gte = require('semver/functions/gte');

const REQUEST_STATUS_INTERVAL = 30000;
const UPDATE_NODE_ALLOWANCE_DAYS = 7;

module.exports = updateAllNodes;

/**
 * This module is launched as a forked process when clustering is started and there are still pre 4.0.0 node records in hdb_nodes.
 * It is responsible for re-adding nodes which was required when we switched over to Nats for 4.0.0.
 * @returns {Promise<void>}
 */
async function updateAllNodes() {
	try {
		hdb_log.notify(
			'Starting update nodes. This process will attempt to update any node connections the need to be reestablished after a 4.0.0 upgrade'
		);

		await global_schema.setSchemaDataToGlobalAsync();
		const nodes = await cluster_utils.getAllNodeRecords();
		let update_node_func_calls = [];

		// For any nodes that are on a pre 4.0.0 version (3.x.x) push to promise array that will call update on them.
		for (let i = 0, rec_length = nodes.length; i < rec_length; i++) {
			const node = nodes[i];
			if (node.system_info.hdb_version === hdb_terms.PRE_4_0_0_VERSION) update_node_func_calls.push(updateNode(node));
		}

		await Promise.allSettled(update_node_func_calls);
		hdb_log.notify('Shutting down 4.0.0 clustering upgrade process');
		await pm2_utils.deleteProcess(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_UPGRADE_4_0_0);
	} catch (err) {
		hdb_log.error(err);
		throw err;
	}
}

/**
 * Will keep trying to get the status of a remote node for a set amount of time.
 * If an 'open' status is received from remote node it will call add node on that node.
 * If open status is not received it will eventually delete node from hdb_nodes.
 * @param node
 * @returns {Promise<void>}
 */
async function updateNode(node) {
	try {
		const { name, subscriptions } = node;
		hdb_log.notify('Running 4.0.0 update on node:', name);

		let success = false;
		let diff_in_days = 0;
		while (diff_in_days < UPDATE_NODE_ALLOWANCE_DAYS) {
			let status = [];
			await cluster_status.buildNodeStatus(node, status);
			hdb_log.trace('Received status:', status[0].status, 'from node:', name);

			// If the remote node has been updated and is running with correct config stop calling status and call add node.
			if (status[0].status === 'open' && semver_gte(status[0].system_info.hdb_version, '4.0.0')) {
				hdb_log.notify('Received open status from node:', name, 'calling add node');
				const add_node_req = {
					operation: hdb_terms.OPERATIONS_ENUM.ADD_NODE,
					node_name: name,
					subscriptions,
				};
				await add_node(add_node_req, true);
				hdb_log.notify('Successfully added node', name);
				success = true;
				break;
			}

			diff_in_days = (Date.now() - node['__updatedtime__']) / (1000 * 60 * 60 * 24);
			hdb_log.trace(
				'Update node has been running for',
				diff_in_days,
				'days. Calling node status again for node:',
				name
			);
			await hdb_utils.async_set_timeout(REQUEST_STATUS_INTERVAL);
		}

		if (!success) {
			hdb_log.error('4.0.0 node update was unable to update connection to node:', name);
			hdb_log.error('Removing following node record from hdb_nodes', node);
			await remove_node({ operation: hdb_terms.OPERATIONS_ENUM.REMOVE_NODE, node_name: name });
		}
	} catch (err) {
		hdb_log.error(err);
		throw err;
	}
}
