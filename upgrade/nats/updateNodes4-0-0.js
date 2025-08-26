'use strict';

const hdbTerms = require('../../utility/hdbTerms.ts');
const hdbUtils = require('../../utility/common_utils.js');
const clusterUtils = require('../../utility/clustering/clusterUtilities.js');
const hdbLog = require('../../utility/logging/harper_logger.js');
const clusterStatus = require('../../utility/clustering/clusterStatus.js');
const addNode = require('../../utility/clustering/addNode.js');
const pm2Utils = require('../../utility/processManagement/processManagement.js');
const globalSchema = require('../../utility/globalSchema.js');
const removeNode = require('../../utility/clustering/removeNode.js');
const semverGte = require('semver/functions/gte');

const REQUEST_STATUS_INTERVAL = 30000;
const UPDATE_NODE_ALLOWANCE_DAYS = 7;

module.exports = updateAllNodes;

/**
 * This module is launched as a forked process when clustering is started and there are still pre 4.0.0 node records in hdbNodes.
 * It is responsible for re-adding nodes which was required when we switched over to Nats for 4.0.0.
 * @returns {Promise<void>}
 */
async function updateAllNodes() {
	try {
		hdbLog.notify(
			'Starting update nodes. This process will attempt to update any node connections the need to be reestablished after a 4.0.0 upgrade'
		);

		await globalSchema.setSchemaDataToGlobalAsync();
		const nodes = await clusterUtils.getAllNodeRecords();
		let updateNodeFuncCalls = [];

		// For any nodes that are on a pre 4.0.0 version (3.x.x) push to promise array that will call update on them.
		for (let i = 0, recLength = nodes.length; i < recLength; i++) {
			const node = nodes[i];
			if (node.system_info.hdb_version === hdbTerms.PRE_4_0_0_VERSION) updateNodeFuncCalls.push(updateNode(node));
		}

		await Promise.allSettled(updateNodeFuncCalls);
		hdbLog.notify('Shutting down 4.0.0 clustering upgrade process');
	} catch (err) {
		hdbLog.error(err);
		throw err;
	}
}

/**
 * Will keep trying to get the status of a remote node for a set amount of time.
 * If an 'open' status is received from remote node it will call add node on that node.
 * If open status is not received it will eventually delete node from hdbNodes.
 * @param node
 * @returns {Promise<void>}
 */
async function updateNode(node) {
	try {
		const { name, subscriptions } = node;
		hdbLog.notify('Running 4.0.0 update on node:', name);

		let success = false;
		let diffInDays = 0;
		while (diffInDays < UPDATE_NODE_ALLOWANCE_DAYS) {
			let status = [];
			await clusterStatus.buildNodeStatus(node, status);
			hdbLog.trace('Received status:', status[0].status, 'from node:', name);

			// If the remote node has been updated and is running with correct config stop calling status and call add node.
			if (status[0].status === 'open' && semverGte(status[0].system_info.hdb_version, '4.0.0')) {
				hdbLog.notify('Received open status from node:', name, 'calling add node');
				const addNodeReq = {
					operation: hdbTerms.OPERATIONS_ENUM.ADD_NODE,
					node_name: name,
					subscriptions,
				};
				await addNode(addNodeReq, true);
				hdbLog.notify('Successfully added node', name);
				success = true;
				break;
			}

			diffInDays = (Date.now() - node['__updatedtime__']) / (1000 * 60 * 60 * 24);
			hdbLog.trace(
				'Update node has been running for',
				diffInDays,
				'days. Calling node status again for node:',
				name
			);
			await hdbUtils.asyncSetTimeout(REQUEST_STATUS_INTERVAL);
		}

		if (!success) {
			hdbLog.error('4.0.0 node update was unable to update connection to node:', name);
			hdbLog.error('Removing following node record from hdb_nodes', node);
			await removeNode({ operation: hdbTerms.OPERATIONS_ENUM.REMOVE_NODE, node_name: name });
		}
	} catch (err) {
		hdbLog.error(err);
		throw err;
	}
}
