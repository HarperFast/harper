'use strict';

const path = require('path');
const fs = require('fs-extra');
const HubConfigObject = require('./HubConfigObject.js');
const LeafConfigObject = require('./LeafConfigObject.js');
const HdbUserObject = require('./HdbUserObject.js');
const SysUserObject = require('./SysUserObject.js');
const user = require('../../../security/user.js');
const hdbUtils = require('../../../utility/common_utils.js');
const configUtils = require('../../../config/configUtils.js');
const hdbTerms = require('../../../utility/hdbTerms.ts');
const natsTerms = require('./natsTerms.js');
const { CONFIG_PARAMS } = hdbTerms;
const hdbLogger = require('../../../utility/logging/harper_logger.js');
const envManager = require('../../../utility/environment/environmentManager.js');
const cryptoHash = require('../../../security/cryptoHash.js');
const natsUtils = require('./natsUtils.js');
const keys = require('../../../security/keys.js');

const HDB_CLUSTERING_FOLDER = 'clustering';
const ZERO_WRITE_COUNT = 10000;
const MAX_SERVER_CONNECTION_RETRY = 50;

module.exports = {
	generateNatsConfig,
	removeNatsConfig,
	getHubConfigPath,
};

function getHubConfigPath() {
	const HDB_ROOT = envManager.get(CONFIG_PARAMS.ROOTPATH);
	return path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, natsTerms.NATS_CONFIG_FILES.HUB_SERVER);
}
/**
 * Generates and writes to file Nats config for hub and leaf servers.
 * Config params come from harperdb-config.yaml and users table.
 * Some validation is done on users and ports.
 * @param isRestart - if calling from restart skip port checks
 * @param processName - if restarting one server we only want to create config for that one
 * @returns {Promise<void>}
 */
async function generateNatsConfig(isRestart = false, processName = undefined) {
	console.error('Warning: NATS replication is deprecated and will be removed in version 5.0 of Harper');
	const HDB_ROOT = envManager.get(CONFIG_PARAMS.ROOTPATH);
	fs.ensureDirSync(path.join(HDB_ROOT, 'clustering', 'leaf'));
	envManager.initSync();
	const CA_FILE = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH);
	const KEY_FILE = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY);
	const CERT_FILE = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE);

	if (!(await fs.exists(CERT_FILE)) && !(await fs.exists(!CA_FILE))) {
		await keys.createNatsCerts();
	}

	const HUB_PID_FILE_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, natsTerms.PID_FILES.HUB);
	const LEAF_PID_FILE_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, natsTerms.PID_FILES.LEAF);
	const LEAF_JS_STORE_DIR = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_PATH);
	const HUB_CONFIG_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, natsTerms.NATS_CONFIG_FILES.HUB_SERVER);
	const LEAF_CONFIG_PATH = path.join(HDB_ROOT, HDB_CLUSTERING_FOLDER, natsTerms.NATS_CONFIG_FILES.LEAF_SERVER);

	const INSECURE = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_INSECURE);
	const VERIFY = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_TLS_VERIFY);
	const CLUSTERING_NODENAME = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_NODENAME);
	const CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT = configUtils.getConfigFromFile(
		CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT
	);

	if (!(await natsUtils.checkNATSServerInstalled())) {
		generateNatsConfigError("nats-server dependency is either missing or the wrong version. Run 'npm install' to fix");
	}

	const users = await user.listUsers();
	const clusterUsername = configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_USER);
	const cluster_user = await user.getClusterUser();
	if (hdbUtils.isEmpty(cluster_user) || cluster_user.active !== true) {
		generateNatsConfigError(
			`Invalid cluster user '${clusterUsername}'. A valid user with the role 'cluster_user' must be defined under clustering.user in harperdb-config.yaml`
		);
	}

	if (!isRestart) {
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT);
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT);
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT);
		await isPortAvailable(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT);
	}

	// Extract all active cluster users from all users
	let sysUsers = [];
	let hdbUsers = [];
	for (const [key, value] of users.entries()) {
		if (value.role?.role === hdbTerms.ROLE_TYPES_ENUM.CLUSTER_USER && value.active) {
			sysUsers.push(new SysUserObject(value.username, cryptoHash.decrypt(value.hash)));
			hdbUsers.push(new HdbUserObject(value.username, cryptoHash.decrypt(value.hash)));
		}
	}

	// Build hub server cluster routes from cluster user and ip/ports
	let clusterRoutes = [];
	const { hub_routes } = configUtils.getClusteringRoutes();
	if (!hdbUtils.isEmptyOrZeroLength(hub_routes)) {
		for (const route of hub_routes) {
			clusterRoutes.push(
				`tls://${cluster_user.sys_name_encoded}:${cluster_user.uri_encoded_d_hash}@${route.host}:${route.port}`
			);
		}
	}

	// Create hub server json and write to file
	const hubConfig = new HubConfigObject(
		configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT),
		CLUSTERING_NODENAME,
		HUB_PID_FILE_PATH,
		CERT_FILE,
		KEY_FILE,
		CA_FILE,
		INSECURE,
		VERIFY,
		CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT,
		configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME),
		configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT),
		clusterRoutes,
		sysUsers,
		hdbUsers
	);

	if (CA_FILE == null) {
		delete hubConfig.tls.ca_file;
		delete hubConfig.leafnodes.tls.ca_file;
	}

	processName = hdbUtils.isEmpty(processName) ? undefined : processName.toLowerCase();
	if (processName === undefined || processName === hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase()) {
		await fs.writeJson(HUB_CONFIG_PATH, hubConfig);
		hdbLogger.trace(`Hub server config written to ${HUB_CONFIG_PATH}`);
	}

	const leafnodeRemotesUrlSys = `tls://${cluster_user.sys_name_encoded}:${cluster_user.uri_encoded_d_hash}@0.0.0.0:${CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT}`;

	const leafnodeRemotesUrlHdb = `tls://${cluster_user.uri_encoded_name}:${cluster_user.uri_encoded_d_hash}@0.0.0.0:${CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT}`;

	// Create leaf server config and write to file
	const leafConfig = new LeafConfigObject(
		configUtils.getConfigFromFile(CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT),
		CLUSTERING_NODENAME,
		LEAF_PID_FILE_PATH,
		LEAF_JS_STORE_DIR,
		[leafnodeRemotesUrlSys],
		[leafnodeRemotesUrlHdb],
		sysUsers,
		hdbUsers,
		CERT_FILE,
		KEY_FILE,
		CA_FILE,
		INSECURE
	);

	if (CA_FILE == null) {
		delete leafConfig.tls.ca_file;
	}

	if (processName === undefined || processName === hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase()) {
		await fs.writeJson(LEAF_CONFIG_PATH, leafConfig);
		hdbLogger.trace(`Leaf server config written to ${LEAF_CONFIG_PATH}`);
	}
}

async function isPortAvailable(param) {
	const port = envManager.get(param);
	if (hdbUtils.isEmpty(port)) {
		generateNatsConfigError(`port undefined for '${param}'`);
	}

	if (await hdbUtils.isPortTaken(port)) {
		generateNatsConfigError(
			`'${param}' port '${port}' is is in use by another process, check to see if HarperDB is already running or another process is using this port.`
		);
	}
	return true;
}

function generateNatsConfigError(msg) {
	const errMsg = `Error generating clustering config: ${msg}`;
	hdbLogger.error(errMsg);
	console.error(errMsg);
	process.exit(1);
}

/**
 * Removes a nats server config file after the server using that file is connected.
 * We use plain text passwords in the Nats config files, for this reason we remove the files
 * from disk after the servers have launched.
 * @param processName
 * @returns {Promise<void>}
 */
async function removeNatsConfig(processName) {
	const { port, config_file } = natsUtils.getServerConfig(processName);
	const { username, decrypt_hash } = await user.getClusterUser();

	// This while loop ensures that the nats server is connected before its config file is deleted
	let count = 0;
	let waitTime = 2000;
	while (count < MAX_SERVER_CONNECTION_RETRY) {
		try {
			const serverCon = await natsUtils.createConnection(port, username, decrypt_hash, false);
			if (serverCon.protocol.connected === true) {
				serverCon.close();
				break;
			}
		} catch (err) {
			hdbLogger.trace(`removeNatsConfig waiting for ${processName}. Caught and swallowed error ${err}`);
		}

		count++;
		if (count >= MAX_SERVER_CONNECTION_RETRY) {
			throw new Error(
				`Operations API timed out attempting to connect to ${processName}. This is commonly caused by incorrect clustering config. Check hdb.log for further details.`
			);
		}

		let timeoutTime = waitTime * (count * 2);
		if (timeoutTime > 30000)
			hdbLogger.notify(
				'Operations API waiting for Nats server connection. This could be caused by large Nats streams or incorrect clustering config.'
			);
		await hdbUtils.asyncSetTimeout(timeoutTime);
	}

	// We write a bunch of zeros over the existing config file so that any trace of the previous config is completely removed from disk.
	const stringOfZeros = '0'.repeat(ZERO_WRITE_COUNT);
	const configFilePath = path.join(envManager.get(CONFIG_PARAMS.ROOTPATH), HDB_CLUSTERING_FOLDER, config_file);
	await fs.writeFile(configFilePath, stringOfZeros);
	await fs.remove(configFilePath);
	hdbLogger.notify(processName, 'started.');
}
