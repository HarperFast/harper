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
import OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
import { CONFIG_PARAMS, LEGACY_DATABASES_DIR_NAME, DATABASES_DIR_NAME } from '../utility/hdbTerms';
import * as fs from 'fs-extra';
import { _assignPackageExport } from '../index';
import { getIndexedValues } from '../utility/lmdb/commonUtility';
import * as signalling from '../utility/signalling';
import { SchemaEventMsg } from '../server/threads/itc';
import { workerData } from 'worker_threads';
import * as harper_logger from '../utility/logging/harper_logger';

const DEFAULT_DATABASE_NAME = 'data';
const DEFINED_TABLES = Symbol('defined-tables');
initSync();

interface Tables {
	[table_name: string]: ReturnType<typeof makeTable>;
}
interface Databases {
	[database_name: string]: Tables;
}
const USE_AUDIT = true; // TODO: Get this from config
export const tables: Tables = Object.create(null);
export const databases: Databases = Object.create(null);
_assignPackageExport('databases', databases);
_assignPackageExport('tables', tables);
const table_listeners = [];
let loaded_databases;
const database_envs = new Map<string, any>();
let defined_databases;
/**
 * This gets the set of tables from the default database ("data").
 */
export function getTables(): Tables {
	if (!loaded_databases) getDatabases();
	return tables || {};
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
export function getDatabases(): Databases {
	if (loaded_databases) return databases;
	loaded_databases = true;
	defined_databases = new Map();
	let database_path = getHdbBasePath() && join(getHdbBasePath(), DATABASES_DIR_NAME);
	const schema_configs = env_get(CONFIG_PARAMS.SCHEMAS) || {};
	// not sure why this doesn't work with the environmemt manager
	if (process.env.SCHEMAS_DATA_PATH) schema_configs.data = { path: process.env.SCHEMAS_DATA_PATH };
	database_path =
		process.env.STORAGE_PATH ||
		env_get(CONFIG_PARAMS.STORAGE_PATH) ||
		(database_path && (existsSync(database_path) ? database_path : join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME)));
	if (!database_path) return;
	if (existsSync(database_path)) {
		// First load all the databases from our main database folder
		// TODO: Load any databases defined with explicit storage paths from the config
		for (const database_entry: DirEnt of readdirSync(database_path, { withFileTypes: true })) {
			const db_name = basename(database_entry.name, '.mdb');
			if (
				database_entry.isFile() &&
				extname(database_entry.name).toLowerCase() === '.mdb' &&
				!schema_configs[db_name]?.path
			) {
				readMetaDb(join(database_path, database_entry.name), null, db_name);
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
							audit_path,
							true
						);
					}
				}
			}
		}
	}
	if (schema_configs) {
		for (const db_name in schema_configs) {
			const schema_config = schema_configs[db_name];
			const database_path = schema_config.path;
			if (existsSync(database_path)) {
				for (const database_entry: DirEnt of readdirSync(database_path, { withFileTypes: true })) {
					if (database_entry.isFile() && extname(database_entry.name).toLowerCase() === '.mdb') {
						readMetaDb(join(database_path, database_entry.name), basename(database_entry.name, '.mdb'), db_name);
					}
				}
			}
			const table_configs = schema_config.tables;
			if (table_configs) {
				for (const table_name in table_configs) {
					const table_config = table_configs[table_name];
					const table_path = join(table_config.path, 'data.mdb');
					if (existsSync(table_path)) {
						readMetaDb(table_path, table_name, db_name, null, true);
					}
				}
			}
			//TODO: Iterate configured table paths
		}
	}
	// now remove any databases or tables that have been removed
	for (const db_name in databases) {
		const defined_tables = defined_databases.get(db_name);
		if (defined_tables) {
			const tables = databases[db_name];
			for (const table_name in tables) {
				if (!defined_tables.has(table_name)) delete tables[table_name];
			}
			delete tables[DEFINED_TABLES];
		} else delete databases[db_name];
	}
	defined_databases = null;
	return databases;
}
export function resetDatabases() {
	loaded_databases = false;
	for (const [, store] of database_envs) {
		store.needsDeletion = true;
	}
	getDatabases();
	for (const [path, store] of database_envs) {
		if (store.needsDeletion) {
			store.close();
			database_envs.delete(path);
		}
	}
	return databases;
}

/**
 * This is responsible for reading the internal dbi to get a list of all the tables and their indexed or registered attributes
 * @param path
 * @param default_table
 * @param database_name
 */
function readMetaDb(
	path: string,
	default_table?: string,
	database_name: string = DEFAULT_DATABASE_NAME,
	audit_path?: string,
	is_legacy?: boolean
) {
	const env_init = new OpenEnvironmentObject(path, false);
	try {
		let root_store = database_envs.get(path);
		if (root_store) root_store.needsDeletion = false;
		else {
			root_store = open(env_init);
			database_envs.set(path, root_store);
		}
		const internal_dbi_init = new OpenDBIObject(false);
		const dbis_store =
			root_store.dbisDb || (root_store.dbisDb = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init));
		let audit_store = root_store.auditStore;
		if (USE_AUDIT && !audit_store) {
			if (audit_path) {
				if (existsSync(audit_path)) {
					env_init.path = audit_path;
					audit_store = open(env_init);
					audit_store.isLegacy = true;
				}
			} else {
				audit_store = root_store.auditStore = root_store.openDB(AUDIT_STORE_NAME, internal_dbi_init);
			}
		}

		const tables_to_load = new Map();
		for (const { key, value } of dbis_store.getRange({ start: false })) {
			let [table_name, attribute_name] = key.toString().split('/');
			if (!attribute_name) {
				attribute_name = table_name;
				table_name = default_table;
				value.name = attribute_name;
			}
			let attributes = tables_to_load.get(table_name);
			if (!attributes) tables_to_load.set(table_name, (attributes = []));
			attributes.push(value);
			Object.defineProperty(value, 'key', { value: key, configurable: true });
		}
		const tables = ensureDB(database_name);
		const existing_defined_tables = tables[DEFINED_TABLES];
		for (const [table_name, attributes] of tables_to_load) {
			for (const attribute of attributes) {
				// find the primary key attribute as that defines the table itself
				attribute.attribute = attribute.name;
				if (attribute.is_hash_attribute) {
					// if the table has already been defined, use that class, don't create a new one
					let table = existing_defined_tables?.get(table_name);
					let indices = {},
						existing_attributes = [];
					let table_id;
					let primary_store;
					if (table) {
						indices = table.indices;
						existing_attributes = table.attributes;
						table.schemaVersion++;
					} else {
						table_id = attribute.tableId;
						if (table_id) {
							if (table_id >= (root_store.nextTableId || 0)) root_store.nextTableId = table_id + 1;
						} else {
							if (!root_store.nextTableId) root_store.nextTableId = 1;
							attribute.tableId = table_id = root_store.nextTableId++;
							dbis_store.putSync(attribute.key, attribute);
						}
						const dbi_init = new OpenDBIObject(!attribute.is_hash_attribute, attribute.is_hash_attribute);
						primary_store = root_store.openDB(attribute.key, dbi_init);
						primary_store.tableId = table_id;
					}
					for (const attribute of attributes) {
						// now load the non-primary keys, opening the dbs as necessary for indices
						if (!attribute.is_hash_attribute) {
							if (!indices[attribute.name]) {
								const dbi_init = new OpenDBIObject(!attribute.is_hash_attribute, attribute.is_hash_attribute);
								indices[attribute.name] = root_store.openDB(attribute.key, dbi_init);
							}
							const existing_attribute = existing_attributes.find(
								(existing_attribute) => existing_attribute.name === attribute.name
							);
							if (existing_attribute)
								existing_attributes.splice(existing_attributes.indexOf(existing_attribute), 1, attribute);
							else existing_attributes.push(attribute);
						}
					}
					if (!table) {
						table = setTable(
							tables,
							table_name,
							makeTable({
								primaryStore: primary_store,
								auditStore: audit_store,
								tableName: table_name,
								tableId: table_id,
								primaryKey: attribute.name,
								databasePath: is_legacy ? database_name + '/' + table_name : database_name,
								databaseName: database_name,
								indices,
								attributes,
								schemaDefined: attribute.schemaDefined,
								dbisDB: dbis_store,
							})
						);
						table.schemaVersion = 1;
						for (const listener of table_listeners) {
							listener(table);
						}
					}
				}
			}
		}
		return root_store;
	} catch (error) {
		// @ts-ignore
		error.message += `Error opening database ${path}`;
		throw error;
	}
}
interface TableDefinition {
	table: string;
	database?: string;
	path?: string;
	expiration?: number;
	attributes: any[];
	schemaDefined?: boolean;
}
function ensureDB(database_name) {
	let db_tables = databases[database_name];
	if (!db_tables) {
		if (database_name === 'data')
			// preserve the data tables objet
			db_tables = databases[database_name] = tables;
		else if (database_name === 'system')
			// make system non-enumerable
			Object.defineProperty(databases, 'system', {
				value: (db_tables = Object.create(null)),
				configurable: true, // no enum
			});
		else {
			db_tables = databases[database_name] = Object.create(null);
		}
	}
	if (!db_tables[DEFINED_TABLES] && defined_databases) {
		const defined_tables = new Map(); // we create this so we can determine what was found in a reset and remove any removed dbs/tables
		db_tables[DEFINED_TABLES] = defined_tables;
		defined_databases.set(database_name, defined_tables);
	}
	return db_tables;
}
function setTable(tables, table_name, Table) {
	tables[table_name] = Table;
	const defined_tables = tables[DEFINED_TABLES];
	if (defined_tables) {
		defined_tables.set(table_name, Table);
	}
	return Table;
}
const ROOT_STORE_KEY = Symbol('root-store');
export function database({ database: database_name, table: table_name }) {
	if (!database_name) database_name = DEFAULT_DATABASE_NAME;
	getDatabases();
	const database = ensureDB(database_name);
	let root_store = database[ROOT_STORE_KEY];
	if (root_store) return root_store;
	let database_path = join(getHdbBasePath(), DATABASES_DIR_NAME);
	const table_path = table_name && env_get(CONFIG_PARAMS.SCHEMAS)?.[database_name]?.tables?.[table_name]?.path;
	database_path =
		table_path ||
		env_get(CONFIG_PARAMS.SCHEMAS)?.[database_name]?.path ||
		process.env.STORAGE_PATH ||
		env_get(CONFIG_PARAMS.STORAGE_PATH) ||
		(existsSync(database_path) ? database_path : join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME));
	const path = join(database_path, table_path ? 'data.mdb' : database_name + '.mdb');
	root_store = database_envs.get(path);
	if (!root_store) {
		// TODO: validate database name
		const env_init = new OpenEnvironmentObject(path, false);
		root_store = open(env_init);
		database_envs.set(path, root_store);
	}
	database[ROOT_STORE_KEY] = root_store;
	return root_store;
}

export async function dropDatabase(database_name) {
	if (!databases[database_name]) throw new Error('Schema does not exist');
	const root_store = database({ database: database_name });
	delete databases[database_name];
	database_envs.delete(root_store.path);
	await root_store.close();
	await fs.remove(root_store.path);
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
export function table({
	table: table_name,
	database: database_name,
	expiration,
	attributes,
	schemaDefined: schema_defined,
	origin,
}: TableDefinition) {
	if (!database_name) database_name = DEFAULT_DATABASE_NAME;
	const root_store = database({ database: database_name, table: table_name });
	const tables = databases[database_name];
	let Table = tables?.[table_name];
	let primary_key;
	let primary_key_attribute;
	let indices;
	let dbis_db;
	if (schema_defined == undefined) schema_defined = true;
	const internal_dbi_init = new OpenDBIObject(false);

	for (const attribute of attributes) {
		if (attribute.attribute) {
			// there is some legacy code that calls the attribute's name the attribute's attribute
			attribute.name = attribute.attribute;
			attribute.indexed = true;
		} else attribute.attribute = attribute.name;
	}
	let has_changes;
	let txn_commit;
	if (Table) {
		primary_key = Table.primaryKey;
		Table.attributes.splice(0, Table.attributes.length, ...attributes);
	} else {
		let audit_store = root_store.auditStore;
		if (!audit_store && USE_AUDIT) {
			root_store.auditStore = audit_store = root_store.openDB(AUDIT_STORE_NAME, {});
		}
		primary_key_attribute = attributes.find((attribute) => attribute.isPrimaryKey) || { name: 'id' };
		primary_key = primary_key_attribute.name;
		primary_key_attribute.is_hash_attribute = true;
		primary_key_attribute.schemaDefined = schema_defined;
		if (origin) {
			if (!primary_key_attribute.origins) primary_key_attribute.origins = [origin];
			else if (!primary_key_attribute.origins.includes(origin)) primary_key_attribute.origins.push(origin);
		}
		const dbi_init = new OpenDBIObject(!primary_key_attribute.isPrimaryKey, primary_key_attribute.isPrimaryKey);
		const dbi_name = table_name + '/' + primary_key_attribute.name;
		const primary_store = root_store.openDB(dbi_name, dbi_init);
		if (!root_store.env.nextTableId) root_store.env.nextTableId = 1;
		primary_store.tableId = root_store.env.nextTableId++;
		primary_key_attribute.tableId = primary_store.tableId;
		dbis_db = root_store.dbisDb = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
		Table = setTable(
			tables,
			table_name,
			makeTable({
				primaryStore: primary_store,
				auditStore: audit_store,
				primaryKey: primary_key,
				tableName: table_name,
				tableId: primary_store.tableId,
				databasePath: database_name,
				databaseName: database_name,
				indices: [],
				attributes,
				schemaDefined: schema_defined,
				dbisDB: dbis_db,
			})
		);
		Table.schemaVersion = 1;
		has_changes = true;
		startTxn();
		dbis_db.put(dbi_name, primary_key_attribute);
	}
	indices = Table.indices;
	dbis_db = dbis_db || (root_store.dbisDb = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init));
	Table.dbisDB = dbis_db;
	const indices_to_remove = [];
	for (const { key, value } of dbis_db.getRange({ start: true })) {
		let [attribute_table_name, attribute_name] = key.toString().split('/');
		if (attribute_name) {
			if (attribute_table_name !== table_name) continue;
		} else {
			attribute_name = attribute_table_name;
		}
		const existing_attribute = attributes.find((attribute) => attribute.name === attribute_name);
		if (!existing_attribute?.indexed && value.indexed) {
			startTxn();
			has_changes = true;
			dbis_db.remove(key);
			const index_dbi = Table.indices[attribute_table_name];
			if (index_dbi) indices_to_remove.push(index_dbi);
		}
	}
	const attributes_to_index = [];
	try {
		// TODO: If we have attributes and the schemaDefined flag is not set, turn it on
		// iterate through the attributes to ensure that we have all the dbis created and indexed
		for (const attribute of attributes || []) {
			// non-indexed attributes do not need a dbi
			if (!attribute.indexed || attribute.isPrimaryKey) continue;
			const dbi_name = table_name + '/' + attribute.name;
			Object.defineProperty(attribute, 'key', { value: dbi_name, configurable: true });
			const dbi_init = new OpenDBIObject(true, false);
			const dbi = root_store.openDB(dbi_name, dbi_init);
			let dbi_descriptor = dbis_db.get(dbi_name);
			if (schema_defined) {
				if (!dbi_descriptor || (dbi_descriptor.indexingPID && dbi_descriptor.indexingPID !== process.pid)) {
					startTxn();
					dbi_descriptor = dbis_db.get(dbi_name);
					if (
						!dbi_descriptor ||
						(dbi_descriptor.indexingPID && dbi_descriptor.indexingPID !== process.pid) ||
						dbi_descriptor.workerIndex === workerData.workerIndex
					) {
						has_changes = true;
						attribute.lastIndexedKey = dbi_descriptor?.lastIndexedKey || false;
						attribute.indexingPID = process.pid;
						dbi.isIndexing = true;
						Object.defineProperty(attribute, 'dbi', { value: dbi });
						dbis_db.put(dbi_name, attribute);
						attributes_to_index.push(attribute);
					}
				}
			} else {
				dbis_db.put(dbi_name, attribute);
			}
			indices[attribute.name] = dbi;
		}
	} finally {
		if (txn_commit) txn_commit();
	}
	if (has_changes) Table.schemaVersion++;
	if (attributes_to_index.length > 0 || indices_to_remove.length > 0) {
		Table.indexingOperation = runIndexing(Table, attributes_to_index, indices_to_remove);
	}
	Table.origin = origin;
	if (has_changes) {
		for (const listener of table_listeners) {
			listener(Table, true);
		}
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
const MAX_OUTSTANDING_INDEXING = 1000;
const MIN_OUTSTANDING_INDEXING = 10;
async function runIndexing(Table, attributes, indicesToRemove) {
	try {
		const schema_version = Table.schemaVersion;
		await signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'schema-change', Table.databaseName, Table.tableName)
		);
		let last_resolution;
		for (const index of indicesToRemove) {
			last_resolution = index.drop();
		}
		const attributes_length = attributes.length;
		if (attributes_length > 0) {
			let outstanding = 0;
			// this means that a new attribute has been introduced that needs to be indexed
			for (const { key, value: record, version } of Table.primaryStore.getRange({
				start: attributes[0].lastIndexedKey, // TODO: Choose the lowest key of the attributes
				lazy: attributes_length < 4,
				versions: true,
				snapshot: false, // don't hold a read transaction this whole time
			})) {
				if (!record) continue; // deletion entry
				if (Table.schemaVersion !== schema_version) return; // break out if there are any schema changes and let someone else pick it up
				let indexed = 0;
				outstanding++;
				// every index operation needs to be guarded by the version still be the same. If it has already changed before
				// we index, that's fine because indexing is idempotent, we can just put the same values again. If it changes
				// during the indexing, the indexing here will fail. This is also fine because it means the other thread will have
				// performed indexing and we don't need to do anything further
				last_resolution = Table.primaryStore.ifVersion(key, version, () => {
					for (let i = 0; i < attributes_length; i++) {
						const attribute = attributes[i];
						const property = attribute.name;
						const values = getIndexedValues(record[property]);
						if (values) {
							/*					if (LMDB_PREFETCH_WRITES)
													index.prefetch(
														values.map((v) => ({ key: v, value: id })),
														noop
													);*/
							for (let i = 0, l = values.length; i < l; i++) {
								attribute.dbi.put(values[i], key);
							}
						}
					}
				});
				last_resolution.then(
					() => outstanding--,
					(error) => {
						outstanding--;
						harper_logger.error(error);
					}
				);
				if (++indexed % 100 === 0) {
					// occasionally update our progress so if we crash, we can resume
					for (const attribute of attributes) {
						attribute.lastIndexedKey = key;
						Table.dbisDB.put(attribute.key, attribute);
					}
				}
				if (outstanding > MAX_OUTSTANDING_INDEXING) await last_resolution;
				else if (outstanding > MIN_OUTSTANDING_INDEXING) await new Promise((resolve) => setImmediate(resolve)); // yield event turn, don't want to use all computation
			}
			// update the attributes to indicate that we are finished
			for (const attribute of attributes) {
				delete attribute.lastIndexedKey;
				delete attribute.indexingPID;
				attribute.dbi.isIndexing = false;
				last_resolution = Table.dbisDB.put(attribute.key, attribute);
			}
		}
		await last_resolution;
		// now notify all the threads that we are done and the index is ready to use
		await signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'indexing-finished', Table.databaseName, Table.tableName)
		);
	} catch (error) {
		harper_logger.error('Error in indexing', error);
	}
}
/**
 * Once an origin has fully declared all the tables for a database, this can be run to remove any tables or attributes
 * that are unused.
 */
function cleanupDatabase(origin) {}

export function dropTableMeta({ table: table_name, database: database_name }) {
	const root_store = database({ database: database_name, table: table_name });
	const removals = [];
	const dbis_db = root_store.dbisDb;
	for (const key of dbis_db.getKeys({ start: table_name + '/', end: table_name + '0' })) {
		removals.push(dbis_db.remove(key));
	}
	return Promise.all(removals);
}

export function onNewTable(listener) {
	table_listeners.push(listener);
}
