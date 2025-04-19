import { initSync, getHdbBasePath, get as envGet } from '../utility/environment/environmentManager.js';
import { INTERNAL_DBIS_NAME } from '../utility/lmdb/terms.js';
import { open, compareKeys } from 'lmdb';
import { join, extname, basename } from 'path';
import { existsSync, readdirSync } from 'fs';
import {
	getBaseSchemaPath,
	getTransactionAuditStoreBasePath,
} from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import { makeTable } from './Table.ts';
import OpenDBIObject from '../utility/lmdb/OpenDBIObject.js';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject.js';
import { CONFIG_PARAMS, LEGACY_DATABASES_DIR_NAME, DATABASES_DIR_NAME } from '../utility/hdbTerms.ts';
import * as fs from 'fs-extra';
import { _assignPackageExport } from '../globals.js';
import { getIndexedValues } from '../utility/lmdb/commonUtility.js';
import * as signalling from '../utility/signalling.js';
import { SchemaEventMsg } from '../server/threads/itc.js';
import { workerData, threadId } from 'worker_threads';
import * as harperLogger from '../utility/logging/harper_logger.js';
import * as manageThreads from '../server/threads/manageThreads.js';
import { openAuditStore, transactionKeyEncoder } from './auditStore.ts';
import { handleLocalTimeForGets } from './RecordEncoder.ts';
import { deleteRootBlobPathsForDB } from './blob.ts';

const DEFAULT_DATABASE_NAME = 'data';
const DEFINED_TABLES = Symbol('defined-tables');
const DEFAULT_COMPRESSION_THRESHOLD = (envGet(CONFIG_PARAMS.STORAGE_PAGESIZE) || 4096) - 60; // larger than this requires multiple pages
initSync();

export type Table = ReturnType<typeof makeTable>;
export interface Tables {
	[tableName: string]: Table;
}
export interface Databases {
	[databaseName: string]: Tables;
}

export const tables: Tables = Object.create(null);
export const databases: Databases = Object.create(null);
_assignPackageExport('databases', databases);
_assignPackageExport('tables', tables);
const NEXT_TABLE_ID = Symbol.for('next-table-id');
const tableListeners = [];
const dbRemovalListeners = [];
let loadedDatabases; // indicates if we have loaded databases from the file system yet
export const databaseEnvs = new Map<string, any>();
// This is used to track all the databases that are found when iterating through the file system so that anything that is missing
// can be removed:
let definedDatabases;
/**
 * This gets the set of tables from the default database ("data").
 */
export function getTables(): Tables {
	if (!loadedDatabases) getDatabases();
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
	if (loadedDatabases) return databases;
	loadedDatabases = true;
	definedDatabases = new Map();
	let databasePath = getHdbBasePath() && join(getHdbBasePath(), DATABASES_DIR_NAME);
	const schemaConfigs = envGet(CONFIG_PARAMS.DATABASES) || {};
	// not sure why this doesn't work with the environmemt manager
	if (process.env.SCHEMAS_DATA_PATH) schemaConfigs.data = { path: process.env.SCHEMAS_DATA_PATH };
	databasePath =
		process.env.STORAGE_PATH ||
		envGet(CONFIG_PARAMS.STORAGE_PATH) ||
		(databasePath && (existsSync(databasePath) ? databasePath : join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME)));
	if (!databasePath) return;
	if (existsSync(databasePath)) {
		// First load all the databases from our main database folder
		// TODO: Load any databases defined with explicit storage paths from the config
		for (const databaseEntry of readdirSync(databasePath, { withFileTypes: true })) {
			const dbName = basename(databaseEntry.name, '.mdb');
			if (
				databaseEntry.isFile() &&
				extname(databaseEntry.name).toLowerCase() === '.mdb' &&
				!schemaConfigs[dbName]?.path
			) {
				readMetaDb(join(databasePath, databaseEntry.name), null, dbName);
			}
		}
	}
	// now we load databases from the legacy "schema" directory folder structure
	if (existsSync(getBaseSchemaPath())) {
		for (const schemaEntry of readdirSync(getBaseSchemaPath(), { withFileTypes: true })) {
			if (!schemaEntry.isFile()) {
				const schemaPath = join(getBaseSchemaPath(), schemaEntry.name);
				const schemaAuditPath = join(getTransactionAuditStoreBasePath(), schemaEntry.name);
				for (const tableEntry of readdirSync(schemaPath, { withFileTypes: true })) {
					if (tableEntry.isFile() && extname(tableEntry.name).toLowerCase() === '.mdb') {
						const auditPath = join(schemaAuditPath, tableEntry.name);
						readMetaDb(
							join(schemaPath, tableEntry.name),
							basename(tableEntry.name, '.mdb'),
							schemaEntry.name,
							auditPath,
							true
						);
					}
				}
			}
		}
	}
	if (schemaConfigs) {
		for (const dbName in schemaConfigs) {
			const schemaConfig = schemaConfigs[dbName];
			const databasePath = schemaConfig.path;
			if (existsSync(databasePath)) {
				for (const databaseEntry of readdirSync(databasePath, { withFileTypes: true })) {
					if (databaseEntry.isFile() && extname(databaseEntry.name).toLowerCase() === '.mdb') {
						readMetaDb(join(databasePath, databaseEntry.name), basename(databaseEntry.name, '.mdb'), dbName);
					}
				}
			}
			const tableConfigs = schemaConfig.tables;
			if (tableConfigs) {
				for (const tableName in tableConfigs) {
					const tableConfig = tableConfigs[tableName];
					const tablePath = join(tableConfig.path, basename(tableName + '.mdb'));
					if (existsSync(tablePath)) {
						readMetaDb(tablePath, tableName, dbName, null, true);
					}
				}
			}
			//TODO: Iterate configured table paths
		}
	}
	// now remove any databases or tables that have been removed
	for (const dbName in databases) {
		const definedTables = definedDatabases.get(dbName);
		if (definedTables) {
			const tables = databases[dbName];
			if (dbName.includes('delete')) harperLogger.trace(`defined tables ${Array.from(definedTables.keys())}`);

			for (const tableName in tables) {
				if (!definedTables.has(tableName)) {
					harperLogger.trace(`delete table class ${tableName}`);
					delete tables[tableName];
				}
			}
		} else {
			delete databases[dbName];
			if (dbName === 'data') {
				for (const tableName in tables) {
					delete tables[tableName];
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
		'hdb_raw_analytics',
		'hdb_session_will',
		'hdb_job',
		'hdb_license',
		'hdb_info',
	];
	if (envGet(CONFIG_PARAMS.ANALYTICS_REPLICATE) === false) {
		NON_REPLICATING_SYSTEM_TABLES.push('hdb_analytics');
	} else {
		// auditing must be enabled for replication
		databases.system?.hdb_analytics?.enableAuditing();
		databases.system?.hdb_analytics_hostname?.enableAuditing();
	}
	if (databases.system) {
		for (const tableName of NON_REPLICATING_SYSTEM_TABLES) {
			if (databases.system[tableName]) {
				databases.system[tableName].replicate = false;
			}
		}
	}
	definedDatabases = null;
	return databases;
}
export function resetDatabases() {
	loadedDatabases = false;
	for (const [, store] of databaseEnvs) {
		store.needsDeletion = true;
	}
	getDatabases();
	for (const [path, store] of databaseEnvs) {
		if (store.needsDeletion && !path.endsWith('system.mdb')) {
			store.close();
			databaseEnvs.delete(path);
			const db = databases[store.databaseName];
			for (const tableName in db) {
				const table = db[tableName];
				if (table.primaryStore.path === path) {
					delete databases[store.databaseName];
					dbRemovalListeners.forEach((listener) => listener(store.databaseName));
					break;
				}
			}
		}
	}
	return databases;
}

/**
 * This is responsible for reading the internal dbi of a single database file to get a list of all the tables and
 * their indexed or registered attributes
 * @param path
 * @param defaultTable
 * @param databaseName
 */
export function readMetaDb(
	path: string,
	defaultTable?: string,
	databaseName: string = DEFAULT_DATABASE_NAME,
	auditPath?: string,
	isLegacy?: boolean
) {
	const envInit = new OpenEnvironmentObject(path, false);
	try {
		let rootStore = databaseEnvs.get(path);
		if (rootStore) rootStore.needsDeletion = false;
		else {
			rootStore = open(envInit);
			databaseEnvs.set(path, rootStore);
		}
		const internalDbiInit = new OpenDBIObject(false);
		const dbisStore =
			rootStore.dbisDb || (rootStore.dbisDb = rootStore.openDB(INTERNAL_DBIS_NAME, internalDbiInit));
		let auditStore = rootStore.auditStore;
		if (!auditStore) {
			if (auditPath) {
				if (existsSync(auditPath)) {
					envInit.path = auditPath;
					auditStore = open(envInit);
					auditStore.isLegacy = true;
				}
			} else {
				auditStore = openAuditStore(rootStore);
			}
		}

		const tables = ensureDB(databaseName);
		const definedTables = tables[DEFINED_TABLES];
		const tablesToLoad = new Map();
		for (const { key, value } of dbisStore.getRange({ start: false })) {
			let [tableName, attribute_name] = key.toString().split('/');
			if (attribute_name === '') {
				// primary key
				attribute_name = value.name;
			} else if (!attribute_name) {
				attribute_name = tableName;
				tableName = defaultTable;
				if (!value.name) {
					// legacy attribute
					value.name = attribute_name;
					value.indexed = !value.is_hash_attribute;
				}
			}
			definedTables?.add(tableName);
			let tableDef = tablesToLoad.get(tableName);
			if (!tableDef) tablesToLoad.set(tableName, (tableDef = { attributes: [] }));
			if (attribute_name == null || value.is_hash_attribute) tableDef.primary = value;
			if (attribute_name != null) tableDef.attributes.push(value);
			Object.defineProperty(value, 'key', { value: key, configurable: true });
		}

		for (const [tableName, tableDef] of tablesToLoad) {
			let { attributes, primary: primaryAttribute } = tableDef;
			if (!primaryAttribute) {
				// this isn't defined, find it in the attributes
				for (const attribute of attributes) {
					if (attribute.is_hash_attribute || attribute.isPrimaryKey) {
						primaryAttribute = attribute;
						break;
					}
				}
				if (!primaryAttribute) {
					harperLogger.warn(
						`Unable to find a primary key attribute on table ${tableName}, with attributes: ${JSON.stringify(
							attributes
						)}`
					);
					continue;
				}
			}
			// if the table has already been defined, use that class, don't create a new one
			let table = tables[tableName];
			let indices = {},
				existingAttributes = [];
			let tableId;
			let primaryStore;
			const audit =
				typeof primaryAttribute.audit === 'boolean'
					? primaryAttribute.audit
					: envGet(CONFIG_PARAMS.LOGGING_AUDITLOG);
			const trackDeletes = primaryAttribute.trackDeletes;
			const expiration = primaryAttribute.expiration;
			const eviction = primaryAttribute.eviction;
			const sealed = primaryAttribute.sealed;
			const splitSegments = primaryAttribute.splitSegments;
			const replicate = primaryAttribute.replicate;
			if (table) {
				indices = table.indices;
				existingAttributes = table.attributes;
				table.schemaVersion++;
			} else {
				tableId = primaryAttribute.tableId;
				if (tableId) {
					if (tableId >= (dbisStore.get(NEXT_TABLE_ID) || 0)) {
						dbisStore.putSync(NEXT_TABLE_ID, tableId + 1);
						harperLogger.info(`Updating next table id (it was out of sync) to ${tableId + 1} for ${tableName}`);
					}
				} else {
					primaryAttribute.tableId = tableId = dbisStore.get(NEXT_TABLE_ID);
					if (!tableId) tableId = 1;
					harperLogger.debug(`Table {tableName} missing an id, assigning {tableId}`);
					dbisStore.putSync(NEXT_TABLE_ID, tableId + 1);
					dbisStore.putSync(primaryAttribute.key, primaryAttribute);
				}
				const dbiInit = new OpenDBIObject(!primaryAttribute.is_hash_attribute, primaryAttribute.is_hash_attribute);
				dbiInit.compression = primaryAttribute.compression;
				if (dbiInit.compression) {
					const compressionThreshold =
						envGet(CONFIG_PARAMS.STORAGE_COMPRESSION_THRESHOLD) || DEFAULT_COMPRESSION_THRESHOLD; // this is the only thing that can change;
					dbiInit.compression.threshold = compressionThreshold;
				}
				primaryStore = handleLocalTimeForGets(rootStore.openDB(primaryAttribute.key, dbiInit), rootStore);
				rootStore.databaseName = databaseName;
				primaryStore.tableId = tableId;
			}
			let attributesUpdated;
			for (const attribute of attributes) {
				attribute.attribute = attribute.name;
				try {
					// now load the non-primary keys, opening the dbs as necessary for indices
					if (!attribute.is_hash_attribute && (attribute.indexed || (attribute.attribute && !attribute.name))) {
						if (!indices[attribute.name]) {
							const dbiInit = new OpenDBIObject(!attribute.is_hash_attribute, attribute.is_hash_attribute);
							indices[attribute.name] = rootStore.openDB(attribute.key, dbiInit);
							indices[attribute.name].indexNulls = attribute.indexNulls;
						}
						const existingAttribute = existingAttributes.find(
							(existingAttribute) => existingAttribute.name === attribute.name
						);
						if (existingAttribute)
							existingAttributes.splice(existingAttributes.indexOf(existingAttribute), 1, attribute);
						else existingAttributes.push(attribute);
						attributesUpdated = true;
					}
				} catch (error) {
					harperLogger.error(`Error trying to update attribute`, attribute, existingAttributes, indices, error);
				}
			}
			for (const existingAttribute of existingAttributes) {
				const attribute = attributes.find((attribute) => attribute.name === existingAttribute.name);
				if (!attribute) {
					if (existingAttribute.is_hash_attribute) {
						harperLogger.error('Unable to remove existing primary key attribute', existingAttribute);
						continue;
					}
					if (existingAttribute.indexed) {
						// we only remove attributes if they were indexed, in order to support dropAttribute that removes dynamic indexed attributes
						existingAttributes.splice(existingAttributes.indexOf(existingAttribute), 1);
						attributesUpdated = true;
					}
				}
			}
			if (table) {
				if (attributesUpdated) {
					table.schemaVersion++;
					table.updatedAttributes();
				}
			} else {
				table = setTable(
					tables,
					tableName,
					makeTable({
						primaryStore,
						auditStore,
						audit,
						sealed,
						splitSegments,
						replicate,
						expirationMS: expiration && expiration * 1000,
						evictionMS: eviction && eviction * 1000,
						trackDeletes,
						tableName,
						tableId,
						primaryKey: primaryAttribute.name,
						databasePath: isLegacy ? databaseName + '/' + tableName : databaseName,
						databaseName,
						indices,
						attributes,
						schemaDefined: primaryAttribute.schemaDefined,
						dbisDB: dbisStore,
					})
				);
				table.schemaVersion = 1;
				for (const listener of tableListeners) {
					listener(table);
				}
			}
		}
		return rootStore;
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
	splitSegments?: boolean;
	replicate?: boolean;
	trackDeletes?: boolean;
	attributes: any[];
	schemaDefined?: boolean;
	origin?: string;
}
/**
 * Ensure that we have this database object (that holds a set of tables) set up
 * @param databaseName
 * @returns
 */
function ensureDB(databaseName) {
	let dbTables = databases[databaseName];
	if (!dbTables) {
		if (databaseName === 'data')
			// preserve the data tables objet
			dbTables = databases[databaseName] = tables;
		else if (databaseName === 'system')
			// make system non-enumerable
			Object.defineProperty(databases, 'system', {
				value: (dbTables = Object.create(null)),
				configurable: true, // no enum
			});
		else {
			dbTables = databases[databaseName] = Object.create(null);
		}
	}
	if (definedDatabases && !definedDatabases.has(databaseName)) {
		const definedTables = new Set(); // we create this so we can determine what was found in a reset and remove any removed dbs/tables
		dbTables[DEFINED_TABLES] = definedTables;
		definedDatabases.set(databaseName, definedTables);
	}
	return dbTables;
}
/**
 * Set the table class into the database's tables object
 * @param tables
 * @param tableName
 * @param Table
 * @returns
 */
function setTable(tables, tableName, Table) {
	tables[tableName] = Table;
	return Table;
}
/**
 * Get root store for a database
 * @param options
 * @returns
 */
export function database({ database: databaseName, table: tableName }) {
	if (!databaseName) databaseName = DEFAULT_DATABASE_NAME;
	getDatabases();
	const database = ensureDB(databaseName);
	let databasePath = join(getHdbBasePath(), DATABASES_DIR_NAME);
	const databaseConfig = envGet(CONFIG_PARAMS.DATABASES) || {};
	if (process.env.SCHEMAS_DATA_PATH) databaseConfig.data = { path: process.env.SCHEMAS_DATA_PATH };
	const tablePath = tableName && databaseConfig[databaseName]?.tables?.[tableName]?.path;
	databasePath =
		tablePath ||
		databaseConfig[databaseName]?.path ||
		process.env.STORAGE_PATH ||
		envGet(CONFIG_PARAMS.STORAGE_PATH) ||
		(existsSync(databasePath) ? databasePath : join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME));
	const path = join(databasePath, (tablePath ? tableName : databaseName) + '.mdb');
	let rootStore = databaseEnvs.get(path);
	if (!rootStore || rootStore.status === 'closed') {
		// TODO: validate database name
		const envInit = new OpenEnvironmentObject(path, false);
		rootStore = open(envInit);
		databaseEnvs.set(path, rootStore);
	}
	if (!rootStore.auditStore) {
		rootStore.auditStore = openAuditStore(rootStore);
	}
	return rootStore;
}
/**
 * Delete the database
 * @param databaseName
 */
export async function dropDatabase(databaseName) {
	if (!databases[databaseName]) throw new Error('Schema does not exist');
	const dbTables = databases[databaseName];
	let rootStore;
	for (const tableName in dbTables) {
		const table = dbTables[tableName];
		rootStore = table.primaryStore.rootStore;
		databaseEnvs.delete(rootStore.path);
		if (rootStore.status === 'open') {
			await rootStore.close();
			await fs.remove(rootStore.path);
		}
	}
	if (!rootStore) {
		rootStore = database({ database: databaseName, table: null });
		if (rootStore.status === 'open') {
			await rootStore.close();
			await fs.remove(rootStore.path);
		}
	}
	if (databaseName === 'data') {
		for (const tableName in tables) {
			delete tables[tableName];
		}
		delete tables[DEFINED_TABLES];
	}
	delete databases[databaseName];
	dbRemovalListeners.forEach((listener) => listener(databaseName));
	await deleteRootBlobPathsForDB(rootStore);
}

/**
 * This can be called to ensure that the specified table exists and if it does not exist, it should be created.
 * @param tableName
 * @param databaseName
 * @param customPath
 * @param expiration
 * @param eviction
 * @param scanInterval
 * @param attributes
 * @param audit
 * @param sealed
 * @param splitSegments
 * @param replicate
 */
export function table(tableDefinition: TableDefinition) {
	// eslint-disable-next-line prefer-const
	let {
		table: tableName,
		database: databaseName,
		expiration,
		eviction,
		scanInterval,
		attributes,
		audit,
		sealed,
		splitSegments,
		replicate,
		trackDeletes,
		schemaDefined,
		origin,
	} = tableDefinition;
	if (!databaseName) databaseName = DEFAULT_DATABASE_NAME;
	const rootStore = database({ database: databaseName, table: tableName });
	const tables = databases[databaseName];
	harperLogger.trace(`Defining ${tableName} in ${databaseName}`);
	let Table = tables?.[tableName];
	if (rootStore.status === 'closed') {
		throw new Error(`Can not use a closed data store for ${tableName}`);
	}
	let primaryKey;
	let primaryKeyAttribute;
	let attributesDbi;
	if (schemaDefined == undefined) schemaDefined = true;
	const internalDbiInit = new OpenDBIObject(false);

	for (const attribute of attributes) {
		if (attribute.attribute && !attribute.name) {
			// there is some legacy code that calls the attribute's name the attribute's attribute
			attribute.name = attribute.attribute;
			attribute.indexed = true;
		} else attribute.attribute = attribute.name;
		if (attribute.expiresAt) attribute.indexed = true;
	}
	let hasChanges;
	let txnCommit;
	if (Table) {
		primaryKey = Table.primaryKey;
		if (Table.primaryStore.rootStore.status === 'closed') {
			throw new Error(`Can not use a closed data store from ${tableName} class`);
		}
		// it table already exists, get the split segments setting
		if (splitSegments == undefined) splitSegments = Table.splitSegments;
		Table.attributes.splice(0, Table.attributes.length, ...attributes);
	} else {
		const auditStore = rootStore.auditStore;
		primaryKeyAttribute = attributes.find((attribute) => attribute.isPrimaryKey) || {};
		primaryKey = primaryKeyAttribute.name;
		primaryKeyAttribute.is_hash_attribute = primaryKeyAttribute.isPrimaryKey = true;
		primaryKeyAttribute.schemaDefined = schemaDefined;
		// can't change compression after the fact (except threshold), so save only when we create the table
		primaryKeyAttribute.compression = getDefaultCompression();
		if (trackDeletes) primaryKeyAttribute.trackDeletes = true;
		audit = primaryKeyAttribute.audit = typeof audit === 'boolean' ? audit : envGet(CONFIG_PARAMS.LOGGING_AUDITLOG);
		if (expiration) primaryKeyAttribute.expiration = expiration;
		if (eviction) primaryKeyAttribute.eviction = eviction;
		splitSegments ??= false;
		primaryKeyAttribute.splitSegments = splitSegments; // always default to not splitting segments going forward
		if (typeof sealed === 'boolean') primaryKeyAttribute.sealed = sealed;
		if (typeof replicate === 'boolean') primaryKeyAttribute.replicate = replicate;
		if (origin) {
			if (!primaryKeyAttribute.origins) primaryKeyAttribute.origins = [origin];
			else if (!primaryKeyAttribute.origins.includes(origin)) primaryKeyAttribute.origins.push(origin);
		}
		harperLogger.trace(`${tableName} table loading, opening primary store`);
		const dbiInit = new OpenDBIObject(false, true);
		dbiInit.compression = primaryKeyAttribute.compression;
		const dbiName = tableName + '/';
		attributesDbi = rootStore.dbisDb = rootStore.openDB(INTERNAL_DBIS_NAME, internalDbiInit);
		startTxn(); // get an exclusive lock on the database so we can verify that we are the only thread creating the table (and assigning the table id)
		if (attributesDbi.get(dbiName)) {
			// table was created while we were setting up
			if (txnCommit) txnCommit();
			resetDatabases();
			return table(tableDefinition);
		}
		const primaryStore = handleLocalTimeForGets(rootStore.openDB(dbiName, dbiInit), rootStore);
		rootStore.databaseName = databaseName;
		primaryStore.tableId = attributesDbi.get(NEXT_TABLE_ID);
		harperLogger.trace(`Assigning new table id ${primaryStore.tableId} for ${tableName}`);
		if (!primaryStore.tableId) primaryStore.tableId = 1;
		attributesDbi.put(NEXT_TABLE_ID, primaryStore.tableId + 1);

		primaryKeyAttribute.tableId = primaryStore.tableId;
		Table = setTable(
			tables,
			tableName,
			makeTable({
				primaryStore,
				auditStore,
				audit,
				sealed,
				splitSegments,
				replicate,
				trackDeletes,
				expirationMS: expiration && expiration * 1000,
				evictionMS: eviction && eviction * 1000,
				primaryKey,
				tableName,
				tableId: primaryStore.tableId,
				databasePath: databaseName,
				databaseName,
				indices: {},
				attributes,
				schemaDefined,
				dbisDB: attributesDbi,
			})
		);
		Table.schemaVersion = 1;
		hasChanges = true;

		attributesDbi.put(dbiName, primaryKeyAttribute);
	}
	const indices = Table.indices;
	attributesDbi = attributesDbi || (rootStore.dbisDb = rootStore.openDB(INTERNAL_DBIS_NAME, internalDbiInit));
	Table.dbisDB = attributesDbi;
	const indicesToRemove = [];
	for (const { key, value } of attributesDbi.getRange({ start: true })) {
		let [attributeTableName, attribute_name] = key.toString().split('/');
		if (attribute_name === '') attribute_name = value.name; // primary key
		if (attribute_name) {
			if (attributeTableName !== tableName) continue;
		} else {
			// table attribute for a table with no primary key, we don't want to remove this, so continue on
			continue;
		}
		const attribute = attributes.find((attribute) => attribute.name === attribute_name);
		const removeIndex = !attribute?.indexed && value.indexed && !value.isPrimaryKey;
		if (!attribute || removeIndex) {
			startTxn();
			hasChanges = true;
			if (!attribute) attributesDbi.remove(key);
			if (removeIndex) {
				const indexDbi = Table.indices[attributeTableName];
				if (indexDbi) indicesToRemove.push(indexDbi);
			}
		}
	}
	const attributesToIndex = [];
	try {
		// TODO: If we have attributes and the schemaDefined flag is not set, turn it on
		// iterate through the attributes to ensure that we have all the dbis created and indexed
		for (const attribute of attributes || []) {
			if (attribute.relationship || attribute.computed) {
				hasChanges = true; // need to update the table so the computed properties are translated to property resolvers
				if (attribute.relationship) continue;
			}
			let dbiKey = tableName + '/' + (attribute.name || '');
			Object.defineProperty(attribute, 'key', { value: dbiKey, configurable: true });
			let attributeDescriptor = attributesDbi.get(dbiKey);
			if (attribute.isPrimaryKey) {
				attributeDescriptor = attributeDescriptor || attributesDbi.get((dbiKey = tableName + '/')) || {};
				// primary key can't change indexing, but settings can change
				if (
					(audit !== undefined && audit !== Table.audit) ||
					(sealed !== undefined && sealed !== Table.sealed) ||
					(replicate !== undefined && replicate !== Table.replicate) ||
					(+expiration || undefined) !== (+attributeDescriptor.expiration || undefined) ||
					(+eviction || undefined) !== (+attributeDescriptor.eviction || undefined) ||
					attribute.type !== attributeDescriptor.type
				) {
					const updatedPrimaryAttribute = { ...attributeDescriptor };
					if (typeof audit === 'boolean') {
						if (audit) Table.enableAuditing(audit);
						updatedPrimaryAttribute.audit = audit;
					}
					if (expiration) updatedPrimaryAttribute.expiration = +expiration;
					if (eviction) updatedPrimaryAttribute.eviction = +eviction;
					if (sealed !== undefined) updatedPrimaryAttribute.sealed = sealed;
					if (replicate !== undefined) updatedPrimaryAttribute.replicate = replicate;
					if (attribute.type) updatedPrimaryAttribute.type = attribute.type;
					hasChanges = true; // send out notification of the change
					startTxn();
					attributesDbi.put(dbiKey, updatedPrimaryAttribute);
				}

				continue;
			}

			// note that non-indexed attributes do not need a dbi
			if (attributeDescriptor?.attribute && !attributeDescriptor.name) attributeDescriptor.indexed = true; // legacy descriptor
			const changed =
				!attributeDescriptor ||
				attributeDescriptor.type !== attribute.type ||
				attributeDescriptor.indexed !== attribute.indexed ||
				attributeDescriptor.nullable !== attribute.nullable ||
				attributeDescriptor.version !== attribute.version ||
				JSON.stringify(attributeDescriptor.properties) !== JSON.stringify(attribute.properties) ||
				JSON.stringify(attributeDescriptor.elements) !== JSON.stringify(attribute.elements);
			if (attribute.indexed) {
				const dbiInit = new OpenDBIObject(true, false);
				const dbi = rootStore.openDB(dbiKey, dbiInit);
				if (
					changed ||
					(attributeDescriptor.indexingPID && attributeDescriptor.indexingPID !== process.pid) ||
					attributeDescriptor.restartNumber < workerData?.restartNumber
				) {
					hasChanges = true;
					startTxn();
					attributeDescriptor = attributesDbi.get(dbiKey);
					if (
						changed ||
						(attributeDescriptor.indexingPID && attributeDescriptor.indexingPID !== process.pid) ||
						attributeDescriptor.restartNumber < workerData?.restartNumber
					) {
						hasChanges = true;
						if (attribute.indexNulls === undefined) attribute.indexNulls = true;
						if (Table.primaryStore.getStats().entryCount > 0) {
							attribute.lastIndexedKey = attributeDescriptor?.lastIndexedKey ?? undefined;
							attribute.indexingPID = process.pid;
							dbi.isIndexing = true;
							Object.defineProperty(attribute, 'dbi', { value: dbi });
							// we only set indexing nulls to true if new or reindexing, we can't have partial indexing of null
							attributesToIndex.push(attribute);
						}
					}
					attributesDbi.put(dbiKey, attribute);
				}
				if (attributeDescriptor?.indexNulls && attribute.indexNulls === undefined) attribute.indexNulls = true;
				dbi.indexNulls = attribute.indexNulls;
				indices[attribute.name] = dbi;
			} else if (changed) {
				hasChanges = true;
				startTxn();
				attributesDbi.put(dbiKey, attribute);
			}
		}
	} finally {
		if (txnCommit) txnCommit();
	}
	if (hasChanges) {
		Table.schemaVersion++;
		Table.updatedAttributes();
	}
	harperLogger.trace(`${tableName} table loading, running index`);
	if (attributesToIndex.length > 0 || indicesToRemove.length > 0) {
		Table.indexingOperation = runIndexing(Table, attributesToIndex, indicesToRemove);
	} else if (hasChanges)
		signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'schema-change', Table.databaseName, Table.tableName)
		);

	Table.origin = origin;
	if (hasChanges) {
		for (const listener of tableListeners) {
			listener(Table, origin !== 'cluster');
		}
	}
	if (expiration || eviction || scanInterval)
		Table.setTTLExpiration({
			expiration,
			eviction,
			scanInterval,
		});
	harperLogger.trace(`${tableName} table loaded`);

	return Table;
	function startTxn() {
		if (txnCommit) return;
		rootStore.transactionSync(() => {
			return {
				then(callback) {
					txnCommit = callback;
				},
			};
		});
	}
}
const MAX_OUTSTANDING_INDEXING = 1000;
const MIN_OUTSTANDING_INDEXING = 10;
async function runIndexing(Table, attributes, indicesToRemove) {
	try {
		harperLogger.info(`Indexing ${Table.tableName} attributes`, attributes);
		const schemaVersion = Table.schemaVersion;
		await signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'schema-change', Table.databaseName, Table.tableName)
		);
		let lastResolution;
		for (const index of indicesToRemove) {
			lastResolution = index.drop();
		}
		let interrupted;
		const attributeErrorReported = {};
		let indexed = 0;
		const attributesLength = attributes.length;
		await new Promise((resolve) => setImmediate(resolve)); // yield event turn, indexing should consistently take at least one event turn
		if (attributesLength > 0) {
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
				lazy: attributesLength < 4,
				versions: true,
				snapshot: false, // don't hold a read transaction this whole time
			})) {
				if (!record) continue; // deletion entry
				// TODO: Do we ever need to interrupt due to a schema change that was not a restart?
				//if (Table.schemaVersion !== schemaVersion) return; // break out if there are any schema changes and let someone else pick it up
				outstanding++;
				// every index operation needs to be guarded by the version still be the same. If it has already changed before
				// we index, that's fine because indexing is idempotent, we can just put the same values again. If it changes
				// during the indexing, the indexing here will fail. This is also fine because it means the other thread will have
				// performed indexing and we don't need to do anything further
				lastResolution = Table.primaryStore.ifVersion(key, version, () => {
					for (let i = 0; i < attributesLength; i++) {
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
							if (!attributeErrorReported[property]) {
								// just report an indexing error once per attribute so we don't spam the logs
								attributeErrorReported[property] = true;
								harperLogger.error(`Error indexing attribute ${property}`, error);
							}
						}
					}
				});
				lastResolution.then(
					() => outstanding--,
					(error) => {
						outstanding--;
						harperLogger.error(error);
					}
				);
				if (workerData && workerData.restartNumber !== manageThreads.restartNumber) {
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
				if (outstanding > MAX_OUTSTANDING_INDEXING) await lastResolution;
				else if (outstanding > MIN_OUTSTANDING_INDEXING) await new Promise((resolve) => setImmediate(resolve)); // yield event turn, don't want to use all computation
			}
			// update the attributes to indicate that we are finished
			for (const attribute of attributes) {
				delete attribute.lastIndexedKey;
				delete attribute.indexingPID;
				attribute.dbi.isIndexing = false;
				lastResolution = Table.dbisDB.put(attribute.key, attribute);
			}
		}
		await lastResolution;
		// now notify all the threads that we are done and the index is ready to use
		await signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'indexing-finished', Table.databaseName, Table.tableName)
		);
		harperLogger.info(`Finished indexing ${Table.tableName} attributes`, attributes);
	} catch (error) {
		harperLogger.error('Error in indexing', error);
	}
}
/**
 * Once an origin has fully declared all the tables for a database, this can be run to remove any tables or attributes
 * that are unused.
 */
function cleanupDatabase(origin) {}

export function dropTableMeta({ table: tableName, database: databaseName }) {
	const rootStore = database({ database: databaseName, table: tableName });
	const removals = [];
	const dbisDb = rootStore.dbisDb;
	for (const key of dbisDb.getKeys({ start: tableName + '/', end: tableName + '0' })) {
		removals.push(dbisDb.remove(key));
	}
	return Promise.all(removals);
}

export function onUpdatedTable(listener) {
	tableListeners.push(listener);
	return {
		remove() {
			const index = tableListeners.indexOf(listener);
			if (index > -1) tableListeners.splice(index, 1);
		},
	};
}
export function onRemovedDB(listener) {
	dbRemovalListeners.push(listener);
	return {
		remove() {
			const index = dbRemovalListeners.indexOf(listener);
			if (index > -1) dbRemovalListeners.splice(index, 1);
		},
	};
}

export function getDefaultCompression() {
	const LMDB_COMPRESSION = envGet(CONFIG_PARAMS.STORAGE_COMPRESSION);
	const STORAGE_COMPRESSION_DICTIONARY = envGet(CONFIG_PARAMS.STORAGE_COMPRESSION_DICTIONARY);
	const STORAGE_COMPRESSION_THRESHOLD =
		envGet(CONFIG_PARAMS.STORAGE_COMPRESSION_THRESHOLD) || DEFAULT_COMPRESSION_THRESHOLD;
	const LMDB_COMPRESSION_OPTS = { startingOffset: 32 };
	if (STORAGE_COMPRESSION_DICTIONARY)
		LMDB_COMPRESSION_OPTS['dictionary'] = fs.readFileSync(STORAGE_COMPRESSION_DICTIONARY);
	if (STORAGE_COMPRESSION_THRESHOLD) LMDB_COMPRESSION_OPTS['threshold'] = STORAGE_COMPRESSION_THRESHOLD;
	return LMDB_COMPRESSION && LMDB_COMPRESSION_OPTS;
}
