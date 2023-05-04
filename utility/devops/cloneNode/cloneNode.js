'use strict';

const fetch = require('node-fetch');
const https = require('https');
const fs = require('fs-extra');
const YAML = require('yaml');
const { pipeline } = require('stream/promises');
const { writeFileSync, mkdirpSync, createWriteStream, ensureDir } = require('fs-extra');
const { join } = require('path');
const _ = require('lodash');
const { openEnvironment } = require('../../lmdb/environmentUtility');
const { statDBI } = require('../../lmdb/environmentUtility');
const env_mgr = require('../../environment/environmentManager');
const hdb_log = require('../../logging/harper_logger');
const config_utils = require('../../../config/configUtils');
const add_node = require('../../clustering/addNode');
const { deployCustomFunctionProject } = require('../../../server/customFunctions/operations');
const {
	getSchemaPath,
	getSystemSchemaPath,
} = require('../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');
const hdb_terms = require('../../hdbTerms');
const { SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME, CONFIG_PARAMS, OPERATIONS_ENUM } = hdb_terms;
hdb_log.setLogLevel(hdb_terms.LOG_LEVELS.INFO);

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

let leader_clustering_enabled;
let leader_node_name;
let subscriptions;
let clone_node_config;
let leader_config;

async function cloneNode() {
	console.info('Cloning node: ' + url);
	clone_node_config = YAML.parseDocument(fs.readFileSync(CLONE_CONFIG_PATH, 'utf8'), { simpleKeys: true }).toJSON();

	// await cloneTables();
	await cloneConfig();
	await cloneApps();

	hdb_log.info('Successfully cloned node: ' + url);
	console.log('Successfully cloned node: ' + url);
}

async function cloneApps() {
	const leader_config_apps = leader_config?.apps ?? [];
	const leader_cf_root = leader_config?.customFunctions?.root;
	let leader_apps = await httpReq({ operation: OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS });
	leader_apps = await leader_apps.json();

	if (leader_apps)
		if (clone_node_config?.apps?.excludeApps) {
			// If there is excludeApps in clone config reference it against all the leader apps and remove any apps that should be excluded from clone.
			for (const exclude_app of clone_node_config.apps.excludeApps) {
				if (exclude_app?.name == null) continue;
				if (leader_apps[exclude_app?.name]) delete leader_apps[exclude_app.name];
			}
		}

	// Loop through the result from get_custom_functions. If the function is referenced in the leader
	// apps config AND it is located in the leaders CF root, package & deploy it to this node.
	// If the function exits but is not referenced in the leader app config, package & deploy it but
	// exclude it from the apps config on this node. Any apps that are in leader app config but don't reside
	// in the leader CF root are ignored. These can be deployed when npm install is run in a later step on this node.
	const skip_node_modules = clone_node_config?.apps?.skipNodeModules !== false;
	for (const project in leader_apps) {
		let app_deployed = false;
		for (const app of leader_config_apps) {
			if (app.name === project && app.package.includes(leader_cf_root)) {
				let pkg = await httpReq({
					operation: OPERATIONS_ENUM.PACKAGE_CUSTOM_FUNCTION_PROJECT,
					project,
					skip_node_modules,
				});
				const { payload } = await pkg.json();
				await deployCustomFunctionProject({ project, payload });
				app_deployed = true;
				break;
			} else if (app.name === project) {
				app_deployed = true;
			}
		}

		if (!app_deployed) {
			let pkg = await httpReq({
				operation: OPERATIONS_ENUM.PACKAGE_CUSTOM_FUNCTION_PROJECT,
				project,
				skip_node_modules,
			});
			const { payload } = await pkg.json();
			await deployCustomFunctionProject({ project, payload, bypass_apps: true });
		}
		console.info('Cloning and deploying custom function/app: ' + project);
	}
}
async function clusterTables() {
	if (leader_clustering_enabled) {
		if (subscriptions) {
			const add_node_req = {
				operation: OPERATIONS_ENUM.ADD_NODE,
				node_name: leader_node_name,
				subscriptions,
			};

			await add_node(add_node_req); //TODO: expand add node to work on system tables
		}
	}
}
// TODO: throw error if cant reach leader node
// TODO: get apps and plugins from config
// TODO: Whats the situation on logging? more less?
// TODO: exclude tables?
// TODO: how is this called? how are params passed
async function cloneConfig() {
	leader_config = await httpReq({ operation: OPERATIONS_ENUM.GET_CONFIGURATION });
	leader_config = await leader_config.json();
	leader_clustering_enabled = leader_config?.clustering?.enabled;
	leader_node_name = leader_config?.clustering?.nodeName;
	let config_update = {};

	if (leader_clustering_enabled) {
		const leader_routes = leader_config?.clustering?.hubServer?.cluster?.network?.routes;
		config_update[CONFIG_PARAMS.CLUSTERING_USER] = leader_config?.clustering?.user;

		// If the leader node has routes set in its config, concat them with any routes on this node and update config
		if (Array.isArray(leader_routes)) {
			const routes = env_mgr.get(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES);
			config_update[CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES] = Array.isArray(routes)
				? routes.concat(leader_routes)
				: leader_routes;
		}
	}

	if (leader_config?.apps && Array.isArray(leader_config?.apps)) {
		let exclude_apps = clone_node_config?.apps?.excludeApps;
		// Convert array of excluded apps to object where app name is key, for easy searching.
		exclude_apps = exclude_apps
			? exclude_apps.reduce((obj, item) => {
					return { ...obj, [item['name']]: true };
			  }, {})
			: [];

		const apps = env_mgr.get(CONFIG_PARAMS.APPS) ?? [];
		const cloned_apps = [];
		for (const app of leader_config.apps) {
			if (exclude_apps[app.name]) continue;
			// Remove any duplicate app config that might exist between leader and this node. Leader apps take priority.
			for (const [i, existing_app] of apps.entries()) {
				if (existing_app.name === app.name) {
					apps.splice(i, 1);
					break;
				}
			}

			cloned_apps.push(app);
		}

		config_update[CONFIG_PARAMS.APPS] = Array.isArray(apps) ? apps.concat(cloned_apps) : cloned_apps;
	}

	console.log(config_update);

	//TODO: get plugins

	if (!_.isEmpty(config_update)) await config_utils.updateConfigValue(undefined, undefined, config_update);
}

async function cloneTables() {
	// Get all the non-system schema/table from leader node
	let leader_schemas = await httpReq({ operation: OPERATIONS_ENUM.DESCRIBE_ALL });
	leader_schemas = await leader_schemas.json();

	// If there is excludeSchemas in clone config search for value in leader schema description and delete if found, so it's not cloned.
	if (clone_node_config?.database?.excludeSchemas) {
		for (const exclude_schema of clone_node_config.database.excludeSchemas) {
			if (exclude_schema?.schema == null) continue;
			if (leader_schemas[exclude_schema?.schema]) delete leader_schemas[exclude_schema.schema];
		}
	}

	// If there is excludeTables in clone config search for value in leader schema description and delete if found, so it's not cloned.
	if (clone_node_config?.database?.excludeTables) {
		for (const exclude_table of clone_node_config.database.excludeTables) {
			if (exclude_table?.schema == null) continue;
			if (leader_schemas[exclude_table?.schema][exclude_table?.table])
				delete leader_schemas[exclude_table.schema][exclude_table.table];
		}
	}

	//TODO: check for a 200 response before cloning table
	for (const sys_table of SYSTEM_TABLES_TO_CLONE) {
		hdb_log.info(`Cloning system table: ${sys_table} from node: ${url}`);
		const sys_backup = await httpReq({
			operation: OPERATIONS_ENUM.GET_BACKUP,
			schema: SYSTEM_SCHEMA_NAME,
			table: sys_table,
		});
		const sys_schema_path = getSystemSchemaPath();
		await ensureDir(sys_schema_path);
		await pipeline(sys_backup.body, createWriteStream(join(sys_schema_path, sys_table + '.mdb'), { overwrite: true }));
	}

	for (const schema in leader_schemas) {
		for (const table in leader_schemas[schema]) {
			// TODO If we log start/finish table clone can they recover if something goes wrong during clone. They will need to ba able to set tables to ignore
			hdb_log.info(`Cloning schema.table: ${schema}.${table} from node: ${url}`);
			const primary_key = leader_schemas[schema][table]['hash_attribute'];
			const leader_record_count = leader_schemas[schema][table]['record_count'];

			// Stream table backup from leader node to this node.
			const backup = await httpReq({ operation: OPERATIONS_ENUM.GET_BACKUP, schema, table });
			const schema_path = getSchemaPath(schema, table);
			await ensureDir(schema_path);
			const backup_date = new Date(backup.headers.get('date'));

			// Stream the backup to a file with temp name consisting of <timestamp>-<table name>, this is done so that if clone
			// fails during this step half cloned db files can easily be identified.
			const temp_db_path = join(schema_path, `${backup_date.getTime()}-${table}.mdb`);
			await pipeline(backup.body, createWriteStream(temp_db_path));

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
					`Something has gone wrong. The record count for leader table '${table}' is inconsistent with the record count on this node. 
					Leader node record count: ${leader_record_count}. This nodes record count: ${record_count}`
				);
			}
		}
	}
}

async function httpReq(req) {
	const https_agent = new https.Agent({
		rejectUnauthorized: clone_node_config?.httpsRejectUnauthorized ?? true,
	});

	const auth = Buffer.from(username + ':' + password).toString('base64');
	return await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + auth,
		},
		body: JSON.stringify(req),
		agent: https_agent,
	});
}

cloneNode()
	.then(() => {})
	.catch((err) => {
		console.log(err);
	});
