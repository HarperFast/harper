'use strict';

const hdb_terms = require('../hdbTerms');
const hdb_logger = require('../logging/harper_logger');
const hdb_utils = require('../common_utils');
const remove_node = require('./removeNode');
const add_node = require('./addNode');
const clustering_utils = require('./clusterUtilities');
const config_cluster_validator = require('../../validation/clustering/configureClusterValidator');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

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
	hdb_logger.trace('configure cluster called with:', request);
	clustering_utils.checkClusteringEnabled();
	const validation = config_cluster_validator(request);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	// Configure cluster supersedes any existing clustering setup, for this reason we get all existing nodes and remove them.
	const all_nodes = await clustering_utils.getAllNodeRecords();
	let remove_result = [];
	for (let i = 0, nodes_length = all_nodes.length; i < nodes_length; i++) {
		const response = await functionWrapper(
			remove_node,
			{ operation: hdb_terms.OPERATIONS_ENUM.REMOVE_NODE, node_name: all_nodes[i].name },
			all_nodes[i].name
		);
		remove_result.push(response);
	}

	hdb_logger.trace(`All results from configure_cluster remove node:`, remove_result);

	// // For each connection in the request, call add node
	let add_result = [];
	const con_length = request.connections.length;
	for (let x = 0; x < con_length; x++) {
		const connection = request.connections[x];
		const response = await functionWrapper(add_node, connection, connection.node_name);
		add_result.push(response);
	}

	hdb_logger.trace('All results from configure_cluster add node:', add_result);

	// We loop through that array to find if any operations have errored, if they have we log and track them
	// so that we can return the failed node names to api.
	let failed_nodes = [];
	let connection_results = [];
	let success = false;
	const results = remove_result.concat(add_result);
	for (let j = 0, res_length = results.length; j < res_length; j++) {
		const result = results[j];
		if (result.status === 'rejected') {
			hdb_logger.error(result);
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

		connection_results.push({
			node_name: result?.node_name,
			subscriptions: result?.result,
		});
	}

	if (hdb_utils.isEmptyOrZeroLength(failed_nodes)) {
		// If no fails return just success message
		return { message: SUCCESS_MSG, connections: connection_results };
	} else if (success) {
		// If there was at least one fulfilled promise return the failed nodes
		return {
			message: PARTIALLY_MSG,
			failed_nodes,
			connections: connection_results,
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
