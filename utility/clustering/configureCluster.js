'use strict';

const hdbTerms = require('../hdbTerms.ts');
const hdbLogger = require('../logging/harper_logger.js');
const hdbUtils = require('../common_utils.js');
const envMgr = require('../environment/environmentManager.js');
const removeNode = require('./removeNode.js');
const addNode = require('./addNode.js');
const clusteringUtils = require('./clusterUtilities.js');
const configClusterValidator = require('../../validation/clustering/configureClusterValidator.js');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;

const SUCCESS_MSG = 'Configure cluster complete.';
const FAILED_MSG = 'Failed to configure the cluster. Check the logs for more details.';
const PARTIALLY_MSG =
	'Configure cluster was partially successful. Errors occurred when attempting to configure the following nodes. Check the logs for more details.';

module.exports = configureCluster;

/**
 * Bulk create/remove subscriptions for 1 - n remote nodes.
 * Each call supersedes any existing clustering setup.
 * @param request - contains 'connections' param,
 * an object array with each object containing node_name and subscriptions for that node.
 * @returns {Promise<{message: string, connections: *[]}|{message: string, failed_nodes: *[], connections: *[]}>}
 */
async function configureCluster(request) {
	hdbLogger.trace('configure cluster called with:', request);
	const validation = configClusterValidator(request);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	// Configure cluster supersedes any existing clustering setup, for this reason we get all existing nodes and remove them.
	const allNodes = await clusteringUtils.getAllNodeRecords();
	let removeResult = [];
	// Only do this for nats setups
	if (envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		for (let i = 0, nodesLength = allNodes.length; i < nodesLength; i++) {
			const response = await functionWrapper(
				removeNode,
				{ operation: hdbTerms.OPERATIONS_ENUM.REMOVE_NODE, node_name: allNodes[i].name },
				allNodes[i].name
			);
			removeResult.push(response);
		}

		hdbLogger.trace(`All results from configure_cluster remove node:`, removeResult);
	}

	// // For each connection in the request, call add node
	let addResult = [];
	const conLength = request.connections.length;
	for (let x = 0; x < conLength; x++) {
		const connection = request.connections[x];
		const response = await functionWrapper(addNode, connection, connection.node_name);
		addResult.push(response);
	}

	hdbLogger.trace('All results from configure_cluster add node:', addResult);

	// We loop through that array to find if any operations have errored, if they have we log and track them
	// so that we can return the failed node names to api.
	let failed_nodes = [];
	let connectionResults = [];
	let success = false;
	const results = removeResult.concat(addResult);
	for (let j = 0, resLength = results.length; j < resLength; j++) {
		const result = results[j];
		if (result.status === 'rejected') {
			hdbLogger.error(result.node_name, result?.error?.message, result?.error?.stack);
			if (!failed_nodes.includes(result.node_name)) {
				failed_nodes.push(result.node_name);
			}
		}

		// If at lease one of the results was successful track it so we use partial success msg
		if (result?.result?.message?.includes?.('Successfully') || result?.result?.includes?.('Successfully'))
			success = true;

		// results array can include remove node results, do not include those results in response
		if (
			(typeof result.result === 'string' && result.result.includes('Successfully removed')) ||
			result.status === 'rejected'
		)
			continue;

		connectionResults.push({
			node_name: result?.node_name,
			response: result?.result,
		});
	}

	if (hdbUtils.isEmptyOrZeroLength(failed_nodes)) {
		// If no fails return just success message
		return { message: SUCCESS_MSG, connections: connectionResults };
	} else if (success) {
		// If there was at least one fulfilled promise return the failed nodes
		return {
			message: PARTIALLY_MSG,
			failed_nodes,
			connections: connectionResults,
		};
	} else {
		// If none of the add node & remove node operations were successful throw error message
		throw handleHDBError(new Error(), FAILED_MSG, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, undefined, undefined, true);
	}
}

/**
 * Function is wrapped so that the node name can be appended to error if one occurs.
 * @param func
 * @param param
 * @param node_name
 * @returns {Promise<*>}
 */
async function functionWrapper(func, param, node_name) {
	try {
		return {
			node_name,
			result: await func(param),
		};
	} catch (error) {
		return { node_name, error, status: 'rejected' };
	}
}
