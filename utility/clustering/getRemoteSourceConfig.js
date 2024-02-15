'use strict';

const hdb_logger = require('../logging/harper_logger');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const env_mgr = require('../environment/environmentManager');
const hdb_utils = require('../common_utils');
const UpdateRemoteResponseObject = require('./UpdateRemoteResponseObject');
const clustering_utils = require('./clusterUtilities');
const UpdateObject = require('../../dataLayer/UpdateObject');
const insert = require('../../dataLayer/insert');

module.exports = getRemoteSourceConfig;

/**
 * Gets the config values needed for cluster status requests.
 * @returns {Promise<UpdateRemoteResponseObject>}
 */
async function getRemoteSourceConfig(req) {
	try {
		hdb_logger.trace(`getRemoteSourceConfig called`);

		const uptime = process.uptime() * 1000;
		const time_elapsed = hdb_utils.ms_to_time(uptime);

		const response = new ConfigResponseObject(
			env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT),
			env_mgr.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT) ??
				env_mgr.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT),
			time_elapsed,
			await clustering_utils.getSystemInfo()
		);

		// The origin node that is requesting this nodes config will send its system info in the request.
		// Update origins node record in hdb nodes table.
		try {
			const update_record = {
				name: req.node_name,
				system_info: req.system_info,
			};

			const qry = new UpdateObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, [
				update_record,
			]);
			await insert.update(qry);
		} catch (err) {
			hdb_logger.error('Get remote config encountered an error updating system info for node:', req.node_name, err);
		}

		hdb_logger.trace('getRemoteSourceConfig response:', response);
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
 * @param system_info
 * @constructor
 */
function ConfigResponseObject(port_clustering, port_operations_api, uptime, system_info) {
	this.uptime = uptime;
	this.ports = {
		clustering: port_clustering,
		operations_api: port_operations_api,
	};
	this.system_info = system_info;
}
