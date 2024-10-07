'use strict';

const os = require('os');
const https = require('https');
let http = require('http');
const fs = require('fs-extra');
const YAML = require('yaml');
const { pipeline } = require('stream/promises');
const { createWriteStream, ensureDir, writeFileSync } = require('fs-extra');
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
const SYSTEM_TABLES_TO_CLONE = [
	SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME,
	SYSTEM_TABLE_NAMES.USER_TABLE_NAME,
	SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
];
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
	replication_hostname: true,
	replication_url: true,
};

const CLONE_VARS = {
	HDB_LEADER_USERNAME: 'HDB_LEADER_USERNAME',
	HDB_LEADER_PASSWORD: 'HDB_LEADER_PASSWORD',
	HDB_LEADER_URL: 'HDB_LEADER_URL',
	REPLICATION_HOSTNAME: 'REPLICATION_HOSTNAME',
	HDB_CLONE_OVERTOP: 'HDB_CLONE_OVERTOP',
	CLONE_KEYS: 'CLONE_KEYS',
};

const cli_args = minimist(process.argv);
const username = cli_args[CLONE_VARS.HDB_LEADER_USERNAME] ?? process.env[CLONE_VARS.HDB_LEADER_USERNAME];
const password = cli_args[CLONE_VARS.HDB_LEADER_PASSWORD] ?? process.env[CLONE_VARS.HDB_LEADER_PASSWORD];
const leader_url = cli_args[CLONE_VARS.HDB_LEADER_URL] ?? process.env[CLONE_VARS.HDB_LEADER_URL];
const replication_hostname = cli_args[CLONE_VARS.REPLICATION_HOSTNAME] ?? process.env[CLONE_VARS.REPLICATION_HOSTNAME];

const clone_overtop = (cli_args[CLONE_VARS.HDB_CLONE_OVERTOP] ?? process.env[CLONE_VARS.HDB_CLONE_OVERTOP]) === 'true'; // optional var - will allow clone to work overtop of an existing HDB install
const cloned_var = cli_args[CONFIG_PARAMS.CLONED.toUpperCase()] ?? process.env[CONFIG_PARAMS.CLONED.toUpperCase()];
const clone_keys = cli_args[CLONE_VARS.CLONE_KEYS] ?? process.env[CLONE_VARS.CLONE_KEYS];

let clone_node_config;
let hdb_config = {};
let hdb_config_json;
let leader_config;
let leader_config_flat = {};
let leader_dbs;
let root_path;
let exclude_db;
let excluded_table;
let fresh_clone = false;
let sys_db_exist = false;
let start_time;

/**
 * This module will run when HarperDB is started with the required env/cli vars.
 * Any config, databases and replication that doesn't already exist on this node will be cloned from the leader node
 * @param background
 * @returns {Promise<void>}
 */
module.exports = async function cloneNode(background = false, run = false) {
	console.info(`Starting clone node from leader node: ${leader_url}`);
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

	// Get all the non-system db/table from leader node
	leader_dbs = await leaderHttpReq({ operation: OPERATIONS_ENUM.DESCRIBE_ALL });
	leader_dbs = await JSON.parse(leader_dbs.body);

	await cloneConfig();
	env_mgr.setCloneVar(false);
	env_mgr.setHdbBasePath(root_path);

	fs.ensureDir(env_mgr.get(hdb_terms.CONFIG_PARAMS.LOGGING_ROOT));
	hdb_log.initLogSettings();

	await cloneDatabases();

	// Only call install if a fresh sys DB was added
	if (!sys_db_exist) {
		await installHDB();
		await cloneKeys();
	}

	await startHDB(background, run);

	if (replication_hostname) {
		await setupReplication();
	}

	console.info('\nSuccessfully cloned node: ' + leader_url);
	if (background) process.exit();
};

async function cloneKeys() {
	if (clone_keys !== false) {
		console.log('Cloning JWT keys');
		const keys_dir = path.join(root_path, hdb_terms.LICENSE_KEY_DIR_NAME);
		const jwt_public = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_KEY, name: '.jwtPublic' });
		writeFileSync(path.join(keys_dir, hdb_terms.JWT_ENUM.JWT_PUBLIC_KEY_NAME), JSON.parse(jwt_public.body).message);

		const jwt_private = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_KEY, name: '.jwtPrivate' });
		writeFileSync(path.join(keys_dir, hdb_terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME), JSON.parse(jwt_private.body).message);
	}
}

/**
 * Clone config from leader except for any existing config or any excluded config (mainly path related values)
 * @returns {Promise<void>}
 */
async function cloneConfig() {
	console.info('Cloning configuration');
	leader_config = await leaderHttpReq({ operation: OPERATIONS_ENUM.GET_CONFIGURATION });
	leader_config = await JSON.parse(leader_config.body);
	leader_config_flat = config_utils.flattenConfig(leader_config);
	const exclude_comps = clone_node_config?.componentConfig?.exclude;
	const config_update = {
		cloned: true,
		rootpath: root_path,
	};

	if (replication_hostname) config_update.replication_hostname = replication_hostname;

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

		if (!hdb_config[name]) {
			config_update[name] = leader_config_flat[name];
		}
	}

	for (const name in hdb_config) {
		if (name !== 'databases' && typeof hdb_config[name] === 'object' && !(hdb_config[name] instanceof Array)) continue;
		config_update[name] = hdb_config[name];
	}

	// If DB are excluded in clone config update replication.databases to not include the excluded DB
	const excluded_db = {};
	if (clone_node_config?.databaseConfig?.excludeDatabases) {
		clone_node_config.databaseConfig.excludeDatabases.forEach((db) => {
			excluded_db[db.database] = true;
		});
	}

	if (clone_node_config?.clusteringConfig?.excludeDatabases) {
		clone_node_config.clusteringConfig.excludeDatabases.forEach((db) => {
			excluded_db[db.database] = true;
		});
	}

	if (Object.keys(excluded_db).length > 0) {
		config_update.replication_databases = [];
		if (!excluded_db['system']) config_update.replication_databases.push('system');
		for (const db in leader_dbs) {
			if (!excluded_db[db]) {
				config_update.replication_databases.push(db);
			}
		}
	}

	const args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	Object.assign(config_update, args);

	config_utils.createConfigFile(config_update, true);
	env_mgr.initSync(true);
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
	await ensureDir(system_db_dir);
	if (fresh_clone || !(await fs.exists(sys_db_file_dir)) || clone_overtop) {
		if (!replication_hostname) {
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
			let backup_date = new Date(headers.date);
			if (!start_time || backup_date < start_time) start_time = backup_date;
			await fs.utimes(sys_db_file_dir, Date.now(), backup_date);
		}

		if (!fresh_clone) {
			await mount(root_path);
			await insertHdbVersionInfo();
			setIgnoreExisting(true);
		}
	} else {
		sys_db_exist = true;
		console.log(`Not cloning system database due to it already existing on clone`);
	}

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
		for (const table_name in leader_dbs[db]) {
			if (excluded_table[db + table_name]) {
				excluded_tables = true;
				leader_dbs[db][table_name] = 'excluded';
			} else {
				tables_to_clone.push(leader_dbs[db][table_name]);
			}
		}

		if (tables_to_clone.length === 0) continue;
		if (replication_hostname) {
			hdb_log.debug('Setting up tables for #{db}');
			const ensureTable = require('../../resources/databases').table;
			for (let table of tables_to_clone) {
				for (let attribute of table.attributes) {
					if (attribute.is_hash_attribute || attribute.is_primary_key) attribute.isPrimaryKey = true;
				}
				ensureTable({
					database: db,
					table: table.name,
					attributes: table.attributes,
				});
			}
			continue;
		}
		tables_to_clone = tables_to_clone.map((table) => table.name);

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
		let backup_date = new Date(req_headers.date);
		if (!start_time || backup_date < start_time) start_time = backup_date;
		await fs.utimes(db_path, Date.now(), backup_date);
	}
}

async function cloneTablesFetch() {
	// If this is a fresh clone or there is no system.mdb file clone users/roles system tables
	const system_db_dir = getDBPath('system');
	const sys_db_file_dir = join(system_db_dir, 'system.mdb');
	if (fresh_clone || !(await fs.exists(sys_db_file_dir)) || clone_overtop) {
		if (!replication_hostname) {
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
			let backup_date = new Date(sys_backup.headers.get('date'));
			if (!start_time || backup_date < start_time) start_time = backup_date;
			await fs.utimes(sys_db_file_dir, Date.now(), new Date(sys_backup.headers.get('date')));
		}

		if (!fresh_clone) {
			await mount(root_path);
			await insertHdbVersionInfo();
			setIgnoreExisting(true);
		}
	} else {
		sys_db_exist = true;
		console.log(`Not cloning system database due to it already existing on clone`);
	}
	if (replication_hostname) {
		hdb_log.info('Replication hostname set, not using backup to clone databases, replication will clone');
		return;
	}

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
		if (!start_time || backup_date < start_time) start_time = backup_date;
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

async function startHDB(background, run = false) {
	const hdb_proc = await sys_info.getHDBProcessInfo();
	if (hdb_proc.clustering.length === 0 || hdb_proc.core.length === 0) {
		if (background) {
			await launch(false);
		} else {
			if (run) await setAppPath();
			await main();
		}
	} else {
		console.info(await restart({ operation: OPERATIONS_ENUM.RESTART }));
		await hdb_utils.async_set_timeout(WAIT_FOR_RESTART_TIME);
	}
	if (background) await hdb_utils.async_set_timeout(2000);
}

async function setAppPath() {
	// Run a specific application folder
	let app_folder = process.argv[3];
	if (app_folder && app_folder[0] !== '-') {
		if (!(await fs.exists(app_folder))) {
			console.error(`The folder ${app_folder} does not exist`);
		}
		if (!fs.statSync(app_folder).isDirectory()) {
			console.error(`The path ${app_folder} is not a folder`);
		}
		app_folder = await fs.realpath(app_folder);
		if (await fs.exists(path.join(app_folder, hdb_terms.HDB_CONFIG_FILE))) {
			// This can be used to run HDB without a boot file
			process.env.ROOTPATH = app_folder;
		} else {
			process.env.RUN_HDB_APP = app_folder;
		}
	}
}

/**
 * Setup replication between this node and the leader, or if fully connected cli/env passed
 * setup replication between this node, the leader and any nodes the leader is replicating to.
 * @returns {Promise<void>}
 */
async function setupReplication() {
	console.info('Setting up replication');

	await global_schema.setSchemaDataToGlobalAsync();
	const add_node = require('../clustering/addNode');
	const add_node_response = await add_node(
		{
			operation: OPERATIONS_ENUM.ADD_NODE,
			verify_tls: false, // TODO : if they have certs we shouldnt need to pass creds
			url: `${leader_config.operationsApi.network.port ? 'ws' : 'wss'}://${new URL(leader_url).host}`,
			start_time,
			authorization: {
				username,
				password,
			},
		},
		true
	);

	console.log('Add node response: ', add_node_response);
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
