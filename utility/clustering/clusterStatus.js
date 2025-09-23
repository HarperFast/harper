'use strict';

const clusterUtils = require('./clusterUtilities.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const envMgr = require('../environment/environmentManager.js');
const hdbTerms = require('../hdbTerms.ts');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const hdbUtils = require('../common_utils.js');
const hdbLogger = require('../logging/harper_logger.js');
const { RemotePayloadObject } = require('./RemotePayloadObject.js');
const { ErrorCode } = require('nats');
const { parentPort } = require('worker_threads');
const { onMessageByType } = require('../../server/threads/manageThreads.js');
const { getThisNodeName } = require('../../server/replication/replicator.ts');
const { requestClusterStatus } = require('../../server/replication/subscriptionManager.ts');
const { getReplicationSharedStatus, getHDBNodeTable } = require('../../server/replication/knownNodes.ts');
const {
	CONFIRMATION_STATUS_POSITION,
	RECEIVED_VERSION_POSITION,
	RECEIVED_TIME_POSITION,
	SENDING_TIME_POSITION,
	RECEIVING_STATUS_POSITION,
	RECEIVING_STATUS_RECEIVING,
	BACK_PRESSURE_RATIO_POSITION,
} = require('../../server/replication/replicationConnection.ts');

const clusteringEnabled = envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED);
const thisNodeName = envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = {
	clusterStatus,
	buildNodeStatus,
};

let clusterStatusResolve;
onMessageByType('cluster-status', async (message) => {
	clusterStatusResolve(message);
});
/**
 * Function will msg all the remote nodes in the hdbNodes table. From the replies
 * it gets back from each node and the details in the hdbNodes table it will
 * generate a status object. All the status objects are pushed to an array and returned.
 * @returns {Promise<{is_enabled: *, node_name: *, connections: *[]}>}
 */
async function clusterStatus() {
	if (envMgr.get(hdbTerms.CONFIG_PARAMS.REPLICATION_URL) || envMgr.get(hdbTerms.CONFIG_PARAMS.REPLICATION_HOSTNAME)) {
		let response;
		if (parentPort) {
			parentPort.postMessage({ type: 'request-cluster-status' });
			response = await new Promise((resolve) => {
				clusterStatusResolve = resolve;
			});
			for (let connection of response.connections) {
				const remoteNodeName = connection.name;
				for (let socket of connection.database_sockets) {
					const databaseName = socket.database;
					let auditStore;
					for (let table of Object.values(databases[databaseName] || {})) {
						auditStore = table.auditStore;
						if (auditStore) break;
					}
					if (!auditStore) continue;
					let replicationSharedStatus = getReplicationSharedStatus(auditStore, databaseName, remoteNodeName);
					socket.lastCommitConfirmed = asDate(replicationSharedStatus[CONFIRMATION_STATUS_POSITION]);
					socket.lastReceivedRemoteTime = asDate(replicationSharedStatus[RECEIVED_VERSION_POSITION]);
					socket.lastReceivedLocalTime = asDate(replicationSharedStatus[RECEIVED_TIME_POSITION]);
					// Raw version timestamp for precise sync comparison (preserves float64 precision)
					socket.lastReceivedVersion = replicationSharedStatus[RECEIVED_VERSION_POSITION];
					socket.sendingMessage = asDate(replicationSharedStatus[SENDING_TIME_POSITION]);
					socket.backPressurePercent = replicationSharedStatus[BACK_PRESSURE_RATIO_POSITION] * 100;
					socket.lastReceivedStatus =
						replicationSharedStatus[RECEIVING_STATUS_POSITION] === RECEIVING_STATUS_RECEIVING ? 'Receiving' : 'Waiting';
				}
			}
		} else {
			response = requestClusterStatus();
		}
		response.node_name = getThisNodeName();
		// If it doesn't exist and or needs to be updated.
		const thisNode = getHDBNodeTable().primaryStore.get(response.node_name);
		if (thisNode?.shard) response.shard = thisNode.shard;
		if (thisNode?.url) response.url = thisNode.url;
		response.is_enabled = true; // if we have replication, replication is enabled
		return response;
	}
	const response = {
		node_name: thisNodeName,
		is_enabled: clusteringEnabled,
		connections: [],
	};

	// If clustering is not enabled return response with empty connections.
	if (!clusteringEnabled) return response;

	// If clustering is enabled but there are no records in the hdbNodes table, return response with empty connections.
	const allNodeRecords = await clusterUtils.getAllNodeRecords();
	if (hdbUtils.isEmptyOrZeroLength(allNodeRecords)) return response;

	// For all the records in the hdbNodes table build a status for each one.
	// Each call to buildNodeStatus is pushed to a promises array so that we can utilize
	// Promise.allSettled which runs all the promises in parallel.
	let promises = [];
	for (let i = 0, recLength = allNodeRecords.length; i < recLength; i++) {
		promises.push(buildNodeStatus(allNodeRecords[i], response.connections));
	}

	await Promise.allSettled(promises);

	return response;
}
function asDate(date) {
	return date ? (date === 1 ? 'Copying' : new Date(date).toUTCString()) : undefined;
}

async function buildNodeStatus(nodeRecord, connections) {
	const remoteNodeName = nodeRecord.name;
	const remotePayload = new RemotePayloadObject(
		hdbTerms.OPERATIONS_ENUM.CLUSTER_STATUS,
		thisNodeName,
		undefined,
		await clusterUtils.getSystemInfo()
	);
	let reply;
	let elapsedTime;
	let status = natsTerms.CLUSTER_STATUS_STATUSES.OPEN;
	try {
		const startTime = Date.now();
		reply = await natsUtils.request(natsTerms.REQUEST_SUBJECT(remoteNodeName), remotePayload);
		elapsedTime = Date.now() - startTime;

		// If an error occurs any value that we rely on from the remote node will be set to undefined.
		// If the remote node replies with an error, set status to closed and log error.
		if (reply.status === natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
			status = natsTerms.CLUSTER_STATUS_STATUSES.CLOSED;
			hdbLogger.error(`Error getting node status from ${remoteNodeName} `, reply);
		}
	} catch (err) {
		// If the request to the remote node fails set status accordingly and log error.
		hdbLogger.warn(`Error getting node status from ${remoteNodeName}`, err);
		if (err.code === ErrorCode.NoResponders) status = natsTerms.CLUSTER_STATUS_STATUSES.NO_RESPONDERS;
		else if (err.code === ErrorCode.Timeout) status = natsTerms.CLUSTER_STATUS_STATUSES.TIMEOUT;
		else status = natsTerms.CLUSTER_STATUS_STATUSES.CLOSED;
	}

	const nodeStatus = new NodeStatusObject(
		remoteNodeName,
		status,
		reply?.message?.ports?.clustering,
		reply?.message?.ports?.operations_api,
		elapsedTime,
		reply?.message?.uptime,
		nodeRecord.subscriptions,
		reply?.message?.system_info
	);

	try {
		// Each node responding to the status request should send its system info back.
		// Update its system info in hdb nodes table.
		const updateRecord = {
			name: remoteNodeName,
			system_info: reply?.message?.system_info,
		};

		// pre 4.0.0 clustering upgrade relies on system_info.hdb_version being 3.x.x, for this reason dont update any version that match this
		if (nodeRecord.system_info?.hdb_version !== hdbTerms.PRE_4_0_0_VERSION) {
			await clusterUtils.upsertNodeRecord(updateRecord);
		}
	} catch (err) {
		hdbLogger.error('Cluster status encountered an error updating system info for node:', remoteNodeName, err);
	}

	connections.push(nodeStatus);
}

/**
 * Constructs an object that will be used as the complete status of one remote node.
 * @param node_name
 * @param status
 * @param portClustering
 * @param portOperationsApi
 * @param latency
 * @param uptime
 * @param subs
 * @param system_info
 * @constructor
 */
function NodeStatusObject(node_name, status, portClustering, portOperationsApi, latency, uptime, subs, system_info) {
	this.node_name = node_name;
	this.status = status;
	this.ports = {
		clustering: portClustering,
		operations_api: portOperationsApi,
	};
	this.latency_ms = latency;
	this.uptime = uptime;
	this.subscriptions = subs;
	this.system_info = system_info;
}
