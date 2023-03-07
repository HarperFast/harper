import { initSync, getHdbBasePath } from '../utility/environment/environmentManager';
import { INTERNAL_DBIS_NAME } from '../utility/lmdb/terms';
import { pack } from 'msgpackr';
import { open } from 'lmdb';
import { join, extname, basename } from 'path';
import { existsSync, readdirSync, DirEnt } from 'fs';
import { getBaseSchemaPath, getTransactionAuditStoreBasePath } from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths';
import { makeTable } from './Table';
import * as OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import * as OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
const DEFAULT_DATABASE_NAME = 'data';
const DATABASE_PATH = 'database';
const AUDIT_PATH = 'transactions';
initSync();

const USE_AUDIT = true; // TODO: Get this from config
export let tables = null;
export let databases = {};
let loaded_databases, loaded_audit_dbs;
export let auditDbs = {};
let database_envs = new Map<string, any>();
export function getTables() {
	return getDatabases().data || {};
}

export function getDatabases() {
	if (!loaded_databases) return databases;
	loaded_databases = true;
	loadDatabases(databases, join(getHdbBasePath(), DATABASE_PATH), getBaseSchemaPath());
	return databases;
}
export function getAuditDbs() {
	if (!loaded_audit_dbs) return auditDbs;
	loaded_audit_dbs = true;
	auditDbs = {};
	let base_path = getTransactionAuditStoreBasePath();
	loadDatabases(auditDbs, join(getHdbBasePath(), AUDIT_PATH), getTransactionAuditStoreBasePath());
	return auditDbs;
}
export function loadDatabases(databases, database_path, schemas_base_path) {
	// First load all the databases from our main database folder
	if (existsSync(database_path)) {
		for (let database_entry: DirEnt of readdirSync(database_path, { withFileTypes: true })) {
			if (database_entry.isFile() && extname(database_entry.name).toLowerCase() === '.mdb') {
				readMetaDb(join(database_path, database_entry.name), null, basename(database_entry.name, '.mdb'));
			}
		}
	}
	// TODO: Load any databases defined with explicit storage paths from the config
	// now we load databases from the legacy "schema" directory folder structure
	if (existsSync(schemas_base_path)) {
		for (let schema_entry: DirEnt of readdirSync(schemas_base_path, {withFileTypes: true})) {
			if (!schema_entry.isFile()) {
				let schema_path = join(schemas_base_path, schema_entry.name);
				for (let table_entry: DirEnt of readdirSync(schema_path, {withFileTypes: true})) {
					if (table_entry.isFile() && extname(table_entry.name).toLowerCase() === '.mdb')
						readMetaDb(join(schema_path, table_entry.name), basename(table_entry.name, '.mdb'), schema_entry.name);
				}
			}
		}
	}
	tables = databases[DEFAULT_DATABASE_NAME] || {};
}
function readMetaDb(path: string, default_table?: string, default_schema: string = DEFAULT_DATABASE_NAME) {
	let env_init = new OpenEnvironmentObject(
		path,
		false
	);
	try {
		let env = open(env_init);
		database_envs.set(path, env);
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
			let tables = databases[schema_name] || (databases[schema_name] = Object.create(null));
			let dbi_init = new OpenDBIObject(!value.is_hash_attribute, value.is_hash_attribute);
			if (value.is_hash_attribute)
				tables[table_name] = makeTable({
					primaryDbi: env.openDB(key.toString(), dbi_init),
					tableName: table_name,
					primaryKey: value.name,
					indices: {},
				});
		}
		return env;
	} catch (error) {
		// @ts-ignore
		throw new Error(`Error opening database ${path}`, { cause: error });
	}
}
interface TableDefinition {
	table: string
	database?: string
	path?: string
	expiration?: number
	attributes: any[]
	isAudit?: boolean
}
export async function table({ table: table_name, database: database_name, path: custom_path, expiration, attributes, isAudit }: TableDefinition) {
	if (!database_name) database_name = DEFAULT_DATABASE_NAME;
	let dbs = isAudit ? auditDbs : databases;
	let Table = dbs[database_name]?.[table_name];
	let root_store;
	let primary_key;
	let primary_key_attribute
	let indices;
	if (Table) {
		primary_key = Table.primaryKey;
		root_store = Table.primaryDbi;
	} else {
		let tables = dbs[database_name] || (dbs[database_name] = Object.create(null));
		let path = join(custom_path || join(getHdbBasePath(), isAudit ? AUDIT_PATH : DATABASE_PATH), database_name + '.mdb');
		root_store = database_envs.get(path);
		if (!root_store) {
			// TODO: validate database name
			let env_init = new OpenEnvironmentObject(
				path,
				false
			);
			root_store = open(env_init);
			database_envs.set(path, root_store);
		}
		primary_key_attribute = attributes.find(attribute => attribute.is_primary_key);
		primary_key = primary_key_attribute.name;
		primary_key_attribute.is_hash_attribute = true;
		let dbi_init = new OpenDBIObject(!primary_key_attribute.is_primary_key, primary_key_attribute.is_primary_key);
		let dbi_name = table_name + '.' + primary_key_attribute.name;
		Table = tables[table_name] = makeTable({
			primaryDbi: root_store.openDB(dbi_name, dbi_init),
			primaryKey: primary_key,
			tableName: table_name,
			indices: [],
		});
		let has_audit_table = !isAudit && USE_AUDIT && !custom_path;
		if (has_audit_table)
			await table({ table: table_name, database: database_name, path: custom_path, expiration, attributes, isAudit: true });
	}
	indices = Table.indices;
	let internal_dbi_init = new OpenDBIObject(false);
	let dbis_db = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
	Table.dbisDB = dbis_db;

	let last_commit;
	// iterate through the attributes to ensure that we have all the dbis created and indexed
	for (let attribute of attributes || []) {
		// non-indexed attributes do not need a dbi
		if (!attribute.indexed || attribute.is_primary_key) continue;
		let dbi_name = table_name + '.' + attribute.name;
		if (attribute.is_primary_key)
			attribute.is_hash_attribute = true;
		let dbi_init = new OpenDBIObject(true, false);
		let dbi = root_store.openDB(dbi_name, dbi_init);
		let dbi_descriptor = dbis_db.get(dbi_name);
		if (!dbi_descriptor) {
			let property = attribute.name;
			// this means that a new attribute has been introduced that needs to be indexed
			for (let entry of Table.primaryDbi.getRange()) {
				let record = entry.value;
				let value_to_index = record[property];
				dbi.put(value_to_index, record[primary_key]);
				// TODO: put in indexing code
			}
			dbis_db.put(dbi_name, attribute);
			last_commit = dbi.committed;
		}
		indices[attribute.name] = dbi;
	}
	if (last_commit) await last_commit;
	if (expiration)
		Table.setTTLExpiration(+expiration);
	return Table;
}

