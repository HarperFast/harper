'use strict';

const hdbLogger = require('../logging/harper_logger.js');
const hdbTerms = require('../hdbTerms.ts');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const envMgr = require('../environment/environmentManager.js');
const hdbUtils = require('../common_utils.js');
const UpdateRemoteResponseObject = require('./UpdateRemoteResponseObject.js');
const clusteringUtils = require('./clusterUtilities.js');
const UpdateObject = require('../../dataLayer/UpdateObject.js');
const insert = require('../../dataLayer/insert.js');

module.exports = getRemoteSourceConfig;

/**
 * Gets the config values needed for cluster status requests.
 * @returns {Promise<UpdateRemoteResponseObject>}
 */
async function getRemoteSourceConfig(req) {
	try {
		hdbLogger.trace(`getRemoteSourceConfig called`);

		const uptime = process.uptime() * 1000;
		const timeElapsed = hdbUtils.ms_to_time(uptime);

		const response = new ConfigResponseObject(
			envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT),
			envMgr.get(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT) ??
				envMgr.get(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT),
			timeElapsed,
			await clusteringUtils.getSystemInfo()
		);

		// The origin node that is requesting this nodes config will send its system info in the request.
		// Update origins node record in hdb nodes table.
		try {
			const updateRecord = {
				name: req.node_name,
				system_info: req.system_info,
			};

			const qry = new UpdateObject(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, [
				updateRecord,
			]);
			await insert.update(qry);
		} catch (err) {
			hdbLogger.error('Get remote config encountered an error updating system info for node:', req.node_name, err);
		}

		hdbLogger.trace('getRemoteSourceConfig response:', response);
		return new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS, response);
	} catch (err) {
		hdbLogger.error(err);
		const errMsg = err.message ? err.message : err;

		// If an error occurs return it to the originator node.
		return new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, errMsg);
	}
}

/**
 * Constructs an object that is used to send all the required node config params.
 * @param portClustering
 * @param portOperationsApi
 * @param uptime
 * @param system_info
 * @constructor
 */
function ConfigResponseObject(portClustering, portOperationsApi, uptime, system_info) {
	this.uptime = uptime;
	this.ports = {
		clustering: portClustering,
		operations_api: portOperationsApi,
	};
	this.system_info = system_info;
}
