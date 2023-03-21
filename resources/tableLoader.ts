import { initSync, getHdbBasePath, get as env_get } from '../utility/environment/environmentManager';
import { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } from '../utility/lmdb/terms';
import { open } from 'lmdb';
import { join, extname, basename } from 'path';
import { existsSync, readdirSync, DirEnt } from 'fs';
import {
	getBaseSchemaPath,
	getTransactionAuditStoreBasePath,
} from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths';
import { makeTable } from './Table';
import * as OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import * as OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
import { CONFIG_PARAMS, LEGACY_DATABASES_DIR_NAME } from '../utility/hdbTerms';
const DEFAULT_DATABASE_NAME = 'data';
initSync();

const USE_AUDIT = true; // TODO: Get this from config
export const tables = null;
export const databases = {};
let loaded_databases;
const database_envs = new Map<string, any>();

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
	const database_path =
		process.env.STORAGE_PATH ||
		env_get(CONFIG_PARAMS.STORAGE_PATH) ||
		join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME);
	// First load all the databases from our main database folder
	// TODO: Load any databases defined with explicit storage paths from the config
	if (existsSync(database_path)) {
		for (const database_entry: DirEnt of readdirSync(database_path, { withFileTypes: true })) {
			if (database_entry.isFile() && extname(database_entry.name).toLowerCase() === '.mdb') {
				readMetaDb(join(database_path, database_entry.name), null, basename(database_entry.name, '.mdb'));
			}
		}
	}
	// now we load databases from the legacy "schema" directory folder structure
	if (existsSync(getBaseSchemaPath())) {
		for (const schema_entry: DirEnt of readdirSync(getBaseSchemaPath(), { withFileTypes: true })) {
			if (!schema_entry.isFile()) {
				const schema_path = join(getBaseSchemaPath(), schema_entry.name);
				const schema_audit_path = join(getTransactionAuditStoreBasePath(), schema_entry.name);
				for (const table_entry: DirEnt of readdirSync(schema_path, { withFileTypes: true })) {
					if (table_entry.isFile() && extname(table_entry.name).toLowerCase() === '.mdb') {
						const audit_path = join(schema_audit_path, table_entry.name);
						readMetaDb(
							join(schema_path, table_entry.name),
							basename(table_entry.name, '.mdb'),
							schema_entry.name,
							audit_path
						);
					}
				}
			}
		}
	}
	const schema_configs = env_get(CONFIG_PARAMS.SCHEMAS);
	if (schema_configs) {
		for (const db_name in schema_configs) {
			const schema_config = schema_configs[db_name];
			const database_path = schema_config.path;
			if (existsSync(database_path)) {
				for (const database_entry: DirEnt of readdirSync(database_path, { withFileTypes: true })) {
					if (database_entry.isFile() && extname(database_entry.name).toLowerCase() === '.mdb') {
						readMetaDb(join(database_path, database_entry.name), null, db_name);
					}
				}
			}
			const table_configs = schema_config.tables;
			if (table_configs) {
				for (const table_name in table_configs) {
					const table_config = table_configs[table_name];
					const table_path = join(table_config.path, 'data.mdb');
					if (existsSync(table_path)) {
						readMetaDb(table_path, table_name, db_name);
					}
				}
			}
			//TODO: Iterate configured table paths
		}
	}
	return databases;
}

/**
 * This is responsible for reading the internal dbi to get a list of all the tables and their indexed or registered attributes
 * @param path
 * @param default_table
 * @param schema_name
 */
function readMetaDb(
	path: string,
	default_table?: string,
	schema_name: string = DEFAULT_DATABASE_NAME,
	audit_path?: string
) {
	const env_init = new OpenEnvironmentObject(path, false);
	try {
		const root_store = open(env_init);
		database_envs.set(path, root_store);
		const internal_dbi_init = new OpenDBIObject(false);
		const dbis_store = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
		let audit_store;
		if (USE_AUDIT) {
			if (audit_path) {
				if (existsSync(audit_path)) {
					env_init.path = audit_path;
					audit_store = open(env_init);
					audit_store.isLegacy = true;
				}
			} else {
				audit_store = root_store.openDB(AUDIT_STORE_NAME, internal_dbi_init);
			}
		}

		const tables_to_load = new Map();
		for (const { key, value } of dbis_store.getRange({ start: false })) {
			let [table_name, attribute] = key.toString().split('/');
			if (!attribute) {
				attribute = table_name;
				table_name = default_table;
				value.name = attribute;
			}
			let attributes = tables_to_load.get(table_name);
			if (!attributes) tables_to_load.set(table_name, (attributes = []));
			attributes.push(value);
			value.key = key;
		}
		const tables = databases[schema_name] || (databases[schema_name] = Object.create(null));
		for (const [table_name, attributes] of tables_to_load) {
			for (const attribute of attributes) {
				const dbi_init = new OpenDBIObject(!attribute.is_hash_attribute, attribute.is_hash_attribute);
				if (attribute.is_hash_attribute) {
					let table_id = attribute.tableId;
					if (table_id) {
						if (table_id >= (root_store.nextTableId || 0)) root_store.nextTableId = table_id + 1;
					} else {
						if (!root_store.nextTableId) root_store.nextTableId = 1;
						attribute.tableId = table_id = root_store.nextTableId++;
						dbis_store.putSync(attribute.key, attribute);
					}
					const primary_store = root_store.openDB(attribute.key, dbi_init);
					primary_store.tableId = table_id;
					const indices = {};
					for (const attribute of attributes) {
						if (!attribute.is_hash_attribute) {
							const dbi_init = new OpenDBIObject(!attribute.is_hash_attribute, attribute.is_hash_attribute);
							indices[attribute.name] = root_store.openDB(attribute.key, dbi_init);
						}
					}
					const table = (tables[table_name] = makeTable({
						primaryStore: primary_store,
						auditStore: audit_store,
						tableName: table_name,
						primaryKey: attribute.name,
						indices,
						attributes,
					}));
				}
			}
		}
		return root_store;
	} catch (error) {
		// @ts-ignore
		throw new Error(`Error opening database ${path}`, { cause: error });
	}
}
interface TableDefinition {
	table: string;
	database?: string;
	path?: string;
	expiration?: number;
	attributes: any[];
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
export function table({ table: table_name, database: database_name, expiration, attributes }: TableDefinition) {
	if (!database_name) database_name = DEFAULT_DATABASE_NAME;
	getDatabases();
	let Table = databases[database_name]?.[table_name];
	let root_store;
	let primary_key;
	let primary_key_attribute;
	let indices;
	let dbis_db;
	const internal_dbi_init = new OpenDBIObject(false);

	for (const attribute of attributes) {
		if (attribute.attribute) {
			// there is some code that calls the attribute's name the attribute's attribute
			attribute.name = attribute.attribute;
			attribute.indexed = true;
		}
	}
	let txn_commit;
	if (Table) {
		primary_key = Table.primaryKey;
		root_store = Table.primaryStore;
	} else {
		const tables = databases[database_name] || (databases[database_name] = Object.create(null));
		const table_path = env_get(CONFIG_PARAMS.SCHEMAS)?.[database_name]?.tables?.[table_name]?.path;
		const database_path =
			table_path ||
			env_get(CONFIG_PARAMS.SCHEMAS)?.[database_name]?.path ||
			process.env.STORAGE_PATH ||
			env_get(CONFIG_PARAMS.STORAGE_PATH) ||
			join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME);
		const path = join(database_path, table_path ? 'data.mdb' : database_name + '.mdb');
		root_store = database_envs.get(path);
		if (!root_store) {
			// TODO: validate database name
			const env_init = new OpenEnvironmentObject(path, false);
			root_store = open(env_init);
			database_envs.set(path, root_store);
		}
		let audit_store = root_store.auditStore;
		if (!audit_store && USE_AUDIT) {
			audit_store = root_store.openDB(AUDIT_STORE_NAME, {});
		}
		primary_key_attribute = attributes.find((attribute) => attribute.is_primary_key);
		primary_key = primary_key_attribute.name;
		primary_key_attribute.is_hash_attribute = true;
		const dbi_init = new OpenDBIObject(!primary_key_attribute.is_primary_key, primary_key_attribute.is_primary_key);
		const dbi_name = table_name + '/' + primary_key_attribute.name;
		const primary_store = root_store.openDB(dbi_name, dbi_init);
		if (!root_store.env.nextTableId) root_store.env.nextTableId = 1;
		primary_store.tableId = root_store.env.nextTableId++;
		primary_key_attribute.tableId = primary_store.tableId;
		Table = tables[table_name] = makeTable({
			primaryStore: primary_store,
			auditStore: audit_store,
			primaryKey: primary_key,
			tableName: table_name,
			indices: [],
			attributes,
		});
		dbis_db = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
		startTxn();
		dbis_db.put(dbi_name, primary_key_attribute);
	}
	indices = Table.indices;
	dbis_db = dbis_db || root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
	Table.dbisDB = dbis_db;
	try {
		// iterate through the attributes to ensure that we have all the dbis created and indexed
		for (const attribute of attributes || []) {
			// non-indexed attributes do not need a dbi
			if (!attribute.indexed || attribute.is_primary_key) continue;
			const dbi_name = table_name + '/' + attribute.name;
			const dbi_init = new OpenDBIObject(true, false);
			const dbi = root_store.openDB(dbi_name, dbi_init);
			const dbi_descriptor = dbis_db.get(dbi_name);
			if (!dbi_descriptor) {
				startTxn();
				const property = attribute.name;
				// this means that a new attribute has been introduced that needs to be indexed
				for (const entry of Table.primaryStore.getRange()) {
					const record = entry.value;
					const value_to_index = record[property];
					dbi.put(value_to_index, record[primary_key]);
					// TODO: put in indexing code
				}
				dbis_db.put(dbi_name, attribute);
			}
			indices[attribute.name] = dbi;
		}
	} finally {
		if (txn_commit) txn_commit();
	}
	if (expiration) Table.setTTLExpiration(+expiration);
	return Table;
	function startTxn() {
		if (txn_commit) return;
		root_store.transactionSync(() => {
			return {
				then(callback) {
					txn_commit = callback;
				},
			};
		});
	}
}
