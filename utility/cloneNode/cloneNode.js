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
const crypto = require('node:crypto');
const PropertiesReader = require('properties-reader');
const envMgr = require('../environment/environmentManager.js');
const sysInfo = require('../environment/systemInformation.js');
const hdbLog = require('../logging/harper_logger.js');
const configUtils = require('../../config/configUtils.js');
const { restart } = require('../../bin/restart.js');
const hdbUtils = require('../common_utils.js');
const assignCMDENVVariables = require('../assignCmdEnvVariables.js');
const globalSchema = require('../globalSchema.js');
const { main, launch } = require('../../bin/run.js');
const { install, updateConfigEnv, setIgnoreExisting } = require('../install/installer.js');
const mount = require('../mount_hdb.js');
const hdbTerms = require('../hdbTerms.ts');
const { packageJson } = require('../packageUtils.js');
const hdbInfoController = require('../../dataLayer/hdbInfoController.js');
const { sendOperationToNode } = require('../../server/replication/replicator.ts');
const { updateConfigCert } = require('../../security/keys.js');
const { restartWorkers } = require('../../server/threads/manageThreads.js');
const { databases } = require('../../resources/databases.ts');
const { clusterStatus } = require('../clustering/clusterStatus.js');
const { set: setStatus } = require('../../server/status.ts');

const { SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME, CONFIG_PARAMS, OPERATIONS_ENUM } = hdbTerms;
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
	cloned: true,
};

const CLONE_VARS = {
	HDB_LEADER_USERNAME: 'HDB_LEADER_USERNAME',
	HDB_LEADER_PASSWORD: 'HDB_LEADER_PASSWORD',
	HDB_LEADER_URL: 'HDB_LEADER_URL',
	REPLICATION_HOSTNAME: 'REPLICATION_HOSTNAME',
	HDB_CLONE_OVERTOP: 'HDB_CLONE_OVERTOP',
	CLONE_KEYS: 'CLONE_KEYS',
	CLONE_USING_WS: 'CLONE_USING_WS',
	NO_START: 'NO_START',
};

const cliArgs = minimist(process.argv);
const username = cliArgs[CLONE_VARS.HDB_LEADER_USERNAME] ?? process.env[CLONE_VARS.HDB_LEADER_USERNAME];
const password = cliArgs[CLONE_VARS.HDB_LEADER_PASSWORD] ?? process.env[CLONE_VARS.HDB_LEADER_PASSWORD];
const leaderUrl = cliArgs[CLONE_VARS.HDB_LEADER_URL] ?? process.env[CLONE_VARS.HDB_LEADER_URL];
const replicationHost = cliArgs[CLONE_VARS.REPLICATION_HOSTNAME] ?? process.env[CLONE_VARS.REPLICATION_HOSTNAME];
let replicationHostname, replicationPort;
if (replicationHost) [replicationHostname, replicationPort] = replicationHost.split(':');

const cloneOvertop = (cliArgs[CLONE_VARS.HDB_CLONE_OVERTOP] ?? process.env[CLONE_VARS.HDB_CLONE_OVERTOP]) === 'true'; // optional var - will allow clone to work overtop of an existing HDB install
const clonedVar = cliArgs[CONFIG_PARAMS.CLONED.toUpperCase()] ?? process.env[CONFIG_PARAMS.CLONED.toUpperCase()];
const clone_keys = cliArgs[CLONE_VARS.CLONE_KEYS] !== 'false' && process.env[CLONE_VARS.CLONE_KEYS] !== 'false';
const cloneUsingWs = (cliArgs[CLONE_VARS.CLONE_USING_WS] ?? process.env[CLONE_VARS.CLONE_USING_WS]) === 'true';
const noStart = (cliArgs[CLONE_VARS.NO_START] ?? process.env[CLONE_VARS.NO_START]) === 'true';

let cloneNodeConfig;
let hdbConfig = {};
let hdbConfigJson;
let leaderConfig;
let leaderConfigFlat = {};
let leaderDbs;
let rootPath;
let excludeDb;
let excludedTable;
let freshClone = false;
let sysDbExist = false;
let startTime;
let leaderReplicationUrl;

/**
 * This module will run when HarperDB is started with the required env/cli vars.
 * Any config, databases and replication that doesn't already exist on this node will be cloned from the leader node
 * @param background
 * @returns {Promise<void>}
 */
module.exports = async function cloneNode(background = false, run = false) {
	console.info(`Starting clone node from leader node: ${leaderUrl}`);
	delete process.env.HDB_LEADER_URL;

	rootPath = hdbUtils.getEnvCliRootPath();
	if (!rootPath) {
		try {
			const bootPropsFilePath = join(os.homedir(), hdbTerms.HDB_HOME_DIR_NAME, hdbTerms.BOOT_PROPS_FILE_NAME);
			if (await fs.pathExists(bootPropsFilePath)) {
				const hdbProperties = PropertiesReader(bootPropsFilePath);
				rootPath = path.parse(hdbProperties.get(hdbTerms.BOOT_PROP_PARAMS.SETTINGS_PATH_KEY)).dir;
			}
		} catch (err) {
			throw new Error(
				`There was an error setting the clone default root path. Please set ROOTPATH using an environment or CLI variable.`
			);
		}
	}

	if (!rootPath) {
		console.log(`No HarperDB install found, starting fresh clone`);
		freshClone = true;
	} else if (await fs.pathExists(rootPath)) {
		console.log(
			`Existing HarperDB install found at ${rootPath}. Clone node will only clone items that do not already exist on clone.`
		);
	} else {
		console.log(`No HarperDB install found at ${rootPath} starting fresh clone`);
		freshClone = true;
	}

	if (!rootPath) {
		rootPath = join(os.homedir(), hdbTerms.HDB_ROOT_DIR_NAME);
		console.log('Using default root path', rootPath);
	}

	let cloneConfigPath;
	try {
		cloneConfigPath = join(rootPath, CLONE_CONFIG_FILE);
		cloneNodeConfig = YAML.parseDocument(await fs.readFile(cloneConfigPath, 'utf8'), { simpleKeys: true }).toJSON();
		console.log('Clone config file found');
	} catch (err) {}

	const hdbConfigPath = join(rootPath, hdbTerms.HDB_CONFIG_FILE);

	if (await fs.pathExists(hdbConfigPath)) {
		try {
			hdbConfigJson = YAML.parseDocument(await fs.readFile(hdbConfigPath, 'utf8'), { simpleKeys: true }).toJSON();
			hdbConfig = configUtils.flattenConfig(hdbConfigJson);
		} catch (err) {
			console.error('Error reading existing harperdb-config.yaml on clone', err);
		}
	}

	if (replicationHost) {
		const leaderUrlInst = new URL(leaderUrl);
		leaderReplicationUrl = `${leaderUrlInst.protocol === 'https:' ? 'wss://' : 'ws://'}${leaderUrlInst.hostname}:${replicationPort || 9933}`;
	}

	if (cloneUsingWs) {
		await cloneUsingWS();
		return;
	}

	if (hdbConfig?.cloned && clonedVar !== 'false') {
		console.log('Instance marked as cloned, clone will not run');
		envMgr.setCloneVar(false);
		envMgr.initSync();
		return main();
	}

	// Get all the non-system db/table from leader node
	leaderDbs = await leaderReq({ operation: OPERATIONS_ENUM.DESCRIBE_ALL });

	await cloneConfig();
	envMgr.setCloneVar(false);
	envMgr.setHdbBasePath(rootPath);

	fs.ensureDir(envMgr.get(hdbTerms.CONFIG_PARAMS.LOGGING_ROOT));
	hdbLog.initLogSettings();

	await cloneDatabases();

	// Only call install if a fresh sys DB was added
	if (!sysDbExist) await installHDB();

	await startHDB(background, run);

	if (replicationHost) {
		await setupReplication();
		await cloneKeys();
	}

	console.info('\nSuccessfully cloned node: ' + leaderUrl);
	if (background || noStart) process.exit();
};

/**
 * Will make all the necessary calls to the leader node using a WebSocket connection rather than http.
 * @returns {Promise<void>}
 */
async function cloneUsingWS() {
	if (hdbConfig?.cloned && clonedVar !== 'false') {
		console.log('Instance marked as cloned, clone will not run');
		envMgr.setCloneVar(false);
		envMgr.initSync();
		// Start HDB
		return main();
	}

	console.log('Cloning using WebSockets');

	const systemDbDir = getDBPath('system');
	const sysDbFileDir = join(systemDbDir, 'system.mdb');
	const sysDbExists = fs.existsSync(sysDbFileDir);
	if (freshClone || !sysDbExists || cloneOvertop) {
		console.info('Clone node installing HarperDB');
		process.env.TC_AGREEMENT = 'yes';
		process.env.ROOTPATH = rootPath;
		process.env.HDB_ADMIN_USERNAME = 'clone-temp-admin';
		process.env.HDB_ADMIN_PASSWORD = crypto.randomBytes(10).toString('base64').slice(0, 10);
		setIgnoreExisting(true);
		await install();
	} else {
		envMgr.setCloneVar(false);
		envMgr.initSync();
	}

	// Starts HDB
	await main();

	// Cloning the leader configuration, excluding CONFIG_TO_NOT_CLONE values
	await cloneConfig(true);

	// Updates the keys configuration
	await updateConfigCert();

	// We delete the clone-temp-admin user because now that HDB is installed we want user to come from the leader via replication and the add node call
	if (!sysDbExists) {
		await databases.system.hdb_user.delete({ username: 'clone-temp-admin' });
	}

	// Restarting HDB to pick up new config
	await restartWorkers();

	// Get last updated record timestamps for all DB and write to file
	// These values can be used for checking when the clone replication has caught up with leader
	const lastUpdatedTimestamps = await getLastUpdatedRecord();

	// When cloning with WS we utilize addNode to clone all the DB and setup replication
	console.log('Adding node to the cluster');
	const addNode = require('../clustering/addNode.js');
	const addNodeResponse = await addNode({
		operation: OPERATIONS_ENUM.ADD_NODE,
		url: leaderReplicationUrl,
	});
	console.log('Add node response: ', addNodeResponse);

	await cloneKeys();

	// Monitor sync and update status when complete
	await monitorSyncAndUpdateStatus(lastUpdatedTimestamps);

	console.log(`Successfully cloned node: ${leaderUrl} using WebSockets`);
	configUtils.updateConfigValue(CONFIG_PARAMS.CLONED, true);

	if (noStart) process.exit();
}

/**
 * Will loop through a system describe and a describeAll to compare the last updated record for each table
 * and record the most recent timestamp for each database in a JSON file.
 * @returns {Promise<void>}
 */
async function getLastUpdatedRecord() {
	const findMostRecentTimestamp = (describeObj) => {
		let mostRecent = 0;
		for (const table in describeObj) {
			const tableObj = describeObj[table];
			// requestId is part of the describe response so we ignore it
			if (typeof tableObj !== 'object') continue;
			if (tableObj.last_updated_record > mostRecent) {
				mostRecent = tableObj.last_updated_record;
			}
		}

		return mostRecent;
	};

	console.log('Getting last updated record timestamp for all database');
	const lastUpdated = {};
	const systemDb = await leaderReq({ operation: 'describe_database', database: 'system' });
	lastUpdated['system'] = findMostRecentTimestamp(systemDb);

	const allDb = await leaderReq({ operation: 'describe_all' });
	for (const db in allDb) {
		// requestId is part of the describe response so we ignore it
		if (typeof allDb[db] !== 'object') continue;
		lastUpdated[db] = findMostRecentTimestamp(allDb[db]);
	}

	const lastUpdatedFilePath = join(rootPath, 'tmp', 'lastUpdated.json');
	console.log('Writing last updated database timestamps to:', lastUpdatedFilePath);
	await fs.outputJson(lastUpdatedFilePath, lastUpdated);
	
	return lastUpdated;
}

/**
 * Monitor sync status and update Harper status when synchronization is complete
 * @param {Object} targetTimestamps - Object with database names as keys and timestamps as values
 * @returns {Promise<void>}
 */
async function monitorSyncAndUpdateStatus(targetTimestamps) {
	// Check if status update is enabled
	if (process.env.CLONE_NODE_UPDATE_STATUS !== 'true') {
		console.log('Clone node status update is disabled');
		return;
	}

	// Configuration from environment variables
	const statusId = process.env.HDB_CLONE_STATUS_ID || 'availability';
	const statusValue = process.env.HDB_CLONE_SUCCESS_STATUS || 'Available';
	const maxWaitTime = parseInt(process.env.HDB_CLONE_SYNC_TIMEOUT || '300000'); // 5 minutes default
	const checkInterval = parseInt(process.env.HDB_CLONE_CHECK_INTERVAL || '10000'); // 10 seconds default

	console.log(`Starting sync monitoring for status update (${statusId}: ${statusValue})`);
	console.log(`Max wait time: ${maxWaitTime}ms, Check interval: ${checkInterval}ms`);

	const startTime = Date.now();
	let syncComplete = false;

	while (!syncComplete && (Date.now() - startTime) < maxWaitTime) {
		try {
			// Get cluster status
			const clusterResponse = await clusterStatus();
			
			// Check if all databases are synchronized
			syncComplete = checkSyncStatus(clusterResponse, targetTimestamps);

			if (syncComplete) {
				console.log('All databases synchronized, updating status');
				try {
					await setStatus({ id: statusId, status: statusValue });
					console.log(`Successfully updated status: ${statusId} = ${statusValue}`);
				} catch (error) {
					console.error('Error updating status:', error);
				}
			} else {
				console.log(`Sync not complete, waiting ${checkInterval}ms before next check`);
				await new Promise(resolve => setTimeout(resolve, checkInterval));
			}
		} catch (error) {
			console.error('Error checking cluster status:', error);
			// Continue monitoring on error
			await new Promise(resolve => setTimeout(resolve, checkInterval));
		}
	}

	if (!syncComplete) {
		console.warn(`Sync monitoring timed out after ${maxWaitTime}ms`);
	}
}

/**
 * Check if all databases are synchronized by comparing timestamps
 * @param {Object} clusterResponse - Response from clusterStatus()
 * @param {Object} targetTimestamps - Target timestamps to check against
 * @returns {boolean} - True if all databases are synchronized
 */
function checkSyncStatus(clusterResponse, targetTimestamps) {
	// Handle empty or invalid targetTimestamps
	if (!targetTimestamps || Object.keys(targetTimestamps).length === 0) {
		console.log('No target timestamps to check');
		return true;
	}

	for (const connection of clusterResponse.connections || []) {
		for (const socket of connection.database_sockets || []) {
			const dbName = socket.database;
			const targetTime = targetTimestamps[dbName];
			
			// Skip if no target time for this database
			if (!targetTime) continue;

			const receivedTime = socket.lastReceivedRemoteTime;
			
			// Check if we have received data and if it's up to date
			if (!receivedTime) {
				console.log(`Database ${dbName}: No data received yet`);
				return false;
			}

			// Convert timestamps to numbers for comparison
			const receivedTimeNum = new Date(receivedTime).getTime();
			
			if (receivedTimeNum < targetTime) {
				console.log(`Database ${dbName}: Not synchronized (received: ${receivedTimeNum}, target: ${targetTime})`);
				return false;
			}

			console.log(`Database ${dbName}: Synchronized`);
		}
	}

	return true;
}

/**
 * Send a request to the leader node using either http or websockets
 * If websockets are used the leader node needs to know about the clone before any requests are made.
 * @param req
 * @returns {Promise<unknown>}
 */
async function leaderReq(req) {
	if (cloneUsingWs) {
		return sendOperationToNode({ url: leaderReplicationUrl }, req, { rejectUnauthorized: false });
	}

	return JSON.parse((await leaderHttpReq(req)).body);
}

async function cloneKeys() {
	try {
		if (clone_keys !== false) {
			console.log('Cloning JWT keys');
			const keysDir = path.join(rootPath, hdbTerms.LICENSE_KEY_DIR_NAME);
			// sendOperationToNode is used for extra security, it uses mtls when connecting to leader node.
			const jwtPublic = await sendOperationToNode(
				{ url: leaderReplicationUrl },
				{
					operation: OPERATIONS_ENUM.GET_KEY,
					name: '.jwtPublic',
				},
				{ rejectUnauthorized: false }
			);
			writeFileSync(path.join(keysDir, hdbTerms.JWT_ENUM.JWT_PUBLIC_KEY_NAME), jwtPublic.message);

			const jwtPrivate = await sendOperationToNode(
				{ url: leaderReplicationUrl },
				{
					operation: OPERATIONS_ENUM.GET_KEY,
					name: '.jwtPrivate',
				},
				{ rejectUnauthorized: false }
			);
			writeFileSync(path.join(keysDir, hdbTerms.JWT_ENUM.JWT_PRIVATE_KEY_NAME), jwtPrivate.message);
		}
	} catch (err) {
		console.error('Error cloning JWT keys', err);
	}
}

/**
 * Clone config from leader except for any existing config or any excluded config (mainly path related values)
 * @param withWs - If true the config will be cloned using websockets
 * @returns {Promise<void>}
 */
async function cloneConfig(withWs = false) {
	console.info('Cloning configuration');
	leaderConfig = await leaderReq({ operation: OPERATIONS_ENUM.GET_CONFIGURATION });
	leaderConfigFlat = configUtils.flattenConfig(leaderConfig);
	const excludeComps = cloneNodeConfig?.componentConfig?.exclude;
	const configUpdate = {
		rootpath: rootPath,
	};

	if (replicationHost) configUpdate.replication_hostname = replicationHostname;

	for (const name in leaderConfigFlat) {
		if (
			(leaderConfigFlat[name] !== null &&
				typeof leaderConfigFlat[name] === 'object' &&
				!(leaderConfigFlat[name] instanceof Array)) ||
			CONFIG_TO_NOT_CLONE[name]
		)
			continue;

		if (name.includes('_package') || name.includes('_port')) {
			// This is here to stop local leader component config from being cloned
			if (leaderConfigFlat[name]?.includes?.('hdb/components')) continue;

			if (excludeComps) {
				let excludedComp = false;
				for (const comp of excludeComps) {
					if (name.includes(comp.name)) {
						excludedComp = true;
						break;
					}
				}
				if (excludedComp) continue;
			}
		}

		if (!hdbConfig[name]) {
			configUpdate[name] = leaderConfigFlat[name];
		}
	}

	for (const name in hdbConfig) {
		if (name !== 'databases' && typeof hdbConfig[name] === 'object' && !(hdbConfig[name] instanceof Array)) continue;
		configUpdate[name] = hdbConfig[name];
	}

	// If DB are excluded in clone config update replication.databases to not include the excluded DB
	const excludedDb = {};
	if (cloneNodeConfig?.databaseConfig?.excludeDatabases) {
		cloneNodeConfig.databaseConfig.excludeDatabases.forEach((db) => {
			excludedDb[db.database] = true;
		});
	}

	if (cloneNodeConfig?.clusteringConfig?.excludeDatabases) {
		cloneNodeConfig.clusteringConfig.excludeDatabases.forEach((db) => {
			excludedDb[db.database] = true;
		});
	}

	if (Object.keys(excludedDb).length > 0) {
		configUpdate.replication_databases = [];
		if (!excludedDb['system']) configUpdate.replication_databases.push('system');
		for (const db in leaderDbs) {
			if (!excludedDb[db]) {
				configUpdate.replication_databases.push(db);
			}
		}
	}

	const args = assignCMDENVVariables(Object.keys(hdbTerms.CONFIG_PARAM_MAP), true);
	Object.assign(configUpdate, args);

	// If cloning using websockets we set the cloned flag at the completion of the clone
	if (!withWs) configUpdate.cloned = true;
	configUtils.createConfigFile(configUpdate, true);
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
	process.env.ROOTPATH = rootPath;
	if (!username) throw new Error('HDB_LEADER_USERNAME is undefined.');
	process.env.HDB_ADMIN_USERNAME = username;
	if (!password) throw new Error('HDB_LEADER_PASSWORD is undefined.');
	process.env.HDB_ADMIN_PASSWORD = password;
	process.env.OPERATIONSAPI_NETWORK_PORT = envMgr.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
	updateConfigEnv(path.join(rootPath, hdbTerms.HDB_CONFIG_FILE));

	setIgnoreExisting(true);

	await install();
}

function getDBPath(db) {
	const dbConfig = envMgr.get(hdbTerms.CONFIG_PARAMS.DATABASES)?.[db];
	return (
		dbConfig?.path || envMgr.get(CONFIG_PARAMS.STORAGE_PATH) || path.join(rootPath, hdbTerms.DATABASES_DIR_NAME)
	);
}

async function cloneTablesHttp() {
	// If this is a fresh clone or there is no system.mdb file clone users/roles system tables
	const systemDbDir = getDBPath('system');
	const sysDbFileDir = join(systemDbDir, 'system.mdb');
	await ensureDir(systemDbDir);
	if (freshClone || !(await fs.exists(sysDbFileDir)) || cloneOvertop) {
		if (!replicationHost) {
			console.info('Cloning system database');
			await ensureDir(systemDbDir);
			const fileStream = createWriteStream(sysDbFileDir, { overwrite: true });
			const req = {
				operation: OPERATIONS_ENUM.GET_BACKUP,
				database: 'system',
				tables: SYSTEM_TABLES_TO_CLONE,
			};

			const headers = await leaderHttpStream(req, fileStream);
			// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
			let backupDate = new Date(headers.date);
			if (!startTime || backupDate < startTime) startTime = backupDate;
			await fs.utimes(sysDbFileDir, Date.now(), backupDate);
		}

		if (!freshClone) {
			await mount(rootPath);
			await insertHdbVersionInfo();
			setIgnoreExisting(true);
		}
	} else {
		sysDbExist = true;
		console.log(`Not cloning system database due to it already existing on clone`);
	}

	// Create object where excluded db name is key
	excludeDb = cloneNodeConfig?.databaseConfig?.excludeDatabases;
	excludeDb = excludeDb
		? excludeDb.reduce((obj, item) => {
				return { ...obj, [item['database']]: true };
			}, {})
		: {};

	// Check to see if DB already on clone, if it is we dont clone it
	for (const db in leaderDbs) {
		if (await fs.exists(path.join(getDBPath(db), db + '.mdb'))) {
			console.log(`Not cloning database ${db} due to it already existing on clone`);
			excludeDb[db] = true;
		}
	}

	// Build excluded table object where key is db + table
	excludedTable = cloneNodeConfig?.databaseConfig?.excludeTables;
	excludedTable = excludedTable
		? excludedTable.reduce((obj, item) => {
				return { ...obj, [item['database'] == null ? null : item['database'] + item['table']]: true };
			}, {})
		: {};

	for (const db in leaderDbs) {
		if (excludeDb[db]) {
			leaderDbs[db] = 'excluded';
			continue;
		}
		if (_.isEmpty(leaderDbs[db])) continue;
		let tablesToClone = [];
		let excludedTables = false;
		for (const tableName in leaderDbs[db]) {
			if (excludedTable[db + tableName]) {
				excludedTables = true;
				leaderDbs[db][tableName] = 'excluded';
			} else {
				tablesToClone.push(leaderDbs[db][tableName]);
			}
		}

		if (tablesToClone.length === 0) continue;
		if (replicationHost) {
			hdbLog.debug('Setting up tables for #{db}');
			const ensureTable = require('../../resources/databases.ts').table;
			for (let table of tablesToClone) {
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
		tablesToClone = tablesToClone.map((table) => table.name);

		let backupReq;
		if (excludedTables) {
			console.info(`Cloning database: ${db} tables: ${tablesToClone}`);
			backupReq = { operation: OPERATIONS_ENUM.GET_BACKUP, database: db, tables: tablesToClone };
		} else {
			console.info(`Cloning database: ${db}`);
			backupReq = { operation: OPERATIONS_ENUM.GET_BACKUP, database: db };
		}

		const dbDir = getDBPath(db);
		await ensureDir(dbDir);
		const dbPath = join(dbDir, db + '.mdb');
		const tableFileStream = createWriteStream(dbPath, { overwrite: true });
		const reqHeaders = await leaderHttpStream(backupReq, tableFileStream);

		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		let backupDate = new Date(reqHeaders.date);
		if (!startTime || backupDate < startTime) startTime = backupDate;
		await fs.utimes(dbPath, Date.now(), backupDate);
	}
}

async function cloneTablesFetch() {
	// If this is a fresh clone or there is no system.mdb file clone users/roles system tables
	const systemDbDir = getDBPath('system');
	const sysDbFileDir = join(systemDbDir, 'system.mdb');
	if (freshClone || !(await fs.exists(sysDbFileDir)) || cloneOvertop) {
		if (!replicationHost) {
			console.info('Cloning system database using fetch');
			const req = {
				operation: OPERATIONS_ENUM.GET_BACKUP,
				database: 'system',
				tables: SYSTEM_TABLES_TO_CLONE,
			};

			const sysBackup = await leaderHttpReqFetch(req, true);
			const sysDbDir = getDBPath('system');
			await ensureDir(sysDbDir);
			const sysDbFileDir = join(sysDbDir, 'system.mdb');
			await pipeline(sysBackup.body, createWriteStream(sysDbFileDir, { overwrite: true }));

			// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
			let backupDate = new Date(sysBackup.headers.get('date'));
			if (!startTime || backupDate < startTime) startTime = backupDate;
			await fs.utimes(sysDbFileDir, Date.now(), new Date(sysBackup.headers.get('date')));
		}

		if (!freshClone) {
			await mount(rootPath);
			await insertHdbVersionInfo();
			setIgnoreExisting(true);
		}
	} else {
		sysDbExist = true;
		console.log(`Not cloning system database due to it already existing on clone`);
	}
	if (replicationHost) {
		hdbLog.info('Replication hostname set, not using backup to clone databases, replication will clone');
		return;
	}

	// Create object where excluded db name is key
	excludeDb = cloneNodeConfig?.databaseConfig?.excludeDatabases;
	excludeDb = excludeDb
		? excludeDb.reduce((obj, item) => {
				return { ...obj, [item['database']]: true };
			}, {})
		: {};

	// Check to see if DB already on clone, if it is we dont clone it
	for (const db in leaderDbs) {
		if (await fs.exists(path.join(getDBPath(db), db + '.mdb'))) {
			console.log(`Not cloning database ${db} due to it already existing on clone`);
			excludeDb[db] = true;
		}
	}

	// Build excluded table object where key is db + table
	excludedTable = cloneNodeConfig?.databaseConfig?.excludeTables;
	excludedTable = excludedTable
		? excludedTable.reduce((obj, item) => {
				return { ...obj, [item['database'] == null ? null : item['database'] + item['table']]: true };
			}, {})
		: {};

	for (const db in leaderDbs) {
		if (excludeDb[db]) {
			leaderDbs[db] = 'excluded';
			continue;
		}
		if (_.isEmpty(leaderDbs[db])) continue;
		let tablesToClone = [];
		let excludedTables = false;
		for (const table in leaderDbs[db]) {
			if (excludedTable[db + table]) {
				excludedTables = true;
				leaderDbs[db][table] = 'excluded';
			} else {
				tablesToClone.push(table);
			}
		}

		if (tablesToClone.length === 0) return;

		let backup;
		if (excludedTables) {
			console.info(`Cloning database: ${db} tables: ${tablesToClone}`);
			backup = await leaderHttpReqFetch(
				{ operation: OPERATIONS_ENUM.GET_BACKUP, database: db, tables: tablesToClone },
				true
			);
		} else {
			console.info(`Cloning database: ${db}`);
			backup = await leaderHttpReqFetch({ operation: OPERATIONS_ENUM.GET_BACKUP, database: db }, true);
		}

		const dbDir = getDBPath(db);
		await ensureDir(dbDir);
		const backupDate = new Date(backup.headers.get('date'));

		// Stream the backup to a file with temp name consisting of <timestamp>-<table name>, this is done so that if clone
		// fails during this step half cloned db files can easily be identified.
		const tempDbPath = join(dbDir, `${backupDate.getTime()}-${db}.mdb`);
		await pipeline(backup.body, createWriteStream(tempDbPath, { overwrite: true }));

		// Once the clone of a db file is completed it is renamed to its permanent name
		const dbPath = join(dbDir, db + '.mdb');
		await fs.rename(tempDbPath, dbPath);

		// We add the backup date to the files mtime property, this is done so that clusterTables can reference it.
		if (!startTime || backupDate < startTime) startTime = backupDate;
		await fs.utimes(dbPath, Date.now(), backupDate);
	}
}

async function leaderHttpReqFetch(req, getBackup = false) {
	const rejectUnauth = cloneNodeConfig?.httpsRejectUnauthorized ?? false;
	const httpsAgent = new https.Agent({
		rejectUnauthorized: rejectUnauth,
	});

	if (!rejectUnauth) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

	const auth = Buffer.from(username + ':' + password).toString('base64');
	const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' };
	if (getBackup) {
		headers['Accept-Encoding'] = 'gzip';
	}

	const response = await fetch(leaderUrl, {
		method: 'POST',
		headers,
		body: JSON.stringify(req),
		agent: httpsAgent,
		compress: true,
	});

	if (response.ok) return response;
	console.error(`HTTP Error Response: ${response.status} ${response.statusText}`);
	throw new Error(await response.text());
}

async function startHDB(background, run = false) {
	const hdbProc = await sysInfo.getHDBProcessInfo();
	if (hdbProc.clustering.length === 0 || hdbProc.core.length === 0) {
		if (background) {
			await launch(false);
		} else {
			if (run) await setAppPath();
			await main();
		}
	} else {
		console.info(await restart({ operation: OPERATIONS_ENUM.RESTART }));
		await hdbUtils.asyncSetTimeout(WAIT_FOR_RESTART_TIME);
	}
	if (background) await hdbUtils.asyncSetTimeout(2000);
}

async function setAppPath() {
	// Run a specific application folder
	let appFolder = process.argv[3];
	if (appFolder && appFolder[0] !== '-') {
		if (!(await fs.exists(appFolder))) {
			console.error(`The folder ${appFolder} does not exist`);
		}
		if (!fs.statSync(appFolder).isDirectory()) {
			console.error(`The path ${appFolder} is not a folder`);
		}
		appFolder = await fs.realpath(appFolder);
		if (await fs.exists(path.join(appFolder, hdbTerms.HDB_CONFIG_FILE))) {
			// This can be used to run HDB without a boot file
			process.env.ROOTPATH = appFolder;
		} else {
			process.env.RUN_HDB_APP = appFolder;
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

	await globalSchema.setSchemaDataToGlobalAsync();
	const addNode = require('../clustering/addNode.js');
	const addNodeResponse = await addNode(
		{
			operation: OPERATIONS_ENUM.ADD_NODE,
			verify_tls: false, // TODO : if they have certs we shouldnt need to pass creds
			url: leaderReplicationUrl,
			startTime,
			authorization: {
				username,
				password,
			},
		},
		true
	);

	console.log('Add node response: ', addNodeResponse);
}

async function leaderHttpReq(req) {
	const httpsAgent = new https.Agent({
		rejectUnauthorized: cloneNodeConfig?.httpsRejectUnauthorized ?? false,
	});

	const auth = Buffer.from(username + ':' + password).toString('base64');
	const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' };
	const url = new URL(leaderUrl);
	const options = {
		protocol: url.protocol,
		host: url.hostname,
		method: 'POST',
		headers,
	};

	if (url.protocol === 'https:') options.agent = httpsAgent;
	if (url.port) options.port = url.port;
	return await hdbUtils.httpRequest(options, req);
}

async function leaderHttpStream(data, stream) {
	const httpsAgent = new https.Agent({
		rejectUnauthorized: cloneNodeConfig?.httpsRejectUnauthorized ?? false,
	});

	const auth = Buffer.from(username + ':' + password).toString('base64');
	const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' };
	const url = new URL(leaderUrl);
	const options = {
		protocol: url.protocol,
		host: url.hostname,
		method: 'POST',
		headers,
	};

	if (url.protocol === 'https:') {
		options.agent = httpsAgent;
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
	const vers = packageJson.version;
	if (vers) {
		await hdbInfoController.insertHdbInstallInfo(vers);
	} else {
		throw new Error('The version is missing/removed from HarperDB package.json');
	}
}
