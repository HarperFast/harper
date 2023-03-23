'use strict';

const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const nats_utils = require('../../server/nats/utility/natsUtils');
const clustering_utils = require('./clusterUtilities');
const hdb_utils = require('../common_utils');
const joi = require('joi');
const validator = require('../../validation/validationWrapper');

const DEFAULT_GET_SERVER_TIMEOUT = 2000; // milliseconds
const VALIDATION_SCHEMA = joi.object({
	timeout: joi.number().min(1),
	connected_nodes: joi.boolean(),
	routes: joi.boolean(),
});

module.exports = clusterNetwork;

/**
 * Uses getServerList which will ping Nats network for all connected hub/leaf servers and from their response
 * will build a list of connected nodes.
 * @param req
 * @returns {Promise<{nodes: *[]}|*>}
 */
async function clusterNetwork(req) {
	clustering_utils.checkClusteringEnabled();

	const validate_res = validator.validateBySchema(req, VALIDATION_SCHEMA);
	if (validate_res) {
		throw handleHDBError(validate_res, validate_res.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const { timeout, connected_nodes, routes } = req;
	const get_connected_nodes = connected_nodes === undefined || hdb_utils.autoCastBoolean(connected_nodes);
	const get_routes = routes === undefined || hdb_utils.autoCastBoolean(routes);
	const response = {
		nodes: [],
	};

	// Get list of all servers (nodes) networked to the cluster.
	const all_servers = await nats_utils.getServerList(timeout ?? DEFAULT_GET_SERVER_TIMEOUT);

	// Extract connected nodes from server list.
	let statsz = {};
	if (get_connected_nodes) {
		for (let y = 0, s_length = all_servers.length; y < s_length; y++) {
			const server_statsz = all_servers[y].statsz;
			if (server_statsz) {
				statsz[all_servers[y].server.name] = server_statsz.routes;
			}
		}
	}

	for (let x = 0, s_length = all_servers.length; x < s_length; x++) {
		// statsz are extracted above so we can ignore them here
		if (all_servers[x].statsz) continue;

		const server = all_servers[x].server;
		const server_data = all_servers[x].data;
		// Get server list will return ALL servers, this includes the leaf servers. We don't use any of the info returned
		// from the leaf servers, so we only process the hub servers in the list.
		if (server.name.endsWith('-hub')) {
			const node = { name: server.name.slice(0, -4), response_time: all_servers[x].response_time };
			if (get_connected_nodes) {
				node.connected_nodes = statsz[server.name] ? statsz[server.name].map((r) => r.name.slice(0, -4)) : [];
			}

			if (get_routes) {
				// If the server data contains routes array map them to a host/port object array.
				node.routes = server_data.cluster?.urls
					? server_data.cluster?.urls.map((r) => {
							return { host: r.split(':')[0], port: r.split(':')[1] };
					  })
					: [];
			}

			response.nodes.push(node);
		}
	}

	return response;
}
