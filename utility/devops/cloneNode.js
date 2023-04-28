'use strict';

const fetch = require('node-fetch');
const { pipeline } = require('stream/promises');
const { writeFileSync, mkdirpSync, createWriteStream, ensureDir } = require('fs-extra');
const { join } = require('path');
const { openEnvironment } = require('../../utility/lmdb/environmentUtility');
const { statDBI } = require('../lmdb/environmentUtility');
const env_mgr = require('../environment/environmentManager');
const hdb_log = require('../logging/harper_logger');
const {
	getSchemaPath,
	getSystemSchemaPath,
} = require('../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');
const { SYSTEM_TABLE_NAMES, SYSTEM_SCHEMA_NAME, CONFIG_PARAMS } = require('../hdbTerms');

const SYSTEM_TABLES_TO_CLONE = [
	SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
	SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME,
	SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
	SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
	SYSTEM_TABLE_NAMES.USER_TABLE_NAME,
];

let backup_date = new Map();

const deets = {
	username: 'admin',
	password: 'Abc1234!',
	url: 'http://3.15.193.240:9925',
};

async function cloneNode() {
	hdb_log.notify('Cloning node: ' + deets.url);
	console.log('Cloning node: ' + deets.url);
	await cloneTables();

	hdb_log.info('Successfully cloned node: ' + deets.url);
	console.log('Successfully cloned node: ' + deets.url);
}

async function cloneConfig() {
	let remote_config = await httpReq({ operation: 'get_configuration' });
	remote_config = await remote_config.json();
	const remote_routes = remote_config?.clustering?.hubServer?.clustering?.network?.routes;
	const cluster_user_name = remote_config?.clustering?.user;

	// If the remote node has routes set in its config, concat them with any routes on this node and update config
	if (Array.isArray(remote_routes)) {
		const routes = env_mgr.get(CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES);
		const updated_routes = Array.isArray(routes) ? routes.concat(remote_routes) : remote_routes;
	}
}

async function cloneTables() {
	// Get all the non-system schema/table from remote node
	let remote_schemas = await httpReq({ operation: 'describe_all' });
	remote_schemas = await remote_schemas.json();

	//TODO: check for a 200 response before cloning table
	for (const sys_table of SYSTEM_TABLES_TO_CLONE) {
		hdb_log.info(`Cloning system table: ${sys_table} from node: ${deets.url}`);
		const sys_backup = await httpReq({ operation: 'get_backup', schema: SYSTEM_SCHEMA_NAME, table: sys_table });
		const sys_schema_path = getSystemSchemaPath();
		await ensureDir(sys_schema_path);
		await pipeline(sys_backup.body, createWriteStream(join(sys_schema_path, sys_table + '.mdb'), { overwrite: true }));
	}

	for (const schema in remote_schemas) {
		for (const table in remote_schemas[schema]) {
			hdb_log.info(`Cloning schema.table: ${schema}.${table} from node: ${deets.url}`);
			const primary_key = remote_schemas[schema][table]['hash_attribute'];
			const remote_record_count = remote_schemas[schema][table]['record_count'];

			// Stream table backup from remote node to this node.
			const backup = await httpReq({ operation: 'get_backup', schema, table });
			const schema_path = getSchemaPath(schema, table);
			await ensureDir(schema_path);
			await pipeline(backup.body, createWriteStream(join(schema_path, table + '.mdb')));

			// Open the backup table and get its entry count to confirm record counts closely match.
			const env = await openEnvironment(schema_path, table);
			const dbi_stat = statDBI(env, primary_key);
			const record_count = dbi_stat.entryCount;

			// We allow for a 5% difference in count to account for any changes on remote after taking backup snapshot.
			if (remote_record_count <= record_count * 0.95 && remote_record_count >= record_count * 1.05) {
				throw new Error(
					`Something has gone wrong. The record count for remote table '${table}' is inconsistent with the record count on this node. 
					Remote node record count: ${remote_record_count}. This nodes record count: ${record_count}`
				);
			}
		}
	}
}

async function httpReq(req) {
	const auth = Buffer.from(deets.username + ':' + deets.password).toString('base64');
	return await fetch(deets.url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': 'Basic ' + auth,
		},
		body: JSON.stringify(req),
	});
}

cloneNode()
	.then(() => {})
	.catch((err) => {
		console.log(err);
	});
