import { initSync, getHdbBasePath } from '../utility/environment/environmentManager';
import { INTERNAL_DBIS_NAME } from '../utility/lmdb/terms';
import { open } from 'lmdb';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { getBaseSchemaPath } from '../data_layer/harperBridge/lmdbBridge/lmdbUtility/initializePaths';
const OpenDBIObject = require('./OpenDBIObject');
const OpenEnvironmentObject = require('./OpenEnvironmentObject');
initSync();

export let database = {};
export function initTables() {
	let base_path = getHdbBasePath();
	let root_database = join(base_path, 'data.mdb');

	if (existsSync(root_database)) {
		readMetaDb(base_path);
	}
	for (let schema_entry of readdirSync(getBaseSchemaPath())) {
		let schema_path = join(getBaseSchemaPath, schema_entry);
		for (let table_entry of readdirSync(getBaseSchemaPath())) {
			readMetaDb(join(schema_path, table_entry), table_entry.split('.')[0], schema_entry);
		}
	}
}
function readMetaDb(path: string, default_table?: string, default_schema: string = 'default') {
	let env_init = new OpenEnvironmentObject(
		path,
		false
	);
	let database_object = {};
	let env = open(env_init);
	let dbi_init = new OpenDBIObject(false);
	let dbis_db = env.openDB(INTERNAL_DBIS_NAME, dbi_init);
	for (let { key, value } of dbis_db.getRange()) {
		let [ schema_name, table_name, attribute ] = key.split('.');
		if (!attribute) {
			attribute = table_name;
			table_name = schema_name;
			schema_name = default_schema;
		}
		if (!attribute) {
			attribute = table_name;
			table_name = default_table;
		}
		let schema_object = default_schema === 'default' ? database_object : database_object[default_schema];
		schema_object[table_name] = new Table(env.openDB(table_name, dbi_init));
	}
}

