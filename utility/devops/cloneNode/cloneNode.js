'use strict';

const os = require('os');
const fetch = require('node-fetch');
const https = require('https');
const fs = require('fs-extra');
const YAML = require('yaml');
const hri = require('human-readable-ids').hri;
const { pipeline } = require('stream/promises');
const { createWriteStream, ensureDir } = require('fs-extra');
const { join } = require('path');
const _ = require('lodash');
const { openEnvironment } = require('../../lmdb/environmentUtility');
const { statDBI } = require('../../lmdb/environmentUtility');
const env_mgr = require('../../environment/environmentManager');
const sys_info = require('../../environment/systemInformation');
const hdb_log = require('../../logging/harper_logger');
const config_utils = require('../../../config/configUtils');
const { restart } = require('../../../bin/restart');
const hdb_utils = require('../../common_utils');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const global_schema = require('../../globalSchema');
const { isHdbInstalled, main } = require('../../../bin/run');
const install = require('../../install/installer');
const {
	getSchemaPath,
	getSystemSchemaPath,
} = require('../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');
const hdb_terms = require('../../hdbTerms');
const { SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME, CONFIG_PARAMS, OPERATIONS_ENUM } = hdb_terms;

const DEFAULT_ROOTPATH = join(os.homedir(), hdb_terms.HDB_ROOT_DIR_NAME);
const DEFAULT_HDB_PORT = 9925;
const WAIT_FOR_RESTART_TIME = 10000;
const CLONE_CONFIG_PATH = join(__dirname, 'clone-node-config.yaml');
const SYSTEM_TABLES_TO_CLONE = [
	SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
	SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME,
	SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
	SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
	SYSTEM_TABLE_NAMES.USER_TABLE_NAME,
];

const username = process.env.HDB_LEADER_USERNAME;
const password = process.env.HDB_LEADER_PASSWORD;
const url = process.env.HDB_LEADER_URL;
const clustering_host = process.env.HDB_LEADER_CLUSTERING_HOST;

let leader_clustering_enabled;
let clone_node_config;
let leader_config;
let leader_schemas;

async function cloneNode() {
	console.info('Cloning node: ' + url);
	try {
		clone_node_config = YAML.parseDocument(fs.readFileSync(CLONE_CONFIG_PATH, 'utf8'), { simpleKeys: true }).toJSON();
	} catch (err) {
		console.info(CLONE_CONFIG_PATH + ' not found, using default config values.');
	}

	await installHDB();
	await cloneTables();
	// await cloneConfig();
	// await cloneComponents();
	// await clusterTables();
	console.info('Successfully cloned node: ' + url);
}

async function installHDB() {
	if (await isHdbInstalled()) {
		console.info('Install of HarperDB found on clone node.');
		return;
	}
	console.info('Clone node installing HarperDB.');
	process.env.TC_AGREEMENT = 'yes';
	process.env.ROOTPATH = clone_node_config?.rootPath ?? DEFAULT_ROOTPATH;
	if (!username) throw new Error('HDB_LEADER_USERNAME is undefined.');
	process.env.HDB_ADMIN_USERNAME = username;
	if (!password) throw new Error('HDB_LEADER_PASSWORD is undefined.');
	process.env.HDB_ADMIN_PASSWORD = password;
	process.env.OPERATIONSAPI_NETWORK_PORT = clone_node_config?.operationsApi?.network?.port ?? DEFAULT_HDB_PORT;
	process.env.CLUSTERING_NODENAME = clone_node_config?.clustering?.nodeName ?? hri.random();
	process.env.CLUSTERING_LOGLEVEL = 'info';

	await install();
}

async function cloneTables() {
	// Get all the non-system schema/table from leader node
	leader_schemas = await leaderHttpReq({ operation: OPERATIONS_ENUM.DESCRIBE_ALL });
	leader_schemas = await leader_schemas.json();

	// If there is excludeSchemas in clone config search for value in leader schema description and delete if found, so it's not cloned.
	if (clone_node_config?.database?.excludeDatabases) {
		for (const exclude_schema of clone_node_config.database.excludeDatabases) {
			if (exclude_schema?.schema == null) continue;
			if (leader_schemas[exclude_schema?.schema]) {
				hdb_log.info('Excluding schema:', exclude_schema.schema);
				delete leader_schemas[exclude_schema.schema];
			}
		}
	}

	// If there is excludeTables in clone config search for value in leader schema description and delete if found, so it's not cloned.
	if (clone_node_config?.database?.excludeTables) {
		for (const exclude_table of clone_node_config.database.excludeTables) {
			if (exclude_table?.database == null) continue;
			if (leader_schemas[exclude_table?.database]?.[exclude_table?.table]) {
				hdb_log.info(`Excluding schema.table: ${exclude_table.database}.${exclude_table.table}`);
				delete leader_schemas[exclude_table.database][exclude_table.table];
			}
		}
	}

	// Clone system database
	console.info('Cloning system database');
	const sys_backup = await leaderHttpReq(
		{
			operation: OPERATIONS_ENUM.GET_BACKUP,
			database: 'system',
		},
		true
	);

	const sys_schema_path = getSystemSchemaPath();
	await ensureDir(sys_schema_path);
	const sys_db_path = join(sys_schema_path, 'system.mdb');
	await pipeline(sys_backup.body, createWriteStream(sys_db_path, { overwrite: true }));

	// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
	await fs.utimes(sys_db_path, Date.now(), new Date(sys_backup.headers.get('date')));

	/*	// The describe_all req to the leader node won't return system tables, for that reason they are handled separately.
	for (const sys_table of SYSTEM_TABLES_TO_CLONE) {
		console.info('Cloning system table: ' + sys_table);
		const sys_backup = await leaderHttpReq(
			{
				operation: OPERATIONS_ENUM.GET_BACKUP,
				database: ,
				table: sys_table,
			},
			true
		);
		const sys_schema_path = getSystemSchemaPath();
		await ensureDir(sys_schema_path);
		const sys_db_path = join(sys_schema_path, sys_table + '.mdb');
		await pipeline(sys_backup.body, createWriteStream(sys_db_path, { overwrite: true }));

		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		await fs.utimes(sys_db_path, Date.now(), new Date(sys_backup.headers.get('date')));
	}*/

	for (const schema in leader_schemas) {
		for (const table in leader_schemas[schema]) {
			console.info(`Cloning schema.table: ${schema}.${table}`);
			const primary_key = leader_schemas[schema][table]['hash_attribute'];
			const leader_record_count = leader_schemas[schema][table]['record_count'];

			// Stream table backup from leader node to clone node.
			const backup = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_BACKUP, schema, table }, true);
			const schema_path = getSchemaPath(schema, table);
			await ensureDir(schema_path);
			const backup_date = new Date(backup.headers.get('date'));

			// Stream the backup to a file with temp name consisting of <timestamp>-<table name>, this is done so that if clone
			// fails during this step half cloned db files can easily be identified.
			const temp_db_path = join(schema_path, `${backup_date.getTime()}-${table}.mdb`);
			await pipeline(backup.body, createWriteStream(temp_db_path, { overwrite: true }));

			// Once the clone of a db file is completed it is renamed to its permanent name
			const db_path = join(schema_path, table + '.mdb');
			await fs.rename(temp_db_path, db_path);

			// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
			await fs.utimes(db_path, Date.now(), backup_date);

			// Open the backup table and get its entry count to confirm record counts closely match.
			const env = await openEnvironment(schema_path, table);
			const dbi_stat = statDBI(env, primary_key);
			const record_count = dbi_stat.entryCount;

			// We allow for a 5% difference in count to account for any changes on leader after taking backup snapshot.
			if (
				leader_record_count !== 0 &&
				leader_record_count <= record_count * 0.95 &&
				leader_record_count >= record_count * 1.05
			) {
				throw new Error(
					`Something has gone wrong. The record count for leader table '${table}' is inconsistent with the record count on clone node. 
					Leader node record count: ${leader_record_count}. Clone node record count: ${record_count}`
				);
			}
		}
	}
}
async function cloneComponents() {
	const { deployComponent } = require('../../../components/operations');
	let leader_component_files = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_COMPONENT_FILES });
	leader_component_files = await leader_component_files.json();

	// Loop through the result from get components and build array of comp names to clone
	// excluding any that are set as excluded in clone config.
	let comps_to_clone = [];
	if (leader_component_files.entries.length) {
		for (const comp of leader_component_files.entries) {
			// Ignore any files in root of component dir
			if (!comp.entries) continue;
			let exclude = false;
			if (clone_node_config?.components?.exclude) {
				for (const exclude_comps of clone_node_config.components.exclude) {
					if (exclude_comps?.name == null) continue;
					if (exclude_comps.name === comp.name) {
						exclude = true;
						break;
					}
				}
			}
			if (!exclude) comps_to_clone.push(comp.name);
		}

		const skip_node_modules = clone_node_config?.apps?.skipNodeModules !== false;
		for (const comp_clone of comps_to_clone) {
			console.info('Cloning component: ' + comp_clone);
			const comp_pkg = await leaderHttpReq({
				operation: OPERATIONS_ENUM.PACKAGE_COMPONENT,
				project: comp_clone,
				skip_node_modules,
			});
			const { payload } = await comp_pkg.json();
			await deployComponent({ payload, project: comp_clone });
		}
	}
}

async function clusterTables() {
	// If clustering is not enabled on leader do not cluster tables.
	if (!leader_clustering_enabled) return;

	const hdb_proc = await sys_info.getHDBProcessInfo();
	if (hdb_proc.clustering.length === 0 || hdb_proc.core.length === 0) {
		await main();
	} else {
		console.info(await restart({ operation: OPERATIONS_ENUM.RESTART }));
	}
	await hdb_utils.async_set_timeout(WAIT_FOR_RESTART_TIME);

	console.info('Clustering cloned tables');
	const subscribe = clone_node_config?.clustering?.subscribeToLeaderNode !== false;
	const publish = clone_node_config?.clustering?.publishToLeaderNode !== false;

	await global_schema.setSchemaDataToGlobalAsync();
	const add_node = require('../../clustering/addNode');

	const subscriptions = [];
	const sys_schema_path = getSystemSchemaPath();
	for (const sys_table of SYSTEM_TABLES_TO_CLONE) {
		const db_file_stat = await fs.stat(join(sys_schema_path, sys_table + '.mdb'));
		subscriptions.push({
			schema: SYSTEM_SCHEMA_NAME,
			table: sys_table,
			subscribe,
			publish,
			start_time: db_file_stat.mtime.toISOString(),
		});
	}

	for (const schema in leader_schemas) {
		for (const table in leader_schemas[schema]) {
			const schema_path = getSchemaPath(schema, table);
			const db_file_stat = await fs.stat(join(schema_path, table + '.mdb'));
			subscriptions.push({
				schema,
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
	await add_node(
		{
			operation: OPERATIONS_ENUM.ADD_NODE,
			node_name: leader_config?.clustering?.nodeName,
			subscriptions,
		},
		true
	);

	await nats_utils.closeConnection();
}

async function cloneConfig() {
	console.info('Cloning configuration');
	leader_config = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_CONFIGURATION });
	leader_config = await leader_config.json();
	leader_clustering_enabled = leader_config?.clustering?.enabled;
	let config_update = {};

	if (leader_clustering_enabled) {
		if (clustering_host == null) throw new Error(`'HDB_LEADER_CLUSTERING_HOST' must be defined`);
		config_update[CONFIG_PARAMS.CLUSTERING_ENABLED] = true;

		const leader_routes = leader_config?.clustering?.hubServer?.cluster?.network?.routes;
		const leader_clustering_port = leader_config?.clustering?.hubServer?.cluster?.network?.port;
		config_update[CONFIG_PARAMS.CLUSTERING_USER] = leader_config?.clustering?.user;

		// Add the leader host/port to clone node routes config
		let routes = env_mgr.get(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES);
		Array.isArray(routes)
			? routes.push({ host: clustering_host, port: leader_clustering_port })
			: (routes = [{ host: clustering_host, port: leader_clustering_port }]);

		// If the leader node has routes set in its config, concat them with any routes on clone node.
		if (Array.isArray(leader_routes)) routes.concat(leader_routes);

		config_update[CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES] = routes;
	}

	let exclude_comps = clone_node_config?.components?.exclude;
	// Convert array of excluded apps to object where app name is key, for easy searching.
	exclude_comps = exclude_comps
		? exclude_comps.reduce((obj, item) => {
				return { ...obj, [item['name']]: true };
		  }, {})
		: [];

	// Get all the comps in the leader config and check if they are in excluded config.
	let comps_clone = [];
	for (const element in leader_config) {
		if (leader_config[element]?.package && !exclude_comps[element]) {
			comps_clone.push({ keys: [element, 'package'], value: leader_config[element].package });
		}
	}

	if (!_.isEmpty(comps_clone)) {
		await config_utils.addConfig(comps_clone);
	}

	hdb_log.info('Cloning config:', config_update);
	if (!_.isEmpty(config_update)) await config_utils.updateConfigValue(undefined, undefined, config_update);
}

async function leaderHttpReq(req, get_backup = false) {
	const https_agent = new https.Agent({
		rejectUnauthorized: clone_node_config?.httpsRejectUnauthorized ?? false,
	});

	const auth = Buffer.from(username + ':' + password).toString('base64');
	const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' };
	if (get_backup) {
		headers['Accept-Encoding'] = 'gzip';
	}

	const response = await fetch(url, {
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

cloneNode()
	.then()
	.catch((err) => {
		console.log(err);
	});
