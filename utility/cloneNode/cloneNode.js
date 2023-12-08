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
const env_mgr = require('../environment/environmentManager');
const sys_info = require('../environment/systemInformation');
const hdb_log = require('../logging/harper_logger');
const config_utils = require('../../config/configUtils');
const { restart } = require('../../bin/restart');
const stop = require('../../bin/stop');
const hdb_utils = require('../common_utils');
const nats_utils = require('../../server/nats/utility/natsUtils');
const global_schema = require('../globalSchema');
const { isHdbInstalled, main, launch } = require('../../bin/run');
const install = require('../install/installer');
const hdb_terms = require('../hdbTerms');
const { SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME, CONFIG_PARAMS, OPERATIONS_ENUM } = hdb_terms;

const DEFAULT_HDB_PORT = 9925;
const DEFAULT_CLUSTERING_LOG_LEVEL = 'info';
const WAIT_FOR_RESTART_TIME = 10000;
const CLONE_CONFIG_FILE = 'clone-node-config.yaml';
const SYSTEM_TABLES_TO_CLONE = [SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME, SYSTEM_TABLE_NAMES.USER_TABLE_NAME];

const username = process.env.HDB_LEADER_USERNAME;
const password = process.env.HDB_LEADER_PASSWORD;
const leader_url = process.env.HDB_LEADER_URL;
const clustering_host = process.env.HDB_LEADER_CLUSTERING_HOST;
const leader_clustering_port = process.env.HDB_LEADER_CLUSTERING_PORT;
const fully_connected = process.env.HDB_FULLY_CONNECTED === 'true'; // optional var - will connect the clone node to the leader AND all the nodes the leader is connected to
const clone_overtop = process.env.HDB_CLONE_OVERTOP === 'true'; // optional var - will allow clone to work overtop of an existing HDB install

let leader_clustering_enabled;
let clone_node_config;
let leader_config;
let leader_dbs;
let clone_node_name;
let root_path;
let exclude_db;
let excluded_table;
let existing_config;

module.exports = async function cloneNode(background = false) {
	delete process.env.HDB_LEADER_URL;
	const is_hdb_installed = await isHdbInstalled();
	if (!clone_overtop && is_hdb_installed) {
		console.info('HarperDB is already installed, no clone node will be performed');
		return main();
	}

	if (clone_overtop && !is_hdb_installed) {
		console.info('No existing install of HarperDB found, cannot clone overtop');
		return;
	}

	const clone_msg = clone_overtop
		? `Cloning node ${leader_url} overtop of existing HarperDB install`
		: `Cloning node: ${leader_url}`;
	console.info(clone_msg);

	if (clone_overtop) {
		existing_config = config_utils.readConfigFile();
		root_path = existing_config.rootPath;

		await stop();
	} else {
		try {
			root_path = process.env.ROOTPATH ? process.env.ROOTPATH : join(os.homedir(), hdb_terms.HDB_ROOT_DIR_NAME);
		} catch (err) {
			console.error(err);
			throw new Error(`There was an error setting default rootPath. Please set 'rootPath' in clone-node-config.yaml`);
		}
	}

	let clone_config_path;
	try {
		clone_config_path = join(root_path, CLONE_CONFIG_FILE);
		clone_node_config = YAML.parseDocument(fs.readFileSync(clone_config_path, 'utf8'), { simpleKeys: true }).toJSON();
	} catch (err) {
		console.info(clone_config_path + ' not found, using default config values.');
	}

	clone_node_name = clone_node_config?.clustering?.nodeName ?? hri.random();
	leader_config = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_CONFIGURATION });
	leader_config = await JSON.parse(leader_config.body);

	if (process.env.HDB_FETCH === 'true') {
		await cloneTablesFetch();
		// Setting this env var was causing run `npm install` to fail, so deleting it here.
		if (process.env.NODE_TLS_REJECT_UNAUTHORIZED) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	} else {
		await cloneTables();
	}

	if (!clone_overtop) await installHDB();
	await cloneConfig();
	await cloneComponents();
	await clusterTables(background);
	console.info('Successfully cloned node: ' + leader_url);
	if (background) process.exit();
};

async function cloneConfig() {
	console.info('Cloning configuration');
	leader_clustering_enabled = leader_config?.clustering?.enabled;
	let config_update = { [CONFIG_PARAMS.ROOTPATH]: root_path };

	// If clustering is enabled on leader node, clone clustering config
	if (leader_clustering_enabled && clone_node_config?.clustering?.enabled !== false) {
		if (clustering_host == null) throw new Error(`'HDB_LEADER_CLUSTERING_HOST' must be defined`);
		config_update[CONFIG_PARAMS.CLUSTERING_ENABLED] = true;

		const leader_routes = leader_config?.clustering?.hubServer?.cluster?.network?.routes;
		const lead_clustering_port =
			parseInt(leader_clustering_port) || leader_config?.clustering?.hubServer?.cluster?.network?.port;
		config_update[CONFIG_PARAMS.CLUSTERING_USER] = leader_config?.clustering?.user;

		// Add the leader host/port to clone node routes config
		let routes = env_mgr.get(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES);
		Array.isArray(routes)
			? routes.push({ host: clustering_host, port: lead_clustering_port })
			: (routes = [{ host: clustering_host, port: lead_clustering_port }]);

		// If the leader node has routes set in its config, concat them with any routes on clone node.
		if (Array.isArray(leader_routes)) routes = routes.concat(leader_routes);

		config_update[CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES] = routes;
	}

	let exclude_comps = clone_node_config?.componentConfig?.exclude;
	// Convert array of excluded apps to object where app name is key, for easy searching.
	exclude_comps = exclude_comps
		? exclude_comps.reduce((obj, item) => {
				return { ...obj, [item['name']]: true };
		  }, {})
		: [];

	// Get all the comps in the leader config and check if they are in excluded config.
	for (const element in leader_config) {
		if (leader_config[element]?.package && !exclude_comps[element]) {
			// This has to be done separate from other updates because it is adding a new top level config file element
			await config_utils.addConfig(element, leader_config[element]);
		}
	}

	if (clone_node_config?.databases) {
		// This has to be done separate from other updates because it is adding a new top level config file element
		await config_utils.addConfig('databases', leader_config?.schemas);
	}

	// Map any config in clone config to config that exists in harperdb-config and add to config update
	let flat_config;
	if (clone_node_config) flat_config = config_utils.flattenConfig(clone_node_config);
	for (const clone_cfg in flat_config) {
		const config_param = hdb_terms.CONFIG_PARAM_MAP[clone_cfg.toLowerCase()];
		if (config_param) {
			config_update[config_param] = flat_config[clone_cfg];
		}
	}

	if (config_update.rootPath == null) delete config_update.rootPath;
	if (config_update?.clustering_nodeName == null) {
		if (clone_overtop) {
			config_update.clustering_nodeName = existing_config?.clustering?.nodeName ?? clone_node_name;
		} else {
			config_update.clustering_nodeName = clone_node_name;
		}
	}

	hdb_log.info('Cloning config:', config_update);
	if (!_.isEmpty(config_update)) config_utils.updateConfigValue(undefined, undefined, config_update, false, true);
}

async function installHDB() {
	console.info('Clone node installing HarperDB.');
	process.env.TC_AGREEMENT = 'yes';
	process.env.ROOTPATH = root_path;
	if (!username) throw new Error('HDB_LEADER_USERNAME is undefined.');
	process.env.HDB_ADMIN_USERNAME = username;
	if (!password) throw new Error('HDB_LEADER_PASSWORD is undefined.');
	process.env.HDB_ADMIN_PASSWORD = password;
	process.env.OPERATIONSAPI_NETWORK_PORT = clone_node_config?.operationsApi?.network?.port ?? DEFAULT_HDB_PORT;
	process.env.CLUSTERING_NODENAME = clone_node_name;
	process.env.CLUSTERING_LOGLEVEL = clone_node_config?.clustering?.logLevel ?? DEFAULT_CLUSTERING_LOG_LEVEL;

	await install();
}

async function cloneTables() {
	//Clone system database
	console.info('Cloning system database');
	const sys_db_dir = getDbFileDir('system');
	await ensureDir(sys_db_dir);

	const sys_db_file_dir = join(sys_db_dir, 'system.mdb');
	const file_stream = createWriteStream(sys_db_file_dir, { overwrite: true });
	const req = {
		operation: OPERATIONS_ENUM.GET_BACKUP,
		database: 'system',
	};

	if (!clone_overtop) req.tables = SYSTEM_TABLES_TO_CLONE;
	const headers = await leaderHttpStream(req, file_stream);

	// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
	await fs.utimes(sys_db_file_dir, Date.now(), new Date(headers.date));

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

	// Check the leader config for any tables with custom pathing - these cant be cloned
	if (leader_config.schemas) {
		for (const cfg in leader_config.schemas) {
			if (Object.keys(leader_config.schemas[cfg]).includes('tables')) {
				exclude_db[cfg] = true;
				console.info(
					`Excluding database '${cfg}' from clone because leader node has custom pathing configured for one or more of its tables`
				);
			}
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

		let backup_req;
		if (excluded_tables) {
			console.info(`Cloning database: ${db} tables: ${tables_to_clone}`);
			backup_req = { operation: OPERATIONS_ENUM.GET_BACKUP, database: db, tables: tables_to_clone };
		} else {
			console.info(`Cloning database: ${db}`);
			backup_req = { operation: OPERATIONS_ENUM.GET_BACKUP, database: db };
		}

		const db_dir = getDbFileDir(db);
		await ensureDir(db_dir);
		const db_path = join(db_dir, db + '.mdb');
		const table_file_stream = createWriteStream(db_path, { overwrite: true });
		const req_headers = await leaderHttpStream(backup_req, table_file_stream);

		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		await fs.utimes(db_path, Date.now(), new Date(req_headers.date));
	}
}

async function cloneTablesFetch() {
	//Clone system database
	console.info('Cloning system database using fetch');
	const req = {
		operation: OPERATIONS_ENUM.GET_BACKUP,
		database: 'system',
	};

	if (!clone_overtop) req.tables = SYSTEM_TABLES_TO_CLONE;

	const sys_backup = await leaderHttpReqFetch(req, true);

	const sys_db_dir = getDbFileDir('system');
	await ensureDir(sys_db_dir);

	const sys_db_file_dir = join(sys_db_dir, 'system.mdb');
	await pipeline(sys_backup.body, createWriteStream(sys_db_file_dir, { overwrite: true }));

	// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
	await fs.utimes(sys_db_file_dir, Date.now(), new Date(sys_backup.headers.get('date')));

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

	// Check the leader config for any tables with custom pathing - these cant be cloned
	if (leader_config.schemas) {
		for (const cfg in leader_config.schemas) {
			if (Object.keys(leader_config.schemas[cfg]).includes('tables')) {
				exclude_db[cfg] = true;
				console.info(
					`Excluding database '${cfg}' from clone because leader node has custom pathing configured for one or more of its tables`
				);
			}
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

		const db_dir = getDbFileDir(db);
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

function getDbFileDir(db) {
	return (
		(clone_node_config?.databases && clone_node_config?.databases[db]?.path) ||
		(clone_node_config?.storage && clone_node_config?.storage?.path) ||
		join(root_path, 'database')
	);
}

async function cloneComponents() {
	const { deployComponent } = require('../../components/operations');
	let leader_component_files = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_COMPONENTS });
	leader_component_files = await JSON.parse(leader_component_files.body);

	// Loop through the result from get components and build array of comp names to clone
	// excluding any that are set as excluded in clone config.
	let comps_to_clone = [];
	if (leader_component_files.entries.length) {
		for (const comp of leader_component_files.entries) {
			// Ignore any files in root of component dir
			if (!comp.entries) continue;
			let exclude = false;
			if (clone_node_config?.componentConfig?.exclude) {
				for (const exclude_comps of clone_node_config.componentConfig.exclude) {
					if (exclude_comps?.name == null) continue;
					if (exclude_comps.name === comp.name) {
						exclude = true;
						break;
					}
				}
			}
			if (!exclude) comps_to_clone.push(comp.name);
		}

		const skip_node_modules = clone_node_config?.componentConfig?.skipNodeModules !== false;
		for (const comp_clone of comps_to_clone) {
			console.info('Cloning component: ' + comp_clone);
			const comp_pkg = await leaderHttpReq({
				operation: OPERATIONS_ENUM.PACKAGE_COMPONENT,
				project: comp_clone,
				skip_node_modules,
			});
			const { payload } = await JSON.parse(comp_pkg.body);
			await deployComponent({ payload, project: comp_clone });
		}
	}
}

async function clusterTables(background) {
	// If clustering is not enabled on leader do not cluster tables.
	if (!leader_clustering_enabled) return;

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

	console.info('Clustering cloned tables');
	if (background) await hdb_utils.async_set_timeout(2000);
	const subscribe = clone_node_config?.clusteringConfig?.subscribeToLeaderNode !== false;
	const publish = clone_node_config?.clusteringConfig?.publishToLeaderNode !== false;

	await global_schema.setSchemaDataToGlobalAsync();
	const add_node = require('../clustering/addNode');
	let leader_cluster_status = await leaderHttpReq({ operation: OPERATIONS_ENUM.CLUSTER_STATUS });
	leader_cluster_status = await JSON.parse(leader_cluster_status.body);

	const subscriptions = [];
	const sys_db_file_stat = await fs.stat(join(getDbFileDir('system'), 'system.mdb'));
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

	for (const db in leader_dbs) {
		if (leader_dbs[db] === 'excluded') continue;
		const db_file_stat = await fs.stat(join(getDbFileDir(db), db + '.mdb'));
		db_file_stat.mtime.setSeconds(db_file_stat.mtime.getSeconds() - 10);
		for (const table in leader_dbs[db]) {
			if (leader_dbs[db][table] === 'excluded') continue;
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
	if (fully_connected === 'true' && leader_cluster_status.connections.length > 0) {
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
				if (exclude_db[sub.schema] || excluded_table[sub.schema + sub.table]) continue;
				has_connections = true;
				// Set a pub/sub start time 10s in the past of backup timestamp.
				const db_file_stat = await fs.stat(join(getDbFileDir(sub.schema), sub.schema + '.mdb'));
				db_file_stat.mtime.setSeconds(db_file_stat.mtime.getSeconds() - 10);
				sub.start_time = db_file_stat.mtime.toISOString();
				node_con.subscriptions.push(sub);
			}
			config_cluster_cons.push(node_con);
		}

		if (has_connections) {
			// configure_cluster op is used because it can setup subs to multiple nodes in one request
			config_cluster_res = await configure_cluster({
				operation: OPERATIONS_ENUM.CONFIGURE_CLUSTER,
				connections: config_cluster_cons,
			});
			console.info(JSON.stringify(config_cluster_res));
		}
	}
	if (!config_cluster_res) {
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
