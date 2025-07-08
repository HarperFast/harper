'use strict';

const fs = require('fs-extra');
const path = require('path');
const YAML = require('yaml');

const natsUtils = require('../server/nats/utility/natsUtils.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const natsTerms = require('../server/nats/utility/natsTerms.js');
const hdbLog = require('../utility/logging/harper_logger.js');
const user = require('../security/user.js');
const clusterNetwork = require('../utility/clustering/clusterNetwork.js');
const clusterStatus = require('../utility/clustering/clusterStatus.js');
const sysInfo = require('../utility/environment/systemInformation.js');
const envMgr = require('../utility/environment/environmentManager.js');
const hdbUtils = require('../utility/common_utils.js');
const installation = require('../utility/installation.ts');
envMgr.initSync();

const STATUSES = {
	RUNNING: 'running',
	STOPPED: 'stopped',
	ERRORED: 'errored',
	NOT_INSTALLED: 'not installed',
};
const NATS_SERVER_NAME = {
	LEAF: 'leaf server',
	HUB: 'hub server',
};

let hdbRoot;

module.exports = status;

async function status() {
	let status = {
		harperdb: {
			status: STATUSES.STOPPED,
		},
	};

	if (!(await installation.isHdbInstalled(envMgr, hdbLog))) {
		status.harperdb.status = STATUSES.NOT_INSTALLED;
		console.log(YAML.stringify(status));
		return;
	}

	hdbRoot = envMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
	let hdbPid;
	try {
		hdbPid = Number.parseInt(await fs.readFile(path.join(hdbRoot, hdbTerms.HDB_PID_FILE), 'utf8'));
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
			hdbLog.info('`harperdb status` did not find a hdb.pid file');
			status.harperdb.status = STATUSES.STOPPED;
			console.log(YAML.stringify(status));
			return;
		}

		throw err;
	}

	// Check the saved pid against any running hdb processes
	const hdbSysInfo = await sysInfo.getHDBProcessInfo();
	for (const proc of hdbSysInfo.core) {
		if (proc.pid === hdbPid) {
			status.harperdb.status = STATUSES.RUNNING;
			status.harperdb.pid = hdbPid;
			break;
		}
	}

	if (
		envMgr.get(hdbTerms.CONFIG_PARAMS.REPLICATION_URL) ||
		envMgr.get(hdbTerms.CONFIG_PARAMS.REPLICATION_HOSTNAME)
	) {
		status.replication = await getReplicationStatus();
	}
	status.clustering = await getHubLeafStatus(hdbSysInfo);

	// Can only get cluster network & status if both servers are running and happy
	if (
		status.clustering[NATS_SERVER_NAME.HUB].status === STATUSES.RUNNING &&
		status.clustering[NATS_SERVER_NAME.LEAF].status === STATUSES.RUNNING
	) {
		let cNetwork = [];
		const clusterNet = await clusterNetwork({});
		// Loop through cluster network response and remove underscores in key names
		for (const node of clusterNet.nodes) {
			let nodeInf = {};
			for (let val in node) {
				nodeInf[val.replace('_', ' ')] = node[val];
			}
			cNetwork.push(nodeInf);
		}
		status.clustering.network = cNetwork;

		const clusterSubs = await clusterStatus.clusterStatus();
		status.clustering.replication = {
			['node name']: clusterSubs.node_name,
			['is enabled']: clusterSubs.is_enabled,
			connections: [],
		};

		for (const cons of clusterSubs.connections) {
			const con = {};
			con['node name'] = cons?.node_name;
			con.status = cons?.status;
			con.ports = {
				'clustering': cons?.ports?.clustering,
				'operations api': cons?.ports?.operations_api,
			};
			con['latency ms'] = cons?.latency_ms;
			con.uptime = cons?.uptime;
			con.subscriptions = cons?.subscriptions;
			con['system info'] = {
				'hdb version': cons?.system_info?.hdb_version,
				'node version': cons?.system_info?.node_version,
				'platform': cons?.system_info?.platform,
			};
			status.clustering.replication.connections.push(con);
		}

		await natsUtils.closeConnection();
	}

	console.log(YAML.stringify(status));
	// This is here because sometime nats won't release the process
	process.exit();
}

/**
 * Gets the pid for the hub and leaf and also connects to the hub and leaf servers to confirm they are running
 * @returns {Promise<{"[NATS_SERVER_NAME.LEAF]": {}, "[NATS_SERVER_NAME.HUB]": {}}>}
 */
async function getHubLeafStatus(hdbSysInfo) {
	let status = {
		[NATS_SERVER_NAME.HUB]: {},
		[NATS_SERVER_NAME.LEAF]: {},
	};

	if (hdbSysInfo.clustering.length === 0) {
		status[NATS_SERVER_NAME.HUB].status = STATUSES.STOPPED;
		status[NATS_SERVER_NAME.LEAF].status = STATUSES.STOPPED;
		return status;
	}

	// Connect to hub server to confirm its running and happy
	const { port: hubPort } = natsUtils.getServerConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
	const { username, decrypt_hash } = await user.getClusterUser();
	try {
		const hubCon = await natsUtils.createConnection(hubPort, username, decrypt_hash, false);
		hubCon.close();
		status[NATS_SERVER_NAME.HUB].status = STATUSES.RUNNING;
	} catch (err) {
		status[NATS_SERVER_NAME.HUB].status = STATUSES.ERRORED;
	}

	// Connect to leaf server to confirm it is running and happy
	const { port: leafPort } = natsUtils.getServerConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	try {
		const leafCon = await natsUtils.createConnection(leafPort, username, decrypt_hash, false);
		leafCon.close();
		status[NATS_SERVER_NAME.LEAF].status = STATUSES.RUNNING;
	} catch (err) {
		status[NATS_SERVER_NAME.LEAF].status = STATUSES.ERRORED;
	}

	try {
		status[NATS_SERVER_NAME.HUB].pid = Number.parseInt(
			await fs.readFile(path.join(hdbRoot, 'clustering', natsTerms.PID_FILES.HUB), 'utf8')
		);
	} catch (err) {
		hdbLog.error(err);
		status[NATS_SERVER_NAME.HUB].pid = undefined;
	}

	try {
		status[NATS_SERVER_NAME.LEAF].pid = Number.parseInt(
			await fs.readFile(path.join(hdbRoot, 'clustering', natsTerms.PID_FILES.LEAF), 'utf8')
		);
	} catch (err) {
		hdbLog.error(err);
		status[NATS_SERVER_NAME.LEAF].pid = undefined;
	}

	return status;
}

/**
 * Gets the replication AKA Plexus status of the HarperDB instance
 * @returns {Promise<{"node name", "is enabled": (boolean|*), connections: *[]}>}
 */
async function getReplicationStatus() {
	let response = await hdbUtils.httpRequest(
		{
			method: 'POST',
			protocol: 'http:',
			socketPath: envMgr.get(hdbTerms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
			headers: { 'Content-Type': 'application/json' },
		},
		{ operation: 'cluster_status' }
	);

	response = JSON.parse(response.body);
	const repStatus = {
		'node name': response.node_name,
		'is enabled': response.is_enabled,
		'connections': [],
	};

	for (const cons of response.connections) {
		repStatus.connections.push({
			'node name': cons.name,
			'url': cons.url,
			'subscriptions': cons.subscriptions,
			'replicates': cons.replicates,
			'database sockets': cons.database_sockets.map((socket) => {
				return {
					'database': socket.database,
					'connected': socket.connected,
					'latency': socket.latency,
					'catching up from': socket.catching_up_from,
					'thread id': socket.thread_id,
					'nodes': socket.nodes,
				};
			}),
		});
	}

	return repStatus;
}
