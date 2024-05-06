'use strict';

const os = require('os');
const https = require('https');
let http = require('http');
const fs = require('fs-extra');
const YAML = require('yaml');
const hri = require('human-readable-ids').hri;
const { pipeline } = require('stream/promises');
const { createWriteStream, ensureDir } = require('fs-extra');
const { join } = require('path');
const _ = require('lodash');
const minimist = require('minimist');
const path = require('path');
const PropertiesReader = require('properties-reader');
const env_mgr = require('../environment/environmentManager');
const sys_info = require('../environment/systemInformation');
const hdb_log = require('../logging/harper_logger');
const config_utils = require('../../config/configUtils');
const { restart } = require('../../bin/restart');
const hdb_utils = require('../common_utils');
const assignCMDENVVariables = require('../assignCmdEnvVariables');
const nats_utils = require('../../server/nats/utility/natsUtils');
const global_schema = require('../globalSchema');
const { main, launch } = require('../../bin/run');
const { install, updateConfigEnv, setIgnoreExisting } = require('../install/installer');
const mount = require('../mount_hdb');
const hdb_terms = require('../hdbTerms');
const version = require('../../bin/version');
const hdb_info_controller = require('../../dataLayer/hdbInfoController');

const { SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME, CONFIG_PARAMS, OPERATIONS_ENUM } = hdb_terms;
const WAIT_FOR_RESTART_TIME = 10000;
const CLONE_CONFIG_FILE = 'clone-node-config.yaml';
const SYSTEM_TABLES_TO_CLONE = [SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME, SYSTEM_TABLE_NAMES.USER_TABLE_NAME];
const CONFIG_TO_NOT_CLONE = {
	clustering_nodename: true,
	clustering_leafserver_streams_path: true,
	clustering_tls_certificate: true,
	clustering_tls_privatekey: true,
	clustering_tls_certificateauthority: true,
	logging_file: true,
	logging_root: true,
	logging_rotation_path: true,
	operationsapi_network_domainsocket: true,
	operationsapi_tls_certificate: true,
	operationsapi_tls_privatekey: true,
	operationsapi_tls_certificateauthority: true,
	rootpath: true,
	storage_path: true,
	storage_audit_path: true,
	databases: true,
	mqtt_network_mtls_certificateauthority: true,
	componentsroot: true,
	tls_certificate: true,
	tls_privatekey: true,
	tls_certificateauthority: true,
};

const CLONE_VARS = {
	HDB_LEADER_USERNAME: 'HDB_LEADER_USERNAME',
	HDB_LEADER_PASSWORD: 'HDB_LEADER_PASSWORD',
	HDB_LEADER_URL: 'HDB_LEADER_URL',
	HDB_LEADER_CLUSTERING_HOST: 'HDB_LEADER_CLUSTERING_HOST',
	HDB_LEADER_CLUSTERING_PORT: 'HDB_LEADER_CLUSTERING_PORT',
	HDB_CLONE_CLUSTERING_HOST: 'HDB_CLONE_CLUSTERING_HOST',
	HDB_FULLY_CONNECTED: 'HDB_FULLY_CONNECTED',
	HDB_CLONE_OVERTOP: 'HDB_CLONE_OVERTOP',
	CLUSTERING_NODENAME: 'CLUSTERING_NODENAME',
};

const cli_args = minimist(process.argv);
const username = cli_args[CLONE_VARS.HDB_LEADER_USERNAME] ?? process.env[CLONE_VARS.HDB_LEADER_USERNAME];
const password = cli_args[CLONE_VARS.HDB_LEADER_PASSWORD] ?? process.env[CLONE_VARS.HDB_LEADER_PASSWORD];
const leader_url = cli_args[CLONE_VARS.HDB_LEADER_URL] ?? process.env[CLONE_VARS.HDB_LEADER_URL];
const clustering_host =
	cli_args[CLONE_VARS.HDB_LEADER_CLUSTERING_HOST] ?? process.env[CLONE_VARS.HDB_LEADER_CLUSTERING_HOST];
let clone_clustering_host =
	cli_args[CLONE_VARS.HDB_CLONE_CLUSTERING_HOST] ?? process.env[CLONE_VARS.HDB_CLONE_CLUSTERING_HOST];
let fully_connected =
	(cli_args[CLONE_VARS.HDB_FULLY_CONNECTED] ?? process.env[CLONE_VARS.HDB_FULLY_CONNECTED]) === 'true'; // optional var - will connect the clone node to the leader AND all the nodes the leader is connected to
const clone_overtop = (cli_args[CLONE_VARS.HDB_CLONE_OVERTOP] ?? process.env[CLONE_VARS.HDB_CLONE_OVERTOP]) === 'true'; // optional var - will allow clone to work overtop of an existing HDB install
const nodename_arg = cli_args[CLONE_VARS.CLUSTERING_NODENAME] ?? process.env[CLONE_VARS.CLUSTERING_NODENAME];
const cloned_var = cli_args[CONFIG_PARAMS.CLONED.toUpperCase()] ?? process.env[CONFIG_PARAMS.CLONED.toUpperCase()];

let leader_clustering_enabled;
let clone_node_config;
let hdb_config = {};
let hdb_config_json;
let leader_config;
let leader_config_flat = {};
let leader_dbs;
let clone_node_name;
let root_path;
let exclude_db;
let excluded_table;
let fresh_clone = false;
let sys_db_exist = false;

/**
 * This module will run when HarperDB is started with the required env/cli vars.
 * Any config, databases and replication that doesn't already exist on this node will be cloned from the leader node
 * @param background
 * @returns {Promise<void>}
 */
module.exports = async function cloneNode(background = false) {
	console.info(`Starting clone node form leader node: ${leader_url}`);
	delete process.env.HDB_LEADER_URL;

	root_path = hdb_utils.getEnvCliRootPath();
	if (!root_path) {
		try {
			const boot_props_file_path = join(os.homedir(), hdb_terms.HDB_HOME_DIR_NAME, hdb_terms.BOOT_PROPS_FILE_NAME);
			if (await fs.pathExists(boot_props_file_path)) {
				const hdb_properties = PropertiesReader(boot_props_file_path);
				root_path = path.parse(hdb_properties.get(hdb_terms.BOOT_PROP_PARAMS.SETTINGS_PATH_KEY)).dir;
			}
		} catch (err) {
			throw new Error(
				`There was an error setting the clone default root path. Please set ROOTPATH using an environment or CLI variable.`
			);
		}
	}

	if (!root_path) {
		console.log(`No HarperDB install found, starting fresh clone`);
		fresh_clone = true;
	} else if (await fs.pathExists(root_path)) {
		console.log(
			`Existing HarperDB install found at ${root_path}. Clone node will only clone items that do not already exist on clone.`
		);
	} else {
		console.log(`No HarperDB install found at ${root_path} starting fresh clone`);
		fresh_clone = true;
	}

	if (!root_path) {
		root_path = join(os.homedir(), hdb_terms.HDB_ROOT_DIR_NAME);
		console.log('Using default root path', root_path);
	}

	let clone_config_path;
	try {
		clone_config_path = join(root_path, CLONE_CONFIG_FILE);
		clone_node_config = YAML.parseDocument(await fs.readFile(clone_config_path, 'utf8'), { simpleKeys: true }).toJSON();
		console.log('Clone config file found');
	} catch (err) {}

	const hdb_config_path = join(root_path, hdb_terms.HDB_CONFIG_FILE);

	if (await fs.pathExists(hdb_config_path)) {
		try {
			hdb_config_json = YAML.parseDocument(await fs.readFile(hdb_config_path, 'utf8'), { simpleKeys: true }).toJSON();
			hdb_config = config_utils.flattenConfig(hdb_config_json);
		} catch (err) {
			console.error('Error reading existing harperdb-config.yaml on clone', err);
		}
	}

	if (hdb_config?.cloned && cloned_var !== 'false') {
		console.log('Instance marked as cloned, clone will not run');
		env_mgr.setCloneVar(false);
		env_mgr.initSync();
		return main();
	}

	if (nodename_arg) {
		clone_node_name = nodename_arg;
	} else if (hdb_config[hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME.toLowerCase()]) {
		clone_node_name = hdb_config[hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME.toLowerCase()];
	} else {
		clone_node_name = clone_node_config?.clustering?.nodeName ?? hri.random();
	}

	await cloneConfig();
	env_mgr.setCloneVar(false);
	env_mgr.setHdbBasePath(root_path);

	fs.ensureDir(env_mgr.get(hdb_terms.CONFIG_PARAMS.LOGGING_ROOT));
	hdb_log.initLogSettings();

	await cloneDatabases();

	// Only call install if a fresh sys DB was added
	if (!sys_db_exist) await installHDB();
	await startHDB(background);

	// If clustering is not enabled on leader do not cluster tables.
	if (leader_clustering_enabled && clustering_host) {
		await clusterTables();
	}

	console.info('\nSuccessfully cloned node: ' + leader_url);
	if (background) process.exit();
};

/**
 * Clone config from leader except for any existing config or any excluded config (mainly path related values)
 * @returns {Promise<void>}
 */
async function cloneConfig() {
	console.info('Cloning configuration');
	leader_config = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_CONFIGURATION });
	leader_config = await JSON.parse(leader_config.body);
	leader_clustering_enabled = leader_config?.clustering?.enabled;
	leader_config_flat = config_utils.flattenConfig(leader_config);
	const leader_clustering_port = leader_config?.clustering?.hubServer?.cluster?.network?.port;
	const exclude_comps = clone_node_config?.componentConfig?.exclude;
	const config_update = {
		cloned: true,
		clustering_nodename: clone_node_name,
		rootpath: root_path,
	};

	for (const name in leader_config_flat) {
		if (
			(leader_config_flat[name] !== null &&
				typeof leader_config_flat[name] === 'object' &&
				!(leader_config_flat[name] instanceof Array)) ||
			CONFIG_TO_NOT_CLONE[name]
		)
			continue;

		if (name.includes('_package') || name.includes('_port')) {
			// This is here to stop local leader component config from being cloned
			if (leader_config_flat[name]?.includes?.('hdb/components')) continue;

			if (exclude_comps) {
				let excluded_comp = false;
				for (const comp of exclude_comps) {
					if (name.includes(comp.name)) {
						excluded_comp = true;
						break;
					}
				}
				if (excluded_comp) continue;
			}
		}

		// If there is no routes config on clone node, get leader routes, append leader host to them and add to clone config
		if (!hdb_config[name]) {
			if (name === 'clustering_hubserver_cluster_network_routes' && clustering_host && leader_clustering_port) {
				if (!Array.isArray(leader_config_flat[name])) leader_config_flat[name] = [];
				leader_config_flat[name].push({ host: clustering_host, port: leader_clustering_port });
			}
			config_update[name] = leader_config_flat[name];
		}
	}

	for (const name in hdb_config) {
		if (name !== 'databases' && typeof hdb_config[name] === 'object' && !(hdb_config[name] instanceof Array)) continue;
		config_update[name] = hdb_config[name];
	}

	const args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	Object.assign(config_update, args);

	config_utils.createConfigFile(config_update, true);
	env_mgr.initSync(true);

	// Add this node's route to the leader node
	if (leader_clustering_enabled && clustering_host && clone_clustering_host) {
		const route = {
			host: clone_clustering_host,
			port: env_mgr.get(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT),
		};
		console.log('Setting clustering route on leader:', route);
		await leaderHttpReq({
			operation: 'cluster_set_routes',
			server: 'hub',
			routes: [route],
		});
	}
}

/**
 * Clone any database that don't already exist on this node
 * @returns {Promise<void>}
 */
async function cloneDatabases() {
	if (process.env.HDB_FETCH === 'true') {
		await cloneTablesFetch();
		// Setting this env var was causing run `npm install` to fail, so deleting it here.
		if (process.env.NODE_TLS_REJECT_UNAUTHORIZED) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	} else {
		await cloneTablesHttp();
	}
}

/**
 * Installs HDB (if it isn't already installed) overtop of any existing cloned config & database
 * @returns {Promise<void>}
 */
async function installHDB() {
	console.info('Clone node installing HarperDB.');
	process.env.TC_AGREEMENT = 'yes';
	process.env.ROOTPATH = root_path;
	if (!username) throw new Error('HDB_LEADER_USERNAME is undefined.');
	process.env.HDB_ADMIN_USERNAME = username;
	if (!password) throw new Error('HDB_LEADER_PASSWORD is undefined.');
	process.env.HDB_ADMIN_PASSWORD = password;
	process.env.OPERATIONSAPI_NETWORK_PORT = env_mgr.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
	updateConfigEnv(path.join(root_path, hdb_terms.HDB_CONFIG_FILE));

	setIgnoreExisting(true);

	await install();
}

function getDBPath(db) {
	const db_config = env_mgr.get(hdb_terms.CONFIG_PARAMS.DATABASES)?.[db];
	return (
		db_config?.path || env_mgr.get(CONFIG_PARAMS.STORAGE_PATH) || path.join(root_path, hdb_terms.DATABASES_DIR_NAME)
	);
}

async function cloneTablesHttp() {
	// If this is a fresh clone or there is no system.mdb file clone users/roles system tables
	const system_db_dir = getDBPath('system');
	const sys_db_file_dir = join(system_db_dir, 'system.mdb');
	if (fresh_clone || !(await fs.exists(sys_db_file_dir)) || clone_overtop) {
		console.info('Cloning system database');
		await ensureDir(system_db_dir);
		const file_stream = createWriteStream(sys_db_file_dir, { overwrite: true });
		const req = {
			operation: OPERATIONS_ENUM.GET_BACKUP,
			database: 'system',
			tables: SYSTEM_TABLES_TO_CLONE,
		};

		const headers = await leaderHttpStream(req, file_stream);
		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		await fs.utimes(sys_db_file_dir, Date.now(), new Date(headers.date));

		if (!fresh_clone) {
			await mount(root_path);
			await insertHdbVersionInfo();
			setIgnoreExisting(true);
		}
	} else {
		sys_db_exist = true;
		console.log(`Not cloning system database due to it already existing on clone`);
	}

	// Get all the non-system db/table from leader node
	leader_dbs = await leaderHttpReq({ operation: OPERATIONS_ENUM.DESCRIBE_ALL });
	leader_dbs = await JSON.parse(leader_dbs.body);

	// Create object where excluded db name is key
	exclude_db = clone_node_config?.databaseConfig?.excludeDatabases;
	exclude_db = exclude_db
		? exclude_db.reduce((obj, item) => {
				return { ...obj, [item['database']]: true };
		  }, {})
		: {};

	// Check to see if DB already on clone, if it is we dont clone it
	for (const db in leader_dbs) {
		if (await fs.exists(path.join(getDBPath(db), db + '.mdb'))) {
			console.log(`Not cloning database ${db} due to it already existing on clone`);
			exclude_db[db] = true;
		}
	}

	// Build excluded table object where key is db + table
	excluded_table = clone_node_config?.databaseConfig?.excludeTables;
	excluded_table = excluded_table
		? excluded_table.reduce((obj, item) => {
				return { ...obj, [item['database'] == null ? null : item['database'] + item['table']]: true };
		  }, {})
		: {};

	for (const db in leader_dbs) {
		if (exclude_db[db]) {
			leader_dbs[db] = 'excluded';
			continue;
		}
		if (_.isEmpty(leader_dbs[db])) continue;
		let tables_to_clone = [];
		let excluded_tables = false;
		for (const table in leader_dbs[db]) {
			if (excluded_table[db + table]) {
				excluded_tables = true;
				leader_dbs[db][table] = 'excluded';
			} else {
				tables_to_clone.push(table);
			}
		}

		if (tables_to_clone.length === 0) return;

		let backup_req;
		if (excluded_tables) {
			console.info(`Cloning database: ${db} tables: ${tables_to_clone}`);
			backup_req = { operation: OPERATIONS_ENUM.GET_BACKUP, database: db, tables: tables_to_clone };
		} else {
			console.info(`Cloning database: ${db}`);
			backup_req = { operation: OPERATIONS_ENUM.GET_BACKUP, database: db };
		}

		const db_dir = getDBPath(db);
		await ensureDir(db_dir);
		const db_path = join(db_dir, db + '.mdb');
		const table_file_stream = createWriteStream(db_path, { overwrite: true });
		const req_headers = await leaderHttpStream(backup_req, table_file_stream);

		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		await fs.utimes(db_path, Date.now(), new Date(req_headers.date));
	}
}

async function cloneTablesFetch() {
	// If this is a fresh clone or there is no system.mdb file clone users/roles system tables
	const system_db_dir = getDBPath('system');
	const sys_db_file_dir = join(system_db_dir, 'system.mdb');
	if (fresh_clone || !(await fs.exists(sys_db_file_dir)) || clone_overtop) {
		console.info('Cloning system database using fetch');
		const req = {
			operation: OPERATIONS_ENUM.GET_BACKUP,
			database: 'system',
			tables: SYSTEM_TABLES_TO_CLONE,
		};

		const sys_backup = await leaderHttpReqFetch(req, true);
		const sys_db_dir = getDBPath('system');
		await ensureDir(sys_db_dir);
		const sys_db_file_dir = join(sys_db_dir, 'system.mdb');
		await pipeline(sys_backup.body, createWriteStream(sys_db_file_dir, { overwrite: true }));

		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		await fs.utimes(sys_db_file_dir, Date.now(), new Date(sys_backup.headers.get('date')));

		if (!fresh_clone) {
			await mount(root_path);
			await insertHdbVersionInfo();
			setIgnoreExisting(true);
		}
	} else {
		sys_db_exist = true;
		console.log(`Not cloning system database due to it already existing on clone`);
	}

	// Get all the non-system db/table from leader node
	leader_dbs = await leaderHttpReqFetch({ operation: OPERATIONS_ENUM.DESCRIBE_ALL });
	leader_dbs = await leader_dbs.json();

	// Create object where excluded db name is key
	exclude_db = clone_node_config?.databaseConfig?.excludeDatabases;
	exclude_db = exclude_db
		? exclude_db.reduce((obj, item) => {
				return { ...obj, [item['database']]: true };
		  }, {})
		: {};

	// Check to see if DB already on clone, if it is we dont clone it
	for (const db in leader_dbs) {
		if (await fs.exists(path.join(getDBPath(db), db + '.mdb'))) {
			console.log(`Not cloning database ${db} due to it already existing on clone`);
			exclude_db[db] = true;
		}
	}

	// Build excluded table object where key is db + table
	excluded_table = clone_node_config?.databaseConfig?.excludeTables;
	excluded_table = excluded_table
		? excluded_table.reduce((obj, item) => {
				return { ...obj, [item['database'] == null ? null : item['database'] + item['table']]: true };
		  }, {})
		: {};

	for (const db in leader_dbs) {
		if (exclude_db[db]) {
			leader_dbs[db] = 'excluded';
			continue;
		}
		if (_.isEmpty(leader_dbs[db])) continue;
		let tables_to_clone = [];
		let excluded_tables = false;
		for (const table in leader_dbs[db]) {
			if (excluded_table[db + table]) {
				excluded_tables = true;
				leader_dbs[db][table] = 'excluded';
			} else {
				tables_to_clone.push(table);
			}
		}

		if (tables_to_clone.length === 0) return;

		let backup;
		if (excluded_tables) {
			console.info(`Cloning database: ${db} tables: ${tables_to_clone}`);
			backup = await leaderHttpReqFetch(
				{ operation: OPERATIONS_ENUM.GET_BACKUP, database: db, tables: tables_to_clone },
				true
			);
		} else {
			console.info(`Cloning database: ${db}`);
			backup = await leaderHttpReqFetch({ operation: OPERATIONS_ENUM.GET_BACKUP, database: db }, true);
		}

		const db_dir = getDBPath(db);
		await ensureDir(db_dir);
		const backup_date = new Date(backup.headers.get('date'));

		// Stream the backup to a file with temp name consisting of <timestamp>-<table name>, this is done so that if clone
		// fails during this step half cloned db files can easily be identified.
		const temp_db_path = join(db_dir, `${backup_date.getTime()}-${db}.mdb`);
		await pipeline(backup.body, createWriteStream(temp_db_path, { overwrite: true }));

		// Once the clone of a db file is completed it is renamed to its permanent name
		const db_path = join(db_dir, db + '.mdb');
		await fs.rename(temp_db_path, db_path);

		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		await fs.utimes(db_path, Date.now(), backup_date);
	}
}

async function leaderHttpReqFetch(req, get_backup = false) {
	const reject_unauth = clone_node_config?.httpsRejectUnauthorized ?? false;
	const https_agent = new https.Agent({
		rejectUnauthorized: reject_unauth,
	});

	if (!reject_unauth) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

	const auth = Buffer.from(username + ':' + password).toString('base64');
	const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' };
	if (get_backup) {
		headers['Accept-Encoding'] = 'gzip';
	}

	const response = await fetch(leader_url, {
		method: 'POST',
		headers,
		body: JSON.stringify(req),
		agent: https_agent,
		compress: true,
	});

	if (response.ok) return response;
	console.error(`HTTP Error Response: ${response.status} ${response.statusText}`);
	throw new Error(await response.text());
}

async function startHDB(background) {
	const hdb_proc = await sys_info.getHDBProcessInfo();
	if (hdb_proc.clustering.length === 0 || hdb_proc.core.length === 0) {
		if (background) {
			await launch(false);
		} else {
			await main();
		}
	} else {
		console.info(await restart({ operation: OPERATIONS_ENUM.RESTART }));
		await hdb_utils.async_set_timeout(WAIT_FOR_RESTART_TIME);
	}
	if (background) await hdb_utils.async_set_timeout(2000);
}

/**
 * Setup replication between this node and the leader, or if fully connected cli/env passed
 * setup replication between this node, the leader and any nodes the leader is replicating to.
 * @returns {Promise<void>}
 */
async function clusterTables() {
	console.info('Clustering cloned tables');
	const subscribe = clone_node_config?.clusteringConfig?.subscribeToLeaderNode !== false;
	const publish = clone_node_config?.clusteringConfig?.publishToLeaderNode !== false;

	await global_schema.setSchemaDataToGlobalAsync();
	const add_node = require('../clustering/addNode');
	let leader_cluster_status = await leaderHttpReq({ operation: OPERATIONS_ENUM.CLUSTER_STATUS });
	leader_cluster_status = await JSON.parse(leader_cluster_status.body);

	const subscriptions = [];
	if (!sys_db_exist) {
		const sys_db_file_stat = await fs.stat(join(getDBPath('system'), 'system.mdb'));
		// Setup cloning on some system tables
		for (const sys_table of SYSTEM_TABLES_TO_CLONE) {
			subscriptions.push({
				schema: SYSTEM_SCHEMA_NAME,
				table: sys_table,
				subscribe,
				publish,
				start_time: sys_db_file_stat.mtime.toISOString(),
			});
		}
	}

	// Create object where excluded db name is key
	let exclude_db_replication = clone_node_config?.clusteringConfig?.excludeDatabases;
	exclude_db_replication = exclude_db_replication
		? exclude_db_replication.reduce((obj, item) => {
				return { ...obj, [item['database']]: true };
		  }, {})
		: {};

	// Build excluded table object where key is db + table
	let exclude_table_replication = clone_node_config?.clusteringConfig?.excludeTables;
	exclude_table_replication = exclude_table_replication
		? exclude_table_replication.reduce((obj, item) => {
				return { ...obj, [item['database'] == null ? null : item['database'] + item['table']]: true };
		  }, {})
		: {};

	for (const db in leader_dbs) {
		if (leader_dbs[db] === 'excluded' || exclude_db_replication[db]) continue;
		const db_file_stat = await fs.stat(join(getDBPath(db), db + '.mdb'));
		db_file_stat.mtime.setSeconds(db_file_stat.mtime.getSeconds() - 10);
		for (const table in leader_dbs[db]) {
			if (leader_dbs[db][table] === 'excluded' || exclude_table_replication[db + table]) continue;
			subscriptions.push({
				schema: db,
				table,
				subscribe,
				publish,
				start_time: db_file_stat.mtime.toISOString(),
			});
		}
	}

	await nats_utils.createTableStreams(subscriptions);

	hdb_log.info(
		'Sending add_node request to node:',
		leader_config?.clustering?.nodeName,
		'with subscriptions:',
		subscriptions
	);
	let config_cluster_res;
	if (fully_connected && leader_cluster_status.connections.length > 0) {
		// Fully connected logic
		const configure_cluster = require('../clustering/configureCluster');
		const config_cluster_cons = [
			{
				node_name: leader_config?.clustering?.nodeName,
				subscriptions,
			},
		];
		let has_connections = false;
		clone_node_name = env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);
		// For all the connections in the leader nodes cluster status create a connection to clone node
		for (const node of leader_cluster_status.connections) {
			// in case this node is already in the connections, we can skip ourself
			if (node.node_name === clone_node_name) continue;
			const node_con = {
				node_name: node.node_name,
				subscriptions: [],
			};

			// Build a connection object for all nodes getting connected to
			for (const sub of node.subscriptions) {
				// Honor any exclude config
				if (
					exclude_db[sub.schema] ||
					excluded_table[sub.schema + sub.table] ||
					exclude_db_replication[sub.schema] ||
					exclude_table_replication[sub.schema + sub.table]
				)
					continue;
				has_connections = true;
				// Set a pub/sub start time 10s in the past of backup timestamp.
				const db_file_stat = await fs.stat(join(getDBPath(sub.schema), sub.schema + '.mdb'));
				db_file_stat.mtime.setSeconds(db_file_stat.mtime.getSeconds() - 10);
				sub.start_time = db_file_stat.mtime.toISOString();
				node_con.subscriptions.push(sub);
			}
			config_cluster_cons.push(node_con);
		}

		if (has_connections) {
			//configure_cluster op is used because it can setup subs to multiple nodes in one request
			config_cluster_res = await configure_cluster({
				operation: OPERATIONS_ENUM.CONFIGURE_CLUSTER,
				connections: config_cluster_cons,
			});
			console.info(JSON.stringify(config_cluster_res));
		}
	}
	if (!config_cluster_res && subscriptions.length > 0) {
		await add_node(
			{
				operation: OPERATIONS_ENUM.ADD_NODE,
				node_name: leader_config?.clustering?.nodeName,
				subscriptions,
			},
			true
		);
	}

	await nats_utils.closeConnection();
}

async function leaderHttpReq(req) {
	const https_agent = new https.Agent({
		rejectUnauthorized: clone_node_config?.httpsRejectUnauthorized ?? false,
	});

	const auth = Buffer.from(username + ':' + password).toString('base64');
	const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' };
	const url = new URL(leader_url);
	const options = {
		protocol: url.protocol,
		host: url.hostname,
		method: 'POST',
		headers,
	};

	if (url.protocol === 'https:') options.agent = https_agent;
	if (url.port) options.port = url.port;
	return await hdb_utils.httpRequest(options, req);
}

async function leaderHttpStream(data, stream) {
	const https_agent = new https.Agent({
		rejectUnauthorized: clone_node_config?.httpsRejectUnauthorized ?? false,
	});

	const auth = Buffer.from(username + ':' + password).toString('base64');
	const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' };
	const url = new URL(leader_url);
	const options = {
		protocol: url.protocol,
		host: url.hostname,
		method: 'POST',
		headers,
	};

	if (url.protocol === 'https:') {
		options.agent = https_agent;
		http = https;
	}
	if (url.port) options.port = url.port;

	return new Promise((resolve, reject) => {
		const req = http.request(options, (res) => {
			if (res.statusCode !== 200) {
				reject('Request to leader node failed with code: ' + res.statusCode);
			}

			res.pipe(stream);
			res.on('end', () => {
				stream.close();
				resolve(res.headers);
			});
		});

		req.on('error', (err) => {
			reject(err);
		});

		req.write(JSON.stringify(data));
		req.end();
	});
}

async function insertHdbVersionInfo() {
	const vers = version.version();
	if (vers) {
		await hdb_info_controller.insertHdbInstallInfo(vers);
	} else {
		throw new Error('The version is missing/removed from HarperDB package.json');
	}
}
