import { initSync, getHdbBasePath, get as env_get } from '../utility/environment/environmentManager';
import { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } from '../utility/lmdb/terms';
import { open } from 'lmdb';
import { join, extname, basename } from 'path';
import { existsSync, readdirSync, DirEnt } from 'fs';
import { getBaseSchemaPath, getTransactionAuditStoreBasePath } from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths';
import { makeTable } from './Table';
import * as OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import * as OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
const DEFAULT_DATABASE_NAME = 'data';
const DATABASE_PATH = 'database';
initSync();

const USE_AUDIT = true; // TODO: Get this from config
export let tables = null;
export let databases = {};
let loaded_databases;
let database_envs = new Map<string, any>();

/**
 * This gets the set of tables from the default database ("data").
 */
export function getTables() {
	return getDatabases().data || {};
}

/**
 * This provides the main entry point for getting the set of all HarperDB tables (organized by schemas/databases).
 * This proactively scans the known
 * databases/schemas directories and finds any databases and opens them. This done proactively so that there is a fast
 * object available to all consumers that doesn't require runtime checks for database open states.
 * This also attaches the audit store associated with table. Note that legacy tables had a single audit table per db table
 * but in newer multi-table databases, there is one consistent, integrated audit table for the database since transactions
 * can span any tables in the database.
 */
export function getDatabases() {
	if (loaded_databases) return databases;
	loaded_databases = true;
	const database_path = process.env.STORAGE_PATH || env_get(CONFIG_PARAMS.STORAGE_PATH) || join(getHdbBasePath(), DATABASE_PATH);
	// First load all the databases from our main database folder
	// TODO: Load any databases defined with explicit storage paths from the config
	if (existsSync(database_path)) {
		for (let database_entry: DirEnt of readdirSync(database_path, { withFileTypes: true })) {
			if (database_entry.isFile() && extname(database_entry.name).toLowerCase() === '.mdb') {
				readMetaDb(join(database_path, database_entry.name), null, basename(database_entry.name, '.mdb'));
			}
		}
	}
	// now we load databases from the legacy "schema" directory folder structure
	if (existsSync(getBaseSchemaPath())) {
		for (let schema_entry: DirEnt of readdirSync(getBaseSchemaPath(), {withFileTypes: true})) {
			if (!schema_entry.isFile()) {
				let schema_path = join(getBaseSchemaPath(), schema_entry.name);
				let schema_audit_path = join(getTransactionAuditStoreBasePath(), schema_entry.name);
				for (let table_entry: DirEnt of readdirSync(schema_path, {withFileTypes: true})) {
					if (table_entry.isFile() && extname(table_entry.name).toLowerCase() === '.mdb') {
						let audit_path = join(schema_audit_path, table_entry.name);
						readMetaDb(join(schema_path, table_entry.name), basename(table_entry.name, '.mdb'), schema_entry.name, audit_path);
					}
				}
			}
		}
	}
	return databases;
}

/**
 * This is responsible for reading the internal dbi to get a list of all the tables and their indexed or registered attributes
 * @param path
 * @param default_table
 * @param default_schema
 */
function readMetaDb(path: string, default_table?: string, default_schema: string = DEFAULT_DATABASE_NAME, audit_path?: string) {
	let env_init = new OpenEnvironmentObject(
		path,
		false
	);
	try {
		let env = open(env_init);
		database_envs.set(path, env);
		let internal_dbi_init = new OpenDBIObject(false);
		let dbis_store = env.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
		let audit_store;
		if (USE_AUDIT) {
			if (audit_path) {
				if (existsSync(audit_path)) {
					env_init.path = audit_path;
					audit_store = open(env_init);
					audit_store.isLegacy = true;
				}
			} else {
				audit_store = env.openDB(AUDIT_STORE_NAME, internal_dbi_init);
			}
		}

		for (let { key, value } of dbis_store.getRange({ start: false })) {
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
			if (value.is_hash_attribute) {
				let table = tables[table_name] = makeTable({
					primaryStore: env.openDB(key.toString(), dbi_init),
					auditStore: audit_store,
					tableName: table_name,
					primaryKey: value.name,
					indices: {},
				});
			}
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
}

/**
 * This can be called to ensure that the specified table exists and if it does not exist, it should be created.
 * @param table_name
 * @param database_name
 * @param custom_path
 * @param expiration
 * @param attributes
 * @param audit
 */
export async function table({ table: table_name, database: database_name, expiration, attributes, audit }: TableDefinition) {
	if (!database_name) database_name = DEFAULT_DATABASE_NAME;
	let Table = databases[database_name]?.[table_name];
	let root_store;
	let primary_key;
	let primary_key_attribute
	let indices;
	if (Table) {
		primary_key = Table.primaryKey;
		root_store = Table.primaryStore;
	} else {
		let tables = databases[database_name] || (databases[database_name] = Object.create(null));
		// TODO: How to get the storage path from env?
		let database_path = process.env.STORAGE_PATH || env_get(CONFIG_PARAMS.STORAGE_PATH) || join(getHdbBasePath(), DATABASE_PATH);
		let path = join(database_path, database_name + '.mdb');
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
		let audit_store = root_store.auditStore;
		if (!audit_store && audit) {
			audit_store = root_store.openDB(AUDIT_STORE_NAME, {});
		}
		primary_key_attribute = attributes.find(attribute => attribute.is_primary_key);
		primary_key = primary_key_attribute.name;
		primary_key_attribute.is_hash_attribute = true;
		let dbi_init = new OpenDBIObject(!primary_key_attribute.is_primary_key, primary_key_attribute.is_primary_key);
		let dbi_name = table_name + '.' + primary_key_attribute.name;
		Table = tables[table_name] = makeTable({
			primaryStore: root_store.openDB(dbi_name, dbi_init),
			auditStore: audit_store,
			primaryKey: primary_key,
			tableName: table_name,
			indices: [],
		});
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
			for (let entry of Table.primaryStore.getRange()) {
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

