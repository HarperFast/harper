import { initSync, getHdbBasePath } from '../utility/environment/environmentManager';
import { INTERNAL_DBIS_NAME } from '../utility/lmdb/terms';
import { pack } from 'msgpackr';
import { open } from 'lmdb';
import { join, extname } from 'path';
import { existsSync, readdirSync } from 'fs';
import { getBaseSchemaPath } from '../data_layer/harperBridge/lmdbBridge/lmdbUtility/initializePaths';
import { Table } from './Table';
import * as OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import * as OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
initSync();
pack({})
export let tables = {};
export function initTables() {
	let base_path = getHdbBasePath();
	let root_database = join(base_path, 'data.mdb');

	if (existsSync(root_database)) {
		readMetaDb(base_path);
	}
	let schemas_base_path = getBaseSchemaPath();
	for (let schema_entry of readdirSync(schemas_base_path)) {
		let schema_path = join(schemas_base_path, schema_entry);
		for (let table_entry of readdirSync(schema_path)) {
			if (extname(table_entry).toLowerCase() === '.mdb')
				readMetaDb(join(schema_path, table_entry), table_entry.split('.')[0], schema_entry);
		}
	}
}
function readMetaDb(path: string, default_table?: string, default_schema: string = 'default') {
	let env_init = new OpenEnvironmentObject(
		path,
		false
	);
	try {
		let env = open(env_init);
		let dbi_init = new OpenDBIObject(false);
		let dbis_db = env.openDB(INTERNAL_DBIS_NAME, dbi_init);
		for (let {key, value} of dbis_db.getRange({start: false})) {
			let [schema_name, table_name, attribute] = key.toString().split('.');
			if (!attribute) {
				attribute = table_name;
				table_name = schema_name;
				schema_name = default_schema;
			}
			if (!attribute) {
				attribute = table_name;
				table_name = default_table;
			}
			let schema_object = default_schema === 'default' ? tables : (tables[default_schema] || (tables[default_schema] = {}));
			schema_object[table_name] = new Table(env.openDB(table_name, dbi_init), {});
		}
	} catch (error) {
		// @ts-ignore
		throw new Error(`Error opening database ${path}`, { cause: error });
	}
}

