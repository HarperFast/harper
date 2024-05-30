'use strict';

const path = require('path');
const fs = require('fs-extra');
const HubConfigObject = require('./HubConfigObject');
const LeafConfigObject = require('./LeafConfigObject');
const HdbUserObject = require('./HdbUserObject');
const SysUserObject = require('./SysUserObject');
const user = require('../../../security/user');
const hdb_utils = require('../../../utility/common_utils');
const config_utils = require('../../../config/configUtils');
const hdb_terms = require('../../../utility/hdbTerms');
const nats_terms = require('./natsTerms');
const { CONFIG_PARAMS } = hdb_terms;
const hdb_logger = require('../../../utility/logging/harper_logger');
const env_manager = require('../../../utility/environment/environmentManager');
const crypto_hash = require('../../../security/cryptoHash');
const nats_utils = require('./natsUtils');
const keys = require('../../../security/keys');

const HDB_CLUSTERING_FOLDER = 'clustering';
const ZERO_WRITE_COUNT = 10000;
const MAX_SERVER_CONNECTION_RETRY = 50;

module.exports = {
	generateNatsConfig,
	removeNatsConfig,
	getHubConfigPath,
};

function getHubConfigPath() {
	const HDB_ROOT = env_manager.get(CONFIG_PARAMS.ROOTPATH);
	return path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, nats_terms.NATS_CONFIG_FILES.HUB_SERVER);
}
/**
 * Generates and writes to file Nats config for hub and leaf servers.
 * Config params come from harperdb-config.yaml and users table.
 * Some validation is done on users and ports.
 * @param is_restart - if calling from restart skip port checks
 * @param process_name - if restarting one server we only want to create config for that one
 * @returns {Promise<void>}
 */
async function generateNatsConfig(is_restart = false, process_name = undefined) {
	env_manager.initSync();
	const CA_FILE = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH);
	const KEY_FILE = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY);
	const CERT_FILE = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE);

	if (!(await fs.exists(CERT_FILE)) && !(await fs.exists(!CA_FILE))) {
		await keys.writeDefaultCertsToFile();
	}

	const HDB_ROOT = env_manager.get(CONFIG_PARAMS.ROOTPATH);
	const HUB_PID_FILE_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, nats_terms.PID_FILES.HUB);
	const LEAF_PID_FILE_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, nats_terms.PID_FILES.LEAF);
	const LEAF_JS_STORE_DIR = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_PATH);
	const HUB_CONFIG_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, nats_terms.NATS_CONFIG_FILES.HUB_SERVER);
	const LEAF_CONFIG_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, nats_terms.NATS_CONFIG_FILES.LEAF_SERVER);

	const INSECURE = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_INSECURE);
	const VERIFY = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_VERIFY);
	const CLUSTERING_NODENAME = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_NODENAME);
	const CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT = config_utils.getConfigFromFile(
		CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT
	);

	if (!(await nats_utils.checkNATSServerInstalled())) {
		generateNatsConfigError("nats-server dependency is either missing or the wrong version. Run 'npm install' to fix");
	}

	const users = await user.listUsers();
	const cluster_username = config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_USER);
	const cluster_user = await user.getClusterUser();
	if (hdb_utils.isEmpty(cluster_user) || cluster_user.active !== true) {
		generateNatsConfigError(
			`Invalid cluster user '${cluster_username}'. A valid user with the role 'cluster_user' must be defined under clustering.user in harperdb-config.yaml`
		);
	}

	if (!is_restart) {
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT);
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT);
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT);
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT);
	}

	// Extract all active cluster users from all users
	let sys_users = [];
	let hdb_users = [];
	for (const [key, value] of users.entries()) {
		if (value.role.role === hdb_terms.ROLE_TYPES_ENUM.CLUSTER_USER && value.active) {
			sys_users.push(new SysUserObject(value.username, crypto_hash.decrypt(value.hash)));
			hdb_users.push(new HdbUserObject(value.username, crypto_hash.decrypt(value.hash)));
		}
	}

	// Build hub server cluster routes from cluster user and ip/ports
	let cluster_routes = [];
	const { hub_routes } = config_utils.getClusteringRoutes();
	if (!hdb_utils.isEmptyOrZeroLength(hub_routes)) {
		for (const route of hub_routes) {
			cluster_routes.push(
				`tls://${cluster_user.sys_name_encoded}:${cluster_user.uri_encoded_d_hash}@${route.host}:${route.port}`
			);
		}
	}

	// Create hub server json and write to file
	const hub_config = new HubConfigObject(
		config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT),
		CLUSTERING_NODENAME,
		HUB_PID_FILE_PATH,
		CERT_FILE,
		KEY_FILE,
		CA_FILE,
		INSECURE,
		VERIFY,
		CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT,
		config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME),
		config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT),
		cluster_routes,
		sys_users,
		hdb_users
	);

	if (CA_FILE == null) {
		delete hub_config.tls.ca_file;
		delete hub_config.leafnodes.tls.ca_file;
	}

	process_name = hdb_utils.isEmpty(process_name) ? undefined : process_name.toLowerCase();
	if (process_name === undefined || process_name === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase()) {
		await fs.writeJson(HUB_CONFIG_PATH, hub_config);
		hdb_logger.trace(`Hub server config written to ${HUB_CONFIG_PATH}`);
	}

	const leafnode_remotes_url_sys = `tls://${cluster_user.sys_name_encoded}:${cluster_user.uri_encoded_d_hash}@0.0.0.0:${CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT}`;

	const leafnode_remotes_url_hdb = `tls://${cluster_user.uri_encoded_name}:${cluster_user.uri_encoded_d_hash}@0.0.0.0:${CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT}`;

	// Create leaf server config and write to file
	const leaf_config = new LeafConfigObject(
		config_utils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT),
		CLUSTERING_NODENAME,
		LEAF_PID_FILE_PATH,
		LEAF_JS_STORE_DIR,
		[leafnode_remotes_url_sys],
		[leafnode_remotes_url_hdb],
		sys_users,
		hdb_users,
		CERT_FILE,
		KEY_FILE,
		CA_FILE,
		INSECURE
	);

	if (CA_FILE == null) {
		delete leaf_config.tls.ca_file;
	}

	if (process_name === undefined || process_name === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase()) {
		await fs.writeJson(LEAF_CONFIG_PATH, leaf_config);
		hdb_logger.trace(`Leaf server config written to ${LEAF_CONFIG_PATH}`);
	}
}

async function isPortAvailable(param) {
	const port = env_manager.get(param);
	if (hdb_utils.isEmpty(port)) {
		generateNatsConfigError(`port undefined for '${param}'`);
	}

	if (await hdb_utils.isPortTaken(port)) {
		generateNatsConfigError(
			`'${param}' port '${port}' is is in use by another process, check to see if HarperDB is already running or another process is using this port.`
		);
	}
	return true;
}

function generateNatsConfigError(msg) {
	const err_msg = `Error generating clustering config: ${msg}`;
	hdb_logger.error(err_msg);
	console.error(err_msg);
	process.exit(1);
}

/**
 * Removes a nats server config file after the server using that file is connected.
 * We use plain text passwords in the Nats config files, for this reason we remove the files
 * from disk after the servers have launched.
 * @param process_name
 * @returns {Promise<void>}
 */
async function removeNatsConfig(process_name) {
	const { port, config_file } = nats_utils.getServerConfig(process_name);
	const { username, decrypt_hash } = await user.getClusterUser();

	// This while loop ensures that the nats server is connected before its config file is deleted
	let count = 0;
	let wait_time = 2000;
	while (count < MAX_SERVER_CONNECTION_RETRY) {
		try {
			const server_con = await nats_utils.createConnection(port, username, decrypt_hash, false);
			if (server_con.protocol.connected === true) {
				server_con.close();
				break;
			}
		} catch (err) {
			hdb_logger.trace(`removeNatsConfig waiting for ${process_name}. Caught and swallowed error ${err}`);
		}

		count++;
		if (count >= MAX_SERVER_CONNECTION_RETRY) {
			throw new Error(
				`Operations API timed out attempting to connect to ${process_name}. This is commonly caused by incorrect clustering config. Check hdb.log for further details.`
			);
		}

		let timeout_time = wait_time * (count * 2);
		if (timeout_time > 30000)
			hdb_logger.notify(
				'Operations API waiting for Nats server connection. This could be caused by large Nats streams or incorrect clustering config.'
			);
		await hdb_utils.async_set_timeout(timeout_time);
	}

	// We write a bunch of zeros over the existing config file so that any trace of the previous config is completely removed from disk.
	const string_of_zeros = '0'.repeat(ZERO_WRITE_COUNT);
	const config_file_path = path.join(env_manager.get(CONFIG_PARAMS.ROOTPATH), HDB_CLUSTERING_FOLDER, config_file);
	await fs.writeFile(config_file_path, string_of_zeros);
	await fs.remove(config_file_path);
	hdb_logger.notify(process_name, 'started.');
}
