'use strict';

const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const clusteringUtils = require('./clusterUtilities.js');
const hdbUtils = require('../common_utils.js');
const joi = require('joi');
const validator = require('../../validation/validationWrapper.js');

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
	clusteringUtils.checkClusteringEnabled();

	const validateRes = validator.validateBySchema(req, VALIDATION_SCHEMA);
	if (validateRes) {
		throw handleHDBError(validateRes, validateRes.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const { timeout, connected_nodes, routes } = req;
	const getConnectedNodes = connected_nodes === undefined || hdbUtils.autoCastBoolean(connected_nodes);
	const getRoutes = routes === undefined || hdbUtils.autoCastBoolean(routes);
	const response = {
		nodes: [],
	};

	// Get list of all servers (nodes) networked to the cluster.
	const allServers = await natsUtils.getServerList(timeout ?? DEFAULT_GET_SERVER_TIMEOUT);

	// Extract connected nodes from server list.
	let statsz = {};
	if (getConnectedNodes) {
		for (let y = 0, sLength = allServers.length; y < sLength; y++) {
			const serverStatsz = allServers[y].statsz;
			if (serverStatsz) {
				statsz[allServers[y].server.name] = serverStatsz.routes;
			}
		}
	}

	for (let x = 0, sLength = allServers.length; x < sLength; x++) {
		// statsz are extracted above so we can ignore them here
		if (allServers[x].statsz) continue;

		const server = allServers[x].server;
		const serverData = allServers[x].data;
		// Get server list will return ALL servers, this includes the leaf servers. We don't use any of the info returned
		// from the leaf servers, so we only process the hub servers in the list.
		if (server.name.endsWith('-hub')) {
			const node = { name: server.name.slice(0, -4), response_time: allServers[x].response_time };
			if (getConnectedNodes) {
				// When duplicate routes exists there can be duplicate connected nodes, this filters out duplicates.
				node.connected_nodes = [];
				if (statsz[server.name]) {
					statsz[server.name].forEach((n) => {
						if (!node.connected_nodes.includes(n.name.slice(0, -4))) node.connected_nodes.push(n.name.slice(0, -4));
					});
				}
			}

			if (getRoutes) {
				// If the server data contains routes array map them to a host/port object array.
				node.routes = serverData.cluster?.urls
					? serverData.cluster?.urls.map((r) => {
							return { host: r.split(':')[0], port: hdbUtils.autoCast(r.split(':')[1]) };
					  })
					: [];
			}

			response.nodes.push(node);
		}
	}

	return response;
}
