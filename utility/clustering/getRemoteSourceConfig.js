'use strict';

const hdb_logger = require('../logging/harper_logger');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const env_mgr = require('../environment/environmentManager');
const hdb_utils = require('../common_utils');
const UpdateRemoteResponseObject = require('./UpdateRemoteResponseObject');
const pm2_utils = require('../pm2/utilityFunctions');

module.exports = getRemoteSourceConfig;

/**
 * Gets the config values needed for cluster status requests.
 * @returns {Promise<UpdateRemoteResponseObject>}
 */
async function getRemoteSourceConfig() {
	try {
		hdb_logger.trace(`getRemoteSourceConfig called`);

		// Calculate Hub server uptime
		const hub_desc = await pm2_utils.describe(hdb_terms.CLUSTERING_HUB_PROC_DESCRIPTOR);
		const uptime = hub_desc[0].pm2_env.pm_uptime;
		const time_elapsed = hdb_utils.ms_to_time(Date.now() - uptime);

		const response = new ConfigResponseObject(
			env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT),
			env_mgr.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT),
			time_elapsed
		);

		hdb_logger.trace(`getRemoteSourceConfig response: ${hdb_utils.stringifyObj(response)}`);
		return new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS, response);
	} catch (err) {
		hdb_logger.error(err);
		const err_msg = err.message ? err.message : err;

		// If an error occurs return it to the originator node.
		return new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, err_msg);
	}
}

/**
 * Constructs an object that is used to send all the required node config params.
 * @param port_clustering
 * @param port_operations_api
 * @param uptime
 * @constructor
 */
function ConfigResponseObject(port_clustering, port_operations_api, uptime) {
	this.uptime = uptime;
	this.ports = {
		clustering: port_clustering,
		operations_api: port_operations_api,
	};
}
