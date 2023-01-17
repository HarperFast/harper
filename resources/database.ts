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

export let tables = null;
let root_env;
export function getTables() {
	if (tables) return tables;
	tables = {};
	let base_path = getHdbBasePath();
	let root_database = join(base_path, 'data.mdb');

	if (existsSync(root_database)) {
		root_env = readMetaDb(base_path);
	}
	let schemas_base_path = getBaseSchemaPath();
	for (let schema_entry of readdirSync(schemas_base_path)) {
		let schema_path = join(schemas_base_path, schema_entry);
		for (let table_entry of readdirSync(schema_path)) {
			if (extname(table_entry).toLowerCase() === '.mdb')
				readMetaDb(join(schema_path, table_entry), table_entry.split('.')[0], schema_entry);
		}
	}
	return tables;
}
function readMetaDb(path: string, default_table?: string, default_schema: string = 'default') {
	let env_init = new OpenEnvironmentObject(
		path,
		false
	);
	try {
		let env = open(env_init);
		let internal_dbi_init = new OpenDBIObject(false);
		let dbis_db = env.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
		for (let { key, value } of dbis_db.getRange({ start: false })) {
			let [ schema_name, table_name, attribute ] = key.toString().split('.');
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
			let dbi_init = new OpenDBIObject(!value.is_hash_attribute, value.is_hash_attribute);
			if (value.is_hash_attribute)
				schema_object[table_name] = new Table(env.openDB(key.toString(), dbi_init), { tableName: table_name });
		}
		return env;
	} catch (error) {
		// @ts-ignore
		throw new Error(`Error opening database ${path}`, { cause: error });
	}
}

export function ensureTable(table_name: string, attributes: any[], schema_name?: string) {
	let table = (schema_name ? tables[schema_name] : tables)?.[table_name];
	if (table) return table;
	if (!root_env) {
		let base_path = getHdbBasePath();
		let root_database_path = join(base_path, 'data.mdb');
		let env_init = new OpenEnvironmentObject(
			root_database_path,
			false
		);
		root_env = open(env_init);
	}
	let internal_dbi_init = new OpenDBIObject(false);
	let dbis_db = root_env.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
	let primary_key;
	for (let attribute of attributes) {
		let dbi_name = table_name + '.' + attribute.name;
		dbis_db.put(dbi_name, attribute);
		if (attribute.is_hash_attribute) {
			primary_key = attribute.name;
			let dbi_init = new OpenDBIObject(!attribute.is_hash_attribute, attribute.is_hash_attribute);
			tables[table_name] = new Table(root_env.openDB(dbi_name, dbi_init), {});
		}
	}
}

/**
 * Get a table transaction for the given schema/table
 */
export function getTableTxn(table_name: string, schema_name: string) {
	let table = tables[schema_name || 'default']?.[table_name];
	return table.transaction()
}