'use strict';

const fs = require('fs-extra');
const path = require('path');
const YAML = require('yaml');

const nats_utils = require('../server/nats/utility/natsUtils');
const hdb_terms = require('../utility/hdbTerms');
const nats_terms = require('../server/nats/utility/natsTerms');
const hdb_log = require('../utility/logging/harper_logger');
const user = require('../security/user');
const cluster_network = require('../utility/clustering/clusterNetwork');
const cluster_status = require('../utility/clustering/clusterStatus');
const sys_info = require('../utility/environment/systemInformation');
const env_mgr = require('../utility/environment/environmentManager');
const run = require('./run');
const hdb_utils = require('../utility/common_utils');
env_mgr.initSync();

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

let hdb_root;

module.exports = status;

async function status() {
	let status = {
		harperdb: {
			status: STATUSES.STOPPED,
		},
	};

	if (!(await run.isHdbInstalled())) {
		status.harperdb.status = STATUSES.NOT_INSTALLED;
		console.log(YAML.stringify(status));
		return;
	}

	hdb_root = env_mgr.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
	let hdb_pid;
	try {
		hdb_pid = Number.parseInt(await fs.readFile(path.join(hdb_root, hdb_terms.HDB_PID_FILE), 'utf8'));
	} catch (err) {
		if (err.code === hdb_terms.NODE_ERROR_CODES.ENOENT) {
			hdb_log.info('`harperdb status` did not find a hdb.pid file');
			status.harperdb.status = STATUSES.STOPPED;
			console.log(YAML.stringify(status));
			return;
		}

		throw err;
	}

	// Check the saved pid against any running hdb processes
	const hdb_sys_info = await sys_info.getHDBProcessInfo();
	for (const proc of hdb_sys_info.core) {
		if (proc.pid === hdb_pid) {
			status.harperdb.status = STATUSES.RUNNING;
			status.harperdb.pid = hdb_pid;
			break;
		}
	}

	if (
		env_mgr.get(hdb_terms.CONFIG_PARAMS.REPLICATION_URL) ||
		env_mgr.get(hdb_terms.CONFIG_PARAMS.REPLICATION_HOSTNAME)
	) {
		status.replication = await getReplicationStatus();
	}
	status.clustering = await getHubLeafStatus(hdb_sys_info);

	// Can only get cluster network & status if both servers are running and happy
	if (
		status.clustering[NATS_SERVER_NAME.HUB].status === STATUSES.RUNNING &&
		status.clustering[NATS_SERVER_NAME.LEAF].status === STATUSES.RUNNING
	) {
		let c_network = [];
		const cluster_net = await cluster_network({});
		// Loop through cluster network response and remove underscores in key names
		for (const node of cluster_net.nodes) {
			let node_inf = {};
			for (let val in node) {
				node_inf[val.replace('_', ' ')] = node[val];
			}
			c_network.push(node_inf);
		}
		status.clustering.network = c_network;

		const cluster_subs = await cluster_status.clusterStatus();
		status.clustering.replication = {
			['node name']: cluster_subs.node_name,
			['is enabled']: cluster_subs.is_enabled,
			connections: [],
		};

		for (const cons of cluster_subs.connections) {
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

		await nats_utils.closeConnection();
	}

	console.log(YAML.stringify(status));
	// This is here because sometime nats won't release the process
	process.exit();
}

/**
 * Gets the pid for the hub and leaf and also connects to the hub and leaf servers to confirm they are running
 * @returns {Promise<{"[NATS_SERVER_NAME.LEAF]": {}, "[NATS_SERVER_NAME.HUB]": {}}>}
 */
async function getHubLeafStatus(hdb_sys_info) {
	let status = {
		[NATS_SERVER_NAME.HUB]: {},
		[NATS_SERVER_NAME.LEAF]: {},
	};

	if (hdb_sys_info.clustering.length === 0) {
		status[NATS_SERVER_NAME.HUB].status = STATUSES.STOPPED;
		status[NATS_SERVER_NAME.LEAF].status = STATUSES.STOPPED;
		return status;
	}

	// Connect to hub server to confirm its running and happy
	const { port: hub_port } = nats_utils.getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
	const { username, decrypt_hash } = await user.getClusterUser();
	try {
		const hub_con = await nats_utils.createConnection(hub_port, username, decrypt_hash, false);
		hub_con.close();
		status[NATS_SERVER_NAME.HUB].status = STATUSES.RUNNING;
	} catch (err) {
		status[NATS_SERVER_NAME.HUB].status = STATUSES.ERRORED;
	}

	// Connect to leaf server to confirm it is running and happy
	const { port: leaf_port } = nats_utils.getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	try {
		const leaf_con = await nats_utils.createConnection(leaf_port, username, decrypt_hash, false);
		leaf_con.close();
		status[NATS_SERVER_NAME.LEAF].status = STATUSES.RUNNING;
	} catch (err) {
		status[NATS_SERVER_NAME.LEAF].status = STATUSES.ERRORED;
	}

	try {
		status[NATS_SERVER_NAME.HUB].pid = Number.parseInt(
			await fs.readFile(path.join(hdb_root, 'clustering', nats_terms.PID_FILES.HUB), 'utf8')
		);
	} catch (err) {
		hdb_log.error(err);
		status[NATS_SERVER_NAME.HUB].pid = undefined;
	}

	try {
		status[NATS_SERVER_NAME.LEAF].pid = Number.parseInt(
			await fs.readFile(path.join(hdb_root, 'clustering', nats_terms.PID_FILES.LEAF), 'utf8')
		);
	} catch (err) {
		hdb_log.error(err);
		status[NATS_SERVER_NAME.LEAF].pid = undefined;
	}

	return status;
}

/**
 * Gets the replication AKA Plexus status of the HarperDB instance
 * @returns {Promise<{"node name", "is enabled": (boolean|*), connections: *[]}>}
 */
async function getReplicationStatus() {
	let response = await hdb_utils.httpRequest(
		{
			method: 'POST',
			protocol: 'http:',
			socketPath: env_mgr.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
			headers: { 'Content-Type': 'application/json' },
		},
		{ operation: 'cluster_status' }
	);

	response = JSON.parse(response.body);
	const rep_status = {
		'node name': response.node_name,
		'is enabled': response.is_enabled,
		'connections': [],
	};

	for (const cons of response.connections) {
		rep_status.connections.push({
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

	return rep_status;
}
