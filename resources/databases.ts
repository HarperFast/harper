import { initSync, getHdbBasePath, get as env_get } from '../utility/environment/environmentManager';
import { INTERNAL_DBIS_NAME } from '../utility/lmdb/terms';
import { open, compareKeys } from 'lmdb';
import { join, extname, basename } from 'path';
import { existsSync, readdirSync } from 'fs';
import {
	getBaseSchemaPath,
	getTransactionAuditStoreBasePath,
} from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths';
import { makeTable } from './Table';
import OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
import { CONFIG_PARAMS, LEGACY_DATABASES_DIR_NAME, DATABASES_DIR_NAME } from '../utility/hdbTerms';
import * as fs from 'fs-extra';
import { _assignPackageExport } from '../globals';
import { getIndexedValues } from '../utility/lmdb/commonUtility';
import * as signalling from '../utility/signalling';
import { SchemaEventMsg } from '../server/threads/itc';
import { workerData, threadId } from 'worker_threads';
import * as harper_logger from '../utility/logging/harper_logger';
import * as manage_threads from '../server/threads/manageThreads';
import { openAuditStore, transactionKeyEncoder } from './auditStore';
import { handleLocalTimeForGets } from './RecordEncoder';

const DEFAULT_DATABASE_NAME = 'data';
const DEFINED_TABLES = Symbol('defined-tables');
const DEFAULT_COMPRESSION_THRESHOLD = (env_get(CONFIG_PARAMS.STORAGE_PAGESIZE) || 4096) - 60; // larger than this requires multiple pages
initSync();

interface Tables {
	[table_name: string]: ReturnType<typeof makeTable>;
}
interface Databases {
	[database_name: string]: Tables;
}

export const tables: Tables = Object.create(null);
export const databases: Databases = Object.create(null);
_assignPackageExport('databases', databases);
_assignPackageExport('tables', tables);
const NEXT_TABLE_ID = Symbol.for('next-table-id');
const table_listeners = [];
const db_removal_listeners = [];
let loaded_databases; // indicates if we have loaded databases from the file system yet
const database_envs = new Map<string, any>();
// This is used to track all the databases that are found when iterating through the file system so that anything that is missing
// can be removed:
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
	const schema_configs = env_get(CONFIG_PARAMS.DATABASES) || {};
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
		for (const database_entry of readdirSync(database_path, { withFileTypes: true })) {
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
		for (const schema_entry of readdirSync(getBaseSchemaPath(), { withFileTypes: true })) {
			if (!schema_entry.isFile()) {
				const schema_path = join(getBaseSchemaPath(), schema_entry.name);
				const schema_audit_path = join(getTransactionAuditStoreBasePath(), schema_entry.name);
				for (const table_entry of readdirSync(schema_path, { withFileTypes: true })) {
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
				for (const database_entry of readdirSync(database_path, { withFileTypes: true })) {
					if (database_entry.isFile() && extname(database_entry.name).toLowerCase() === '.mdb') {
						readMetaDb(join(database_path, database_entry.name), basename(database_entry.name, '.mdb'), db_name);
					}
				}
			}
			const table_configs = schema_config.tables;
			if (table_configs) {
				for (const table_name in table_configs) {
					const table_config = table_configs[table_name];
					const table_path = join(table_config.path, basename(table_name + '.mdb'));
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
			if (db_name.includes('delete')) harper_logger.trace(`defined tables ${Array.from(defined_tables.keys())}`);

			for (const table_name in tables) {
				if (!defined_tables.has(table_name)) {
					harper_logger.trace(`delete table class ${table_name}`);
					delete tables[table_name];
				}
			}
		} else {
			delete databases[db_name];
			if (db_name === 'data') {
				for (const table_name in tables) {
					delete tables[table_name];
				}
				delete tables[DEFINED_TABLES];
			}
		}
	}
	// I don't know if this is the best place for this, but somewhere we need to specify which tables
	// replicate by default:
	const NON_REPLICATING_SYSTEM_TABLES = [
		'hdb_temp',
		'hdb_certificate',
		'hdb_analytics',
		'hdb_raw_analytics',
		'hdb_session_will',
		'hdb_job',
		'hdb_license',
		'hdb_info',
	];
	if (databases.system) {
		for (const table_name of NON_REPLICATING_SYSTEM_TABLES) {
			if (databases.system[table_name]) databases.system[table_name].replicate = false;
		}
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
		if (store.needsDeletion && !path.endsWith('system.mdb')) {
			store.close();
			database_envs.delete(path);
			delete databases[store.databaseName];
			db_removal_listeners.forEach((listener) => listener(store.databaseName));
		}
	}
	return databases;
}

/**
 * This is responsible for reading the internal dbi of a single database file to get a list of all the tables and
 * their indexed or registered attributes
 * @param path
 * @param default_table
 * @param database_name
 */
export function readMetaDb(
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
		if (!audit_store) {
			if (audit_path) {
				if (existsSync(audit_path)) {
					env_init.path = audit_path;
					audit_store = open(env_init);
					audit_store.isLegacy = true;
				}
			} else {
				audit_store = openAuditStore(root_store);
			}
		}

		const tables = ensureDB(database_name);
		const defined_tables = tables[DEFINED_TABLES];
		const tables_to_load = new Map();
		for (const { key, value } of dbis_store.getRange({ start: false })) {
			let [table_name, attribute_name] = key.toString().split('/');
			if (attribute_name === '') {
				// primary key
				attribute_name = value.name;
			} else if (!attribute_name) {
				attribute_name = table_name;
				table_name = default_table;
				if (!value.name) {
					// legacy attribute
					value.name = attribute_name;
					value.indexed = !value.is_hash_attribute;
				}
			}
			defined_tables?.add(table_name);
			let table_def = tables_to_load.get(table_name);
			if (!table_def) tables_to_load.set(table_name, (table_def = { attributes: [] }));
			if (attribute_name == null || value.is_hash_attribute) table_def.primary = value;
			if (attribute_name != null) table_def.attributes.push(value);
			Object.defineProperty(value, 'key', { value: key, configurable: true });
		}

		for (const [table_name, table_def] of tables_to_load) {
			let { attributes, primary: primary_attribute } = table_def;
			if (!primary_attribute) {
				// this isn't defined, find it in the attributes
				for (const attribute of attributes) {
					if (attribute.is_hash_attribute || attribute.isPrimaryKey) {
						primary_attribute = attribute;
						break;
					}
				}
				if (!primary_attribute) {
					harper_logger.fatal(
						`Unable to find a primary key attribute on table ${table_name}, with attributes: ${JSON.stringify(
							attributes
						)}`
					);
					continue;
				}
			}
			// if the table has already been defined, use that class, don't create a new one
			let table = tables[table_name];
			let indices = {},
				existing_attributes = [];
			let table_id;
			let primary_store;
			const audit =
				typeof primary_attribute.audit === 'boolean'
					? primary_attribute.audit
					: env_get(CONFIG_PARAMS.LOGGING_AUDITLOG);
			const track_deletes = primary_attribute.trackDeletes;
			const expiration = primary_attribute.expiration;
			const eviction = primary_attribute.eviction;
			const sealed = primary_attribute.sealed;
			const replicate = primary_attribute.replicate;
			if (table) {
				indices = table.indices;
				existing_attributes = table.attributes;
				table.schemaVersion++;
			} else {
				table_id = primary_attribute.tableId;
				if (table_id) {
					if (table_id >= (dbis_store.get(NEXT_TABLE_ID) || 0)) {
						dbis_store.putSync(NEXT_TABLE_ID, table_id + 1);
						harper_logger.info(`Updating next table id (it was out of sync) to ${table_id + 1} for ${table_name}`);
					}
				} else {
					primary_attribute.tableId = table_id = dbis_store.get(NEXT_TABLE_ID);
					if (!table_id) table_id = 1;
					harper_logger.debug(`Table {table_name} missing an id, assigning {table_id}`);
					dbis_store.putSync(NEXT_TABLE_ID, table_id + 1);
					dbis_store.putSync(primary_attribute.key, primary_attribute);
				}
				const dbi_init = new OpenDBIObject(!primary_attribute.is_hash_attribute, primary_attribute.is_hash_attribute);
				dbi_init.compression = primary_attribute.compression;
				if (dbi_init.compression) {
					const compression_threshold =
						env_get(CONFIG_PARAMS.STORAGE_COMPRESSION_THRESHOLD) || DEFAULT_COMPRESSION_THRESHOLD; // this is the only thing that can change;
					dbi_init.compression.threshold = compression_threshold;
				}
				primary_store = handleLocalTimeForGets(root_store.openDB(primary_attribute.key, dbi_init));
				root_store.databaseName = database_name;
				primary_store.rootStore = root_store;
				primary_store.tableId = table_id;
			}
			for (const attribute of attributes) {
				attribute.attribute = attribute.name;
				try {
					// now load the non-primary keys, opening the dbs as necessary for indices
					if (!attribute.is_hash_attribute && (attribute.indexed || (attribute.attribute && !attribute.name))) {
						if (!indices[attribute.name]) {
							const dbi_init = new OpenDBIObject(!attribute.is_hash_attribute, attribute.is_hash_attribute);
							indices[attribute.name] = root_store.openDB(attribute.key, dbi_init);
							indices[attribute.name].indexNulls = attribute.indexNulls;
						}
						const existing_attribute = existing_attributes.find(
							(existing_attribute) => existing_attribute.name === attribute.name
						);
						if (existing_attribute)
							existing_attributes.splice(existing_attributes.indexOf(existing_attribute), 1, attribute);
						else existing_attributes.push(attribute);
					}
				} catch (error) {
					harper_logger.error(`Error trying to update attribute`, attribute, existing_attributes, indices, error);
				}
			}
			if (!table) {
				table = setTable(
					tables,
					table_name,
					makeTable({
						primaryStore: primary_store,
						auditStore: audit_store,
						audit,
						sealed,
						replicate,
						expirationMS: expiration && expiration * 1000,
						evictionMS: eviction && eviction * 1000,
						trackDeletes: track_deletes,
						tableName: table_name,
						tableId: table_id,
						primaryKey: primary_attribute.name,
						databasePath: is_legacy ? database_name + '/' + table_name : database_name,
						databaseName: database_name,
						indices,
						attributes,
						schemaDefined: primary_attribute.schemaDefined,
						dbisDB: dbis_store,
					})
				);
				table.schemaVersion = 1;
				for (const listener of table_listeners) {
					listener(table);
				}
			}
		}
		return root_store;
	} catch (error) {
		error.message += ` opening database ${path}`;
		throw error;
	}
}
interface TableDefinition {
	table: string;
	database?: string;
	path?: string;
	expiration?: number;
	eviction?: number;
	scanInterval?: number;
	audit?: boolean;
	sealed?: boolean;
	replicate?: boolean;
	trackDeletes?: boolean;
	attributes: any[];
	schemaDefined?: boolean;
	origin?: string;
}
/**
 * Ensure that we have this database object (that holds a set of tables) set up
 * @param database_name
 * @returns
 */
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
	if (defined_databases && !defined_databases.has(database_name)) {
		const defined_tables = new Set(); // we create this so we can determine what was found in a reset and remove any removed dbs/tables
		db_tables[DEFINED_TABLES] = defined_tables;
		defined_databases.set(database_name, defined_tables);
	}
	return db_tables;
}
/**
 * Set the table class into the database's tables object
 * @param tables
 * @param table_name
 * @param Table
 * @returns
 */
function setTable(tables, table_name, Table) {
	tables[table_name] = Table;
	return Table;
}
/**
 * Get root store for a database
 * @param options
 * @returns
 */
export function database({ database: database_name, table: table_name }) {
	if (!database_name) database_name = DEFAULT_DATABASE_NAME;
	getDatabases();
	const database = ensureDB(database_name);
	let database_path = join(getHdbBasePath(), DATABASES_DIR_NAME);
	const database_config = env_get(CONFIG_PARAMS.DATABASES) || {};
	if (process.env.SCHEMAS_DATA_PATH) database_config.data = { path: process.env.SCHEMAS_DATA_PATH };
	const table_path = table_name && database_config[database_name]?.tables?.[table_name]?.path;
	database_path =
		table_path ||
		database_config[database_name]?.path ||
		process.env.STORAGE_PATH ||
		env_get(CONFIG_PARAMS.STORAGE_PATH) ||
		(existsSync(database_path) ? database_path : join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME));
	const path = join(database_path, (table_path ? table_name : database_name) + '.mdb');
	let root_store = database_envs.get(path);
	if (!root_store || root_store.status === 'closed') {
		// TODO: validate database name
		const env_init = new OpenEnvironmentObject(path, false);
		root_store = open(env_init);
		database_envs.set(path, root_store);
	}
	if (!root_store.auditStore) {
		root_store.auditStore = openAuditStore(root_store);
	}
	return root_store;
}
/**
 * Delete the database
 * @param database_name
 */
export async function dropDatabase(database_name) {
	if (!databases[database_name]) throw new Error('Schema does not exist');
	const db_tables = databases[database_name];
	let root_store;
	for (const table_name in db_tables) {
		const table = db_tables[table_name];
		root_store = table.primaryStore.rootStore;
		database_envs.delete(root_store.path);
		if (root_store.status === 'open') {
			await root_store.close();
			await fs.remove(root_store.path);
		}
	}
	if (!root_store) {
		root_store = database({ database: database_name, table: null });
		if (root_store.status === 'open') {
			await root_store.close();
			await fs.remove(root_store.path);
		}
	}
	if (database_name === 'data') {
		for (const table_name in tables) {
			delete tables[table_name];
		}
		delete tables[DEFINED_TABLES];
	}
	delete databases[database_name];
	db_removal_listeners.forEach((listener) => listener(database_name));
}

/**
 * This can be called to ensure that the specified table exists and if it does not exist, it should be created.
 * @param table_name
 * @param database_name
 * @param custom_path
 * @param expiration
 * @param eviction
 * @param scanInterval
 * @param attributes
 * @param audit
 * @param sealed
 * @param replicate
 */
export function table(table_definition: TableDefinition) {
	// eslint-disable-next-line prefer-const
	let {
		table: table_name,
		database: database_name,
		expiration,
		eviction,
		scanInterval: scan_interval,
		attributes,
		audit,
		sealed,
		replicate,
		trackDeletes: track_deletes,
		schemaDefined: schema_defined,
		origin,
	} = table_definition;
	if (!database_name) database_name = DEFAULT_DATABASE_NAME;
	const root_store = database({ database: database_name, table: table_name });
	const tables = databases[database_name];
	harper_logger.trace(`Defining ${table_name} in ${database_name}`);
	let Table = tables?.[table_name];
	if (root_store.status === 'closed') {
		throw new Error(`Can not use a closed data store for ${table_name}`);
	}
	let primary_key;
	let primary_key_attribute;
	let attributes_dbi;
	if (schema_defined == undefined) schema_defined = true;
	const internal_dbi_init = new OpenDBIObject(false);

	for (const attribute of attributes) {
		if (attribute.attribute && !attribute.name) {
			// there is some legacy code that calls the attribute's name the attribute's attribute
			attribute.name = attribute.attribute;
			attribute.indexed = true;
		} else attribute.attribute = attribute.name;
		if (attribute.expiresAt) attribute.indexed = true;
	}
	let has_changes;
	let txn_commit;
	if (Table) {
		primary_key = Table.primaryKey;
		if (Table.primaryStore.rootStore.status === 'closed') {
			throw new Error(`Can not use a closed data store from ${table_name} class`);
		}

		Table.attributes.splice(0, Table.attributes.length, ...attributes);
	} else {
		const audit_store = root_store.auditStore;
		primary_key_attribute = attributes.find((attribute) => attribute.isPrimaryKey) || {};
		primary_key = primary_key_attribute.name;
		primary_key_attribute.is_hash_attribute = true;
		primary_key_attribute.schemaDefined = schema_defined;
		// can't change compression after the fact (except threshold), so save only when we create the table
		primary_key_attribute.compression = getDefaultCompression();
		if (track_deletes) primary_key_attribute.trackDeletes = true;
		audit = primary_key_attribute.audit = typeof audit === 'boolean' ? audit : env_get(CONFIG_PARAMS.LOGGING_AUDITLOG);
		if (expiration) primary_key_attribute.expiration = expiration;
		if (eviction) primary_key_attribute.eviction = eviction;
		if (typeof sealed === 'boolean') primary_key_attribute.sealed = sealed;
		if (typeof replicate === 'boolean') primary_key_attribute.replicate = replicate;
		if (origin) {
			if (!primary_key_attribute.origins) primary_key_attribute.origins = [origin];
			else if (!primary_key_attribute.origins.includes(origin)) primary_key_attribute.origins.push(origin);
		}
		harper_logger.trace(`${table_name} table loading, opening primary store`);
		const dbi_init = new OpenDBIObject(false, true);
		dbi_init.compression = primary_key_attribute.compression;
		const dbi_name = table_name + '/';
		attributes_dbi = root_store.dbisDb = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init);
		startTxn(); // get an exclusive lock on the database so we can verify that we are the only thread creating the table (and assigning the table id)
		if (attributes_dbi.get(dbi_name)) {
			// table was created while we were setting up
			if (txn_commit) txn_commit();
			resetDatabases();
			return table(table_definition);
		}
		const primary_store = handleLocalTimeForGets(root_store.openDB(dbi_name, dbi_init));
		root_store.databaseName = database_name;
		primary_store.rootStore = root_store;
		primary_store.tableId = attributes_dbi.get(NEXT_TABLE_ID);
		harper_logger.trace(`Assigning new table id ${primary_store.tableId} for ${table_name}`);
		if (!primary_store.tableId) primary_store.tableId = 1;
		attributes_dbi.put(NEXT_TABLE_ID, primary_store.tableId + 1);

		primary_key_attribute.tableId = primary_store.tableId;
		Table = setTable(
			tables,
			table_name,
			makeTable({
				primaryStore: primary_store,
				auditStore: audit_store,
				audit,
				sealed,
				replicate,
				trackDeletes: track_deletes,
				expirationMS: expiration && expiration * 1000,
				evictionMS: eviction && eviction * 1000,
				primaryKey: primary_key,
				tableName: table_name,
				tableId: primary_store.tableId,
				databasePath: database_name,
				databaseName: database_name,
				indices: {},
				attributes,
				schemaDefined: schema_defined,
				dbisDB: attributes_dbi,
			})
		);
		Table.schemaVersion = 1;
		has_changes = true;

		attributes_dbi.put(dbi_name, primary_key_attribute);
	}
	const indices = Table.indices;
	attributes_dbi = attributes_dbi || (root_store.dbisDb = root_store.openDB(INTERNAL_DBIS_NAME, internal_dbi_init));
	Table.dbisDB = attributes_dbi;
	const indices_to_remove = [];
	for (const { key, value } of attributes_dbi.getRange({ start: true })) {
		let [attribute_table_name, attribute_name] = key.toString().split('/');
		if (attribute_name === '') attribute_name = value.name; // primary key
		if (attribute_name) {
			if (attribute_table_name !== table_name) continue;
		} else {
			attribute_name = attribute_table_name;
		}
		const attribute = attributes.find((attribute) => attribute.name === attribute_name);
		const remove_index = !attribute?.indexed && value.indexed && !value.isPrimaryKey;
		if (!attribute || remove_index) {
			startTxn();
			has_changes = true;
			if (!attribute) attributes_dbi.remove(key);
			if (remove_index) {
				const index_dbi = Table.indices[attribute_table_name];
				if (index_dbi) indices_to_remove.push(index_dbi);
			}
		}
	}
	const attributes_to_index = [];
	try {
		// TODO: If we have attributes and the schemaDefined flag is not set, turn it on
		// iterate through the attributes to ensure that we have all the dbis created and indexed
		for (const attribute of attributes || []) {
			if (attribute.relationship || attribute.computed) {
				has_changes = true; // need to update the table so the computed properties are translated to property resolvers
				if (attribute.relationship) continue;
			}
			let dbi_key = table_name + '/' + (attribute.name || '');
			Object.defineProperty(attribute, 'key', { value: dbi_key, configurable: true });
			let attribute_descriptor = attributes_dbi.get(dbi_key);
			if (attribute.isPrimaryKey) {
				attribute_descriptor = attribute_descriptor || attributes_dbi.get((dbi_key = table_name + '/')) || {};
				// primary key can't change indexing, but settings can change
				if (
					(audit !== undefined && audit !== Table.audit) ||
					(sealed !== undefined && sealed !== Table.sealed) ||
					(replicate !== undefined && replicate !== Table.replicate) ||
					(+expiration || undefined) !== (+attribute_descriptor.expiration || undefined) ||
					(+eviction || undefined) !== (+attribute_descriptor.eviction || undefined)
				) {
					const updated_primary_attribute = { ...attribute_descriptor };
					if (typeof audit === 'boolean') {
						if (audit) Table.enableAuditing(audit);
						updated_primary_attribute.audit = audit;
					}
					if (expiration) updated_primary_attribute.expiration = +expiration;
					if (eviction) updated_primary_attribute.eviction = +eviction;
					if (sealed !== undefined) updated_primary_attribute.sealed = sealed;
					if (replicate !== undefined) updated_primary_attribute.replicate = replicate;
					has_changes = true; // send out notification of the change
					startTxn();
					attributes_dbi.put(dbi_key, updated_primary_attribute);
				}

				continue;
			}

			// note that non-indexed attributes do not need a dbi
			if (attribute_descriptor?.attribute && !attribute_descriptor.name) attribute_descriptor.indexed = true; // legacy descriptor
			const changed =
				!attribute_descriptor ||
				attribute_descriptor.type !== attribute.type ||
				attribute_descriptor.indexed !== attribute.indexed ||
				attribute_descriptor.nullable !== attribute.nullable ||
				attribute_descriptor.version !== attribute.version ||
				JSON.stringify(attribute_descriptor.attributes) !== JSON.stringify(attribute.attributes) ||
				JSON.stringify(attribute_descriptor.elements) !== JSON.stringify(attribute.elements);
			if (attribute.indexed) {
				const dbi_init = new OpenDBIObject(true, false);
				const dbi = root_store.openDB(dbi_key, dbi_init);
				if (
					changed ||
					(attribute_descriptor.indexingPID && attribute_descriptor.indexingPID !== process.pid) ||
					attribute_descriptor.restartNumber < workerData?.restartNumber
				) {
					has_changes = true;
					startTxn();
					attribute_descriptor = attributes_dbi.get(dbi_key);
					if (
						changed ||
						(attribute_descriptor.indexingPID && attribute_descriptor.indexingPID !== process.pid) ||
						attribute_descriptor.restartNumber < workerData?.restartNumber
					) {
						has_changes = true;
						if (attribute.indexNulls === undefined) attribute.indexNulls = true;
						if (Table.primaryStore.getStats().entryCount > 0) {
							attribute.lastIndexedKey = attribute_descriptor?.lastIndexedKey ?? undefined;
							attribute.indexingPID = process.pid;
							dbi.isIndexing = true;
							Object.defineProperty(attribute, 'dbi', { value: dbi });
							// we only set indexing nulls to true if new or reindexing, we can't have partial indexing of null
							attributes_to_index.push(attribute);
						}
					}
					attributes_dbi.put(dbi_key, attribute);
				}
				if (attribute_descriptor?.indexNulls && attribute.indexNulls === undefined) attribute.indexNulls = true;
				dbi.indexNulls = attribute.indexNulls;
				indices[attribute.name] = dbi;
			} else if (changed) {
				has_changes = true;
				startTxn();
				attributes_dbi.put(dbi_key, attribute);
			}
		}
	} finally {
		if (txn_commit) txn_commit();
	}
	if (has_changes) {
		Table.schemaVersion++;
		Table.updatedAttributes();
	}
	harper_logger.trace(`${table_name} table loading, running index`);
	if (attributes_to_index.length > 0 || indices_to_remove.length > 0) {
		Table.indexingOperation = runIndexing(Table, attributes_to_index, indices_to_remove);
	} else if (has_changes)
		signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'schema-change', Table.databaseName, Table.tableName)
		);

	Table.origin = origin;
	if (has_changes) {
		for (const listener of table_listeners) {
			listener(Table, origin !== 'cluster');
		}
	}
	if (expiration || eviction || scan_interval)
		Table.setTTLExpiration({
			expiration,
			eviction,
			scanInterval: scan_interval,
		});
	harper_logger.trace(`${table_name} table loaded`);

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
		harper_logger.info(`Indexing ${Table.tableName} attributes`, attributes);
		const schema_version = Table.schemaVersion;
		await signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'schema-change', Table.databaseName, Table.tableName)
		);
		let last_resolution;
		for (const index of indicesToRemove) {
			last_resolution = index.drop();
		}
		let interrupted;
		const attribute_error_reported = {};
		let indexed = 0;
		const attributes_length = attributes.length;
		await new Promise((resolve) => setImmediate(resolve)); // yield event turn, indexing should consistently take at least one event turn
		if (attributes_length > 0) {
			let start: any;
			for (const attribute of attributes) {
				// if we are resuming, we need to start from the last key we indexed by all attributes
				if (compareKeys(attribute.lastIndexedKey, start) < 0) start = attribute.lastIndexedKey;
				if (attribute.lastIndexedKey == undefined) {
					// if we are starting from the beginning, clear out any previous index entries since we are rewriting
					attribute.dbi.clearAsync(); // note that we don't need to wait for this to complete, just gets enqueued in front of the other writes
				}
			}
			let outstanding = 0;
			// this means that a new attribute has been introduced that needs to be indexed
			for (const { key, value: record, version } of Table.primaryStore.getRange({
				start,
				lazy: attributes_length < 4,
				versions: true,
				snapshot: false, // don't hold a read transaction this whole time
			})) {
				if (!record) continue; // deletion entry
				// TODO: Do we ever need to interrupt due to a schema change that was not a restart?
				//if (Table.schemaVersion !== schema_version) return; // break out if there are any schema changes and let someone else pick it up
				outstanding++;
				// every index operation needs to be guarded by the version still be the same. If it has already changed before
				// we index, that's fine because indexing is idempotent, we can just put the same values again. If it changes
				// during the indexing, the indexing here will fail. This is also fine because it means the other thread will have
				// performed indexing and we don't need to do anything further
				last_resolution = Table.primaryStore.ifVersion(key, version, () => {
					for (let i = 0; i < attributes_length; i++) {
						const attribute = attributes[i];
						const property = attribute.name;
						try {
							const resolver = attribute.resolve;
							const value = record && (resolver ? resolver(record) : record[property]);
							const values = getIndexedValues(value);
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
						} catch (error) {
							if (!attribute_error_reported[property]) {
								// just report an indexing error once per attribute so we don't spam the logs
								attribute_error_reported[property] = true;
								harper_logger.error(`Error indexing attribute ${property}`, error);
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
				if (workerData && workerData.restartNumber !== manage_threads.restartNumber) {
					interrupted = true;
				}
				if (++indexed % 100 === 0 || interrupted) {
					// occasionally update our progress so if we crash, we can resume
					for (const attribute of attributes) {
						attribute.lastIndexedKey = key;
						Table.dbisDB.put(attribute.key, attribute);
					}
					if (interrupted) return;
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
		harper_logger.info(`Finished indexing ${Table.tableName} attributes`, attributes);
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

export function onUpdatedTable(listener) {
	table_listeners.push(listener);
	return {
		remove() {
			const index = table_listeners.indexOf(listener);
			if (index > -1) table_listeners.splice(index, 1);
		},
	};
}
export function onRemovedDB(listener) {
	db_removal_listeners.push(listener);
	return {
		remove() {
			const index = db_removal_listeners.indexOf(listener);
			if (index > -1) db_removal_listeners.splice(index, 1);
		},
	};
}

export function getDefaultCompression() {
	const LMDB_COMPRESSION = env_get(CONFIG_PARAMS.STORAGE_COMPRESSION);
	const STORAGE_COMPRESSION_DICTIONARY = env_get(CONFIG_PARAMS.STORAGE_COMPRESSION_DICTIONARY);
	const STORAGE_COMPRESSION_THRESHOLD =
		env_get(CONFIG_PARAMS.STORAGE_COMPRESSION_THRESHOLD) || DEFAULT_COMPRESSION_THRESHOLD;
	const LMDB_COMPRESSION_OPTS = { startingOffset: 32 };
	if (STORAGE_COMPRESSION_DICTIONARY)
		LMDB_COMPRESSION_OPTS['dictionary'] = fs.readFileSync(STORAGE_COMPRESSION_DICTIONARY);
	if (STORAGE_COMPRESSION_THRESHOLD) LMDB_COMPRESSION_OPTS['threshold'] = STORAGE_COMPRESSION_THRESHOLD;
	return LMDB_COMPRESSION && LMDB_COMPRESSION_OPTS;
}
