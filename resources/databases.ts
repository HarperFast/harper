import { EventEmitter } from 'node:events';
import { initSync, getHdbBasePath, get as envGet } from '../utility/environment/environmentManager.ts';
import { INTERNAL_DBIS_NAME } from '../utility/lmdb/terms.ts';
import { open, compareKeys, type Database, type RootDatabase } from 'lmdb';
import { join, extname, basename } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import {
	getBaseSchemaPath,
	getTransactionAuditStoreBasePath,
} from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import { makeTable, ignoreAlreadyDropped, acquireUpdateAttributesLock, releaseUpdateAttributesLock } from './Table.ts';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject.ts';
import {
	CONFIG_PARAMS,
	LEGACY_DATABASES_DIR_NAME,
	DATABASES_DIR_NAME,
	MIGRATING_DIR_SUFFIX,
	RESERVED_DATABASE_NAMES,
} from '../utility/hdbTerms.ts';
import { getConfigPath } from '../config/configUtils.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { _assignPackageExport } from '../globals.js';
import { getIndexedValues } from '../utility/lmdb/commonUtility.ts';
import * as signalling from '../utility/signalling.ts';
import { SchemaEventMsg } from '../server/threads/itc.js';
import { workerData } from 'worker_threads';
import harperLogger from '../utility/logging/harper_logger.ts';
const { forComponent } = harperLogger;
import * as manageThreads from '../server/threads/manageThreads.js';
import { openAuditStore, readAuditEntry, createAuditEntry, type AuditRecord } from './auditStore.ts';
import { handleLocalTimeForGets } from './RecordEncoder.ts';
import { databasePaths, deleteRootBlobPathsForDB } from './blob.ts';
import { removeStorageReclamation } from '../server/storageReclamation.ts';
import { commonValidators, schemaRegex } from '../validation/common_validators.ts';
import { CUSTOM_INDEXES } from './indexes/customIndexes.ts';
import { OpenDBIObject } from '../utility/lmdb/OpenDBIObject.ts';
import { RocksDatabase, supportedCompression, type RocksDatabaseOptions } from '@harperfast/rocksdb-js';
import { PrimaryRocksDatabase } from './PrimaryRocksDatabase.ts';
import { replayLogs } from './replayLogs.ts';
import { totalmem } from 'node:os';
import { RocksIndexStore } from './RocksIndexStore.ts';
import { when } from '../utility/when.ts';
import { resolveRocksMemoryConfig } from '../utility/rocksMemoryConfig.ts';
import { isProcessRunning } from '../utility/processManagement/processManagement.js';
import {
	acquireRestoreLock,
	checkRestoreState,
	releaseRestoreLock,
	restoreMarkerPresent,
	scanBlockedRestores,
	RESTORE_META_DIR,
	type RestoreLock,
} from '../dataLayer/restoreMarker.ts';

/**
 * Check if Harper is running in read-only mode.
 * Read-only mode can be enabled via:
 * - HARPER_READONLY environment variable (truthy value)
 * - --readonly CLI flag
 * - storage.readOnly config setting
 */
let _isReadOnlyMode: boolean | undefined;
export function isReadOnlyMode(): boolean {
	if (_isReadOnlyMode !== undefined) return _isReadOnlyMode;
	// Check environment variable
	const envReadOnly = process.env.HARPER_READONLY;
	if (envReadOnly && envReadOnly !== '0' && envReadOnly !== 'false') {
		_isReadOnlyMode = true;
		return true;
	}
	// Check CLI flag (simple argv check)
	if (process.argv.includes('--readonly') || process.argv.includes('--read-only')) {
		_isReadOnlyMode = true;
		return true;
	}
	// Check config setting
	if (envGet(CONFIG_PARAMS.STORAGE_READONLY)) {
		_isReadOnlyMode = true;
		return true;
	}
	_isReadOnlyMode = false;
	return false;
}

function createOpenDBIObject(dupSort = false, isPrimary = false) {
	return new OpenDBIObject(dupSort, isPrimary);
}
// The __dbis__ metadata DBI is non-versioned (OpenDBIObject useVersions=false); only versioned
// primary stores carry the per-record metadata prefix. lmdb/rocksdb don't forward `useVersions` to
// the encoder, so mark the live encoder explicitly — its encode hook uses this to write __dbis__
// records plainly and never consume in-flight metadata staged for a primary write (harper#1307).
function markInternalDbiNonVersioned(dbisDb: any): any {
	if (dbisDb?.encoder) dbisDb.encoder.useVersions = false;
	return dbisDb;
}
const logger = forComponent('storage');

const DEFAULT_DATABASE_NAME = 'data';
const DEFINED_TABLES = Symbol('defined-tables');
const CATALOG_RELATIONSHIP = Symbol('catalog-relationship');
const DEFAULT_COMPRESSION_THRESHOLD = (envGet(CONFIG_PARAMS.STORAGE_PAGESIZE) || 4096) - 60; // larger than this requires multiple pages
initSync();

type RelationshipTarget = { database: string; table: string };
type PersistedRelationship = {
	name: string;
	type: string;
	elements?: { type: string };
	relationship: { from?: string; to?: string; filterMissing?: boolean };
	target: RelationshipTarget;
};

type RelationshipHydration = {
	table: any;
	databaseName: string;
	tableName: string;
	definitions: unknown[];
};

let relationshipsToHydrate: RelationshipHydration[] = [];
const reportedRelationshipErrors = new Set<string>();

function normalizeRelationships(attributes: any[]): PersistedRelationship[] {
	const relationships: PersistedRelationship[] = [];
	for (const attribute of attributes) {
		const target = attribute.relationshipReference;
		if (!attribute.relationship || !target) continue;
		const relationship: PersistedRelationship['relationship'] = {};
		if (typeof attribute.relationship.from === 'string') relationship.from = attribute.relationship.from;
		if (typeof attribute.relationship.to === 'string') relationship.to = attribute.relationship.to;
		// the GraphQL parser hands every directive argument over as a string, and the resolver reads
		// filterMissing for truthiness, so persist what the resolver would see rather than the literal
		if (attribute.relationship.filterMissing !== undefined)
			relationship.filterMissing = Boolean(attribute.relationship.filterMissing);
		if (!relationship.from && !relationship.to) continue;
		const definition: PersistedRelationship = {
			name: attribute.name,
			type: attribute.type,
			relationship,
			target: { database: target.database, table: target.table },
		};
		if (attribute.type === 'array') definition.elements = { type: attribute.elements?.type };
		relationships.push(definition);
	}
	return relationships;
}

function relationshipEquals(left: any, right: any): boolean {
	return (
		left?.name === right?.name &&
		left?.type === right?.type &&
		left?.elements?.type === right?.elements?.type &&
		left?.relationship?.from === right?.relationship?.from &&
		left?.relationship?.to === right?.relationship?.to &&
		left?.relationship?.filterMissing === right?.relationship?.filterMissing &&
		left?.target?.database === right?.target?.database &&
		left?.target?.table === right?.target?.table
	);
}

function relationshipListsEqual(left: any, right: PersistedRelationship[]): boolean {
	if (!Array.isArray(left) || left.length !== right.length) return false;
	for (let index = 0; index < right.length; index++) if (!relationshipEquals(left[index], right[index])) return false;
	return true;
}
/**
 * The RocksDB block/blob codec for every column family this process opens (`storage.rocks.compression`),
 * or `undefined` to leave rocksdb-js on its own default (lz4 wherever the native build has it).
 *
 * Resolved on the first open and then frozen, deliberately. RocksDB fixes a column family's codec
 * for as long as it is open and rejects a reopen that disagrees, and Harper's worker threads share
 * one process-wide column-family registry — so every open, in every thread, has to resolve the same
 * value. Re-reading config per open does not guarantee that: on a fresh install the system families
 * are created by `mountHdb()` before the config file exists, so the main thread would resolve
 * nothing and the workers would resolve the configured codec, after which `__dbis__` cannot be
 * reopened and Harper fails with "The system database failed to load". The installer stages this
 * value before `mountHdb()` (see utility/install/installer.ts) so that first open already sees it.
 *
 * Unset is NOT "use the build default" for a family that already exists — see toRocksCompression.
 */
let resolvedRocksCompression: string | undefined;
let rocksCompressionResolved = false;

export function getRocksCompression(): string | undefined {
	if (!rocksCompressionResolved) {
		resolvedRocksCompression = readDatabaseCodec();
		rocksCompressionResolved = true;
	}
	return resolvedRocksCompression;
}

/**
 * Test-only: un-freezes the resolved codec. Production code never calls this — the freeze is the
 * invariant (see getRocksCompression above) — but a test process runs many unrelated test files in
 * one process, so whichever file happens to open a RocksDatabase first freezes this for everyone
 * after it. Tests that need to exercise config changes call this to get back to the unresolved state.
 */
export function resetRocksCompression(): void {
	resolvedRocksCompression = undefined;
	rocksCompressionResolved = false;
}

/**
 * The codec every column family in this process opens under.
 *
 * Compression is a deployment setting, not a per-table one. RocksDB opens all of a database's
 * column families in one call, so the codec has to be decided before the first open — which is
 * before Harper has read any table's metadata (that catalog is itself one of the families being
 * opened). Resolving one codec from configuration and applying it to every family is what makes
 * that possible; it is passed with `compressionForAllColumnFamilies` so families this process
 * never names individually adopt it too, which is what lets a database created before the codec
 * existed start compressing.
 *
 * `storage.rocks.compression` names a codec outright. Otherwise `storage.compression` (default
 * true) decides enabled-or-not and the build default fills in the algorithm. Per-table metadata
 * still records the LMDB-era boolean, but no longer selects: a table persisted as disabled inside
 * a deployment that enables compression would need its own codec, and it cannot have one.
 */
function readDatabaseCodec(): string | undefined {
	const explicit = readRocksCompressionConfig();
	if (explicit) return explicit;
	return toRocksCompression(getDefaultCompression()) as string | undefined;
}

function readRocksCompressionConfig(): string | undefined {
	const configured = envGet(CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION);
	if (configured === undefined || configured === null || configured === '') return undefined;
	const requested = String(configured).trim().toLowerCase();
	if (!requested) return undefined;
	// Rejected here rather than at the open: an unsupported name throws inside RocksDatabase.open,
	// which surfaces as the system database failing to load partway through startup.
	if (!supportedCompression.includes(requested)) {
		throw new Error(
			`storage.rocks.compression="${requested}" is not available in this build of @harperfast/rocksdb-js. Supported: ${supportedCompression.join(', ')}`
		);
	}
	return requested;
}

// I don't know if this is the best place for this, but somewhere we need to specify which tables
// replicate by default:
export const NON_REPLICATING_SYSTEM_TABLES = [
	'hdb_temp',
	'hdb_certificate',
	'hdb_raw_analytics',
	'hdb_model_calls',
	'hdb_session_will',
	'hdb_job',
	'hdb_info',
	'mcp_session',
];

export type Table = ReturnType<typeof makeTable> & {
	indexingOperation?: any;
	origin?: string;
	schemaVersion?: number;
};
export interface Tables {
	[tableName: string]: Table;
	[DEFINED_TABLES]?: Set<string>;
}
export interface Databases {
	[databaseName: string]: Tables;
}

// note: technically `Database` is either a `LMDBStore` or a `CachingStore`
interface LMDBDatabase extends Database {
	customIndex?: any;
	isIndexing?: boolean;
	indexNulls?: boolean;
}
interface LMDBRootDatabase extends RootDatabase {
	auditStore?: LMDBRootDatabase;
	databaseName?: string;
	dbisDb?: LMDBDatabase;
	isLegacy?: boolean;
	needsDeletion?: boolean;
	path?: string;
	status?: 'open' | 'closed';
	store: any;
	retryRisk?: number;
	flushed: Promise<boolean>;
	rootStore?: LMDBRootDatabase;
}

interface RocksDatabaseEx extends RocksDatabase {
	customIndex?: any;
	env: Record<string, any>;
	isLegacy?: boolean;
	isIndexing?: boolean;
	indexNulls?: boolean;
	getEntry?: (id: string | number | (string | number)[] | Buffer, options?: any) => { value: any };
}

interface RocksRootDatabase extends RocksDatabaseEx {
	auditStore?: RocksDatabaseEx;
	databaseName?: string;
	dbisDb?: RocksDatabaseEx;
	store: any;
	retryRisk?: number;
	flushed: Promise<boolean>;
	rootStore?: RocksRootDatabase;
}

export type RootDatabaseKind = LMDBRootDatabase | RocksRootDatabase;

export type DatabaseWatcherEventMap = {
	updateTable: [table: Table, originIsNotCluster?: boolean];
	dropTable: [tableName: string, databaseName: string];
	dropDatabase: [databaseName: string];
};

export const databaseEventsEmitter = new EventEmitter<DatabaseWatcherEventMap>();

export const tables: Tables = Object.create(null);
export const databases: Databases = Object.create(null);

/**
 * Codec used to honor an "enabled, unspecified" compression setting, or `undefined` where the
 * native build cannot provide it (in which case the request degrades to the build default rather
 * than throwing).
 */
const DEFAULT_ENABLED_CODEC = supportedCompression.includes('lz4') ? 'lz4' : undefined;

/**
 * Map a persisted (LMDB-era) compression value to what rocksdb-js accepts. Table metadata carries
 * values where a defined falsy value (false, '') means compression was explicitly disabled, and
 * `true` / `{ threshold, ... }` mean enabled with defaults — `storage.compression` defaults to
 * `true` (defaultConfig.yaml), so essentially every pre-existing table asked for compression.
 *
 * "Enabled" resolves to an explicit codec rather than to unset. Unset is not equivalent: RocksDB
 * persists the codec per column family and a reopen that requests nothing inherits what the family
 * already has, applying the build default only when the family does not yet exist. Leaving these
 * unset therefore silently ignores the operator's request on every database created before the
 * native build carried codecs — it keeps writing uncompressed forever, while a brand-new database
 * gets lz4. Naming the codec makes the setting mean the same thing in both cases.
 *
 * This governs newly written files; existing SSTs keep their codec until write traffic rewrites
 * them (`db.compact()` will not — see getRocksCompression above).
 */
export function toRocksCompression(compression: unknown): unknown {
	if (compression === undefined) return undefined;
	if (!compression) return 'none';
	// An object carrying an explicit `algorithm` is already a rocksdb-js request; anything else
	// (`true`, or an LMDB descriptor like { startingOffset, threshold }) is "enabled, unspecified".
	if (compression === true || (typeof compression === 'object' && !(compression as { algorithm?: unknown }).algorithm))
		return DEFAULT_ENABLED_CODEC;
	return compression;
}

function openRocksDatabase(path: string, options: RocksDatabaseOptions & { dupSort?: boolean }) {
	options.disableWAL ??= true;
	const legacyOptions = options as { compression?: unknown };
	// A configured codec applies to every column family, overriding whatever per-table metadata
	// carries — that metadata records the LMDB-era boolean, so without this there is no way to
	// select a RocksDB codec for a deployment.
	// One codec for every column family, and applied to every family this open touches — not just
	// the one being named. RocksDB opens them all at once and a family's codec cannot change while
	// it is open, so a family this process never names individually would otherwise stay on
	// whatever it was created with, forever.
	const databaseCodec = getRocksCompression();
	legacyOptions.compression = databaseCodec;
	if (databaseCodec) (options as { compressionForAllColumnFamilies?: boolean }).compressionForAllColumnFamilies = true;
	// Apply read-only mode if enabled
	if (isReadOnlyMode()) {
		options.readOnly = true;
	}
	// Read RocksDB memory config lazily so env/CLI overrides applied after module load are
	// respected. The block cache falls back to 25% of constrained (cgroup) memory when not
	// configured; the WriteBufferManager defaults to 1/3 of the block cache size (set its size
	// to 0 to disable). See resolveRocksMemoryConfig for the defaulting rules.
	//
	// Note: writeBufferManagerCostToCache and writeBufferManagerAllowStall are fixed at WBM
	// creation time inside rocksdb-js (the underlying RocksDB API doesn't support changing
	// costToCache on a live manager, and allowStall is only re-applied when explicitly changed).
	// In practice that's fine — these come from process-level config that doesn't change.
	RocksDatabase.config(
		resolveRocksMemoryConfig({
			configuredBlockCacheSize: envGet(CONFIG_PARAMS.STORAGE_ROCKS_BLOCKCACHESIZE),
			configuredWriteBufferManagerSize: envGet(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERSIZE),
			configuredCostToCache: envGet(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERCOSTTOCACHE),
			configuredAllowStall: envGet(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERALLOWSTALL),
			availableMemory: Math.min(process.constrainedMemory?.() ?? Infinity, totalmem()),
		})
	);
	if (!existsSync(path)) {
		// Don't create directories in read-only mode
		if (isReadOnlyMode()) {
			throw new Error(`Database cannot be created in read-only mode: ${path}`);
		}
		mkdirSync(path, { recursive: true });
	}
	let db: RocksRootDatabase;
	if (options.dupSort) {
		db = new RocksIndexStore(path, options).open() as any;
	} else {
		db = new PrimaryRocksDatabase(path, options).open() as unknown as RocksRootDatabase;
		// the RocksDB put and remove return promises, which masks thrown errors in non-awaiting calls to put/remove,
		// making them unsafe to replace LMDB methods, which will synchronously throw errors if there is a problem.
		// The versioned remove is necessarily async and its callers must await or otherwise track its promise.
		db.put = db.putSync as any;
		db.remove = ((id: any, removeOptions?: any) =>
			typeof removeOptions === 'number'
				? (db as unknown as PrimaryRocksDatabase).removeIfVersion(id, removeOptions)
				: db.removeSync(id, removeOptions)) as any;
		(db.encoder as any).name = options.name;
	}
	db.env = {};
	return db;
}

const lmdbDatabaseEnvs = new Map<string, LMDBRootDatabase>();
const rocksdbDatabaseEnvs = new Map<string, RocksRootDatabase>();

// set the following in both global and exports
_assignPackageExport('databases', databases);
_assignPackageExport('tables', tables);

const NEXT_TABLE_ID = Symbol.for('next-table-id');
// Restore every field used by `commonChanged`, plus `indexed` and `indexNulls`,
// from the durable descriptor. In particular, preserve `indexNulls: false` so
// an index that excludes nulls is not reopened as though it contains them.
const PEER_REDEFINABLE_FIELDS = [
	'type',
	'indexed',
	'indexNulls',
	'nullable',
	'enumerable',
	'version',
	'elements',
	'properties',
	'embed',
];
// `indexNulls` is derived from the durable descriptor, never sent by a peer, so naming it in the
// discard warn would blame the peer for a field it did not write.
const PEER_DECLARABLE_FIELDS = PEER_REDEFINABLE_FIELDS.filter((field) => field !== 'indexNulls');

// A cluster-origin caller's list can predate a declaration another thread has already committed, so on
// that path the descriptor — not the caller — decides what the attribute is, in both directions.
function applyDurableDeclaration(attribute: any, descriptor: any) {
	for (const field of PEER_REDEFINABLE_FIELDS) {
		if (field in descriptor) attribute[field] = descriptor[field];
		else delete attribute[field];
	}
}
// How many times the schema load will try to finish a tombstoned drop before
// giving up for the rest of this process's lifetime. A drop that fails once
// almost always fails identically forever - the usual cause is a RocksDB
// environment that latched a background error and now rejects every write it
// receives - and the schema load re-runs on every resetDatabases(), so an
// unbounded retry turns one broken table into a per-reload log flood in every
// worker thread.
const MAX_INTERRUPTED_DROP_ATTEMPTS = 3;
// physical store path + table -> drop generation -> consecutive failed
// completion attempts in this thread. Keyed by the physical store path
// rather than the database alias name: multiple database names can point at
// the same directory (config-level aliasing), and readMetaDb/readRocksMetaDb
// reconcile each alias's schema independently, so a table shared by N
// aliases would otherwise be attempted (and give up) N times over - once per
// alias - on top of the once-per-worker duplication. Keying by path
// collapses all of that back down to one budget, and one give-up log via the
// worker-0 gate below, per physical table.
//
// Nested by generation (Table.ts stamps a fresh id on every dropping
// tombstone) rather than a single flat count per path+table: a worker can
// exhaust one drop's budget, then observe the table recreated and dropped
// again without ever seeing an intermediate non-tombstoned row to reset on.
// A fresh generation always gets a fresh inner-map key, independent of what
// any worker last observed. Tombstones written before this field existed
// fall back to a shared 'legacy' bucket. Nesting (rather than a flat map
// keyed by a combined string) also makes "clear every generation for this
// path+table" an O(1) delete of the outer entry instead of a scan - a live
// (non-tombstoned) row never carries the dropGeneration of whatever drop it
// resolved, so a resolution can only ever identify the outer path+table key,
// never the specific spent generation to target.
const interruptedDropAttempts = new Map<string, Map<string, number>>();
const interruptedDropTableKey = (storePath: string, tableName: string) => `${storePath}\0${tableName}`;
function getInterruptedDropAttempts(storePath: string, tableName: string, generation?: string): number {
	return interruptedDropAttempts.get(interruptedDropTableKey(storePath, tableName))?.get(generation ?? 'legacy') ?? 0;
}
function setInterruptedDropAttempts(
	storePath: string,
	tableName: string,
	generation: string | undefined,
	attempts: number
) {
	const tableKey = interruptedDropTableKey(storePath, tableName);
	let generations = interruptedDropAttempts.get(tableKey);
	if (!generations) interruptedDropAttempts.set(tableKey, (generations = new Map()));
	generations.set(generation ?? 'legacy', attempts);
}
function clearInterruptedDropEntries(storePath: string, tableName: string) {
	interruptedDropAttempts.delete(interruptedDropTableKey(storePath, tableName));
}
let loadedDatabases; // indicates if we have loaded databases from the file system yet

// This is used to track all the databases that are found when iterating through the file system so that anything that is missing
// can be removed:
let definedDatabases: Map<string, Set<string>>;

/**
 * This gets the set of tables from the default database ("data").
 */
export function getTables(): Tables {
	if (!loadedDatabases) {
		getDatabases();
	}
	return tables || {};
}

/**
 * This provides the main entry point for getting the set of all Harper tables (organized by schemas/databases).
 * This proactively scans the known
 * databases/schemas directories and finds any databases and opens them. This done proactively so that there is a fast
 * object available to all consumers that doesn't require runtime checks for database open states.
 * This also attaches the audit store associated with table. Note that legacy tables had a single audit table per db table
 * but in newer multi-table databases, there is one consistent, integrated audit table for the database since transactions
 * can span any tables in the database.
 */
export function getDatabases(): Databases {
	if (loadedDatabases) {
		return databases;
	}
	loadedDatabases = true;

	definedDatabases = new Map();
	relationshipsToHydrate = [];
	const hdbBasePath = getHdbBasePath();
	let databasePath = hdbBasePath && join(hdbBasePath, DATABASES_DIR_NAME);
	const schemaConfigs = envGet(CONFIG_PARAMS.DATABASES) || {};

	// not sure why this doesn't work with the environmemt manager
	if (process.env.SCHEMAS_DATA_PATH) schemaConfigs.data = { path: process.env.SCHEMAS_DATA_PATH };
	databasePath =
		process.env.STORAGE_PATH ||
		getConfigPath(CONFIG_PARAMS.STORAGE_PATH) ||
		(databasePath && (existsSync(databasePath) ? databasePath : join(getHdbBasePath(), LEGACY_DATABASES_DIR_NAME)));
	if (databasePath && existsSync(databasePath)) {
		// First load all the databases from our main database folder
		// TODO: Load any databases defined with explicit storage paths from the config
		const entries = readdirSync(databasePath, { withFileTypes: true });
		const blockedByRestore = databasesBlockedByRestore(databasePath);
		for (const databaseEntry of entries) {
			// in-progress migration staging dirs are not databases until atomically renamed into place
			if (databaseEntry.name.endsWith(MIGRATING_DIR_SUFFIX)) continue;
			// the restore-metadata directory is reserved: never load it as a database, even if a
			// (out-of-band) RocksDB directory happens to occupy that reserved name — the API can't
			// create it (schemaRegex forbids the backtick), but the scan opens any CURRENT+MANIFEST dir
			if (databaseEntry.name === RESTORE_META_DIR) continue;
			// branch directories are process-local derivatives, never databases in their own right
			if (databaseEntry.name === BRANCH_ROOT_DIR) continue;
			const dbName = basename(databaseEntry.name, '.mdb');
			const dbPath = join(databasePath, databaseEntry.name);
			if (blockedByRestore.has(dbName)) continue;
			if (isOpenBranchPath(dbPath)) continue;

			if (
				databaseEntry.isFile() &&
				extname(databaseEntry.name).toLowerCase() === '.mdb' &&
				!schemaConfigs[dbName]?.path
			) {
				logger.trace(`loading lmdb database: ${dbPath}`);
				readMetaDb(dbPath, null, dbName);
				continue;
			}
			try {
				const files = readdirSync(dbPath, { withFileTypes: true });
				if (
					files.find((file) => file.name === 'CURRENT')?.isFile() &&
					files.some((file) => file.name.startsWith('MANIFEST-')) &&
					!schemaConfigs[dbName]?.path
				) {
					readRocksMetaDb(dbPath, null, dbName);
					continue;
				}
			} catch (err) {
				if (!('code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
					throw err;
				}
			}
		}
	}

	// now we load databases from the legacy "schema" directory folder structure
	const baseSchemaPath = getBaseSchemaPath();
	if (existsSync(baseSchemaPath)) {
		for (const schemaEntry of readdirSync(baseSchemaPath, { withFileTypes: true })) {
			if (!schemaEntry.isFile()) {
				const schemaPath = join(baseSchemaPath, schemaEntry.name);
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
				const entries = readdirSync(databasePath, { withFileTypes: true });
				const blockedByRestore = databasesBlockedByRestore(databasePath);
				for (const databaseEntry of entries) {
					if (databaseEntry.name.endsWith(MIGRATING_DIR_SUFFIX)) continue; // migration staging dir
					if (databaseEntry.name === RESTORE_META_DIR) continue; // reserved restore-metadata dir
					if (databaseEntry.name === BRANCH_ROOT_DIR) continue; // reserved branch root
					if (blockedByRestore.has(basename(databaseEntry.name, '.mdb'))) continue;
					if (isOpenBranchPath(join(databasePath, databaseEntry.name))) continue;
					if (databaseEntry.isFile() && extname(databaseEntry.name).toLowerCase() === '.mdb') {
						readMetaDb(join(databasePath, databaseEntry.name), basename(databaseEntry.name, '.mdb'), dbName);
					} else {
						try {
							const dbPath = join(databasePath, databaseEntry.name);
							const files = readdirSync(dbPath, { withFileTypes: true });
							if (
								files.find((file) => file.name === 'CURRENT')?.isFile() &&
								files.some((file) => file.name.startsWith('MANIFEST-'))
							) {
								readRocksMetaDb(dbPath, null, dbName);
								continue;
							}
						} catch (err) {
							if (!('code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
								throw err;
							}
						}
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
			if (dbName.includes('delete')) logger.trace(`defined tables ${Array.from(definedTables.keys())}`);

			for (const tableName in tables) {
				if (!definedTables.has(tableName)) {
					logger.trace(`delete table class ${tableName}`);
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
	hydrateCatalogRelationships();
	if (envGet(CONFIG_PARAMS.ANALYTICS_REPLICATE) === false) {
		if (!NON_REPLICATING_SYSTEM_TABLES.includes('hdb_analytics')) NON_REPLICATING_SYSTEM_TABLES.push('hdb_analytics');
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
	return databases;
}

/**
 * Hydrate one branch's relationships, resolving each target against the application's own branches
 * first and only then against the real databases: a target the application also branched must be its
 * branch's table, and a target it did not branch is legitimately the shared one.
 */
export function hydrateBranchRelationships(branch: BranchDatabase, branches: Map<string, BranchDatabase>): void {
	const resolveTarget: ResolveRelationshipTarget = (target) => {
		const targetBranch = branches.get(target.database);
		// A branched target resolves ONLY within that branch. A durable branch is a checkpoint frozen
		// at creation while the base keeps evolving, so falling through to the base for a table the
		// branch's own copy lacks would point a branched application's relationship reads at live base
		// data -- the fallback belongs to a database the application did not branch, never to one it did.
		return targetBranch ? targetBranch.tables?.[target.table] : databases[target.database]?.[target.table];
	};
	for (const hydration of branch.pendingRelationships.splice(0)) {
		try {
			hydrateTableRelationships(hydration, resolveTarget);
		} catch (error) {
			logger.error(
				`Unable to hydrate persisted relationships for branch table ${hydration.databaseName}.${hydration.tableName}`,
				error
			);
		}
	}
}

function hydrateCatalogRelationships(): void {
	for (const hydration of relationshipsToHydrate) {
		try {
			hydrateTableRelationships(hydration);
		} catch (error) {
			const key = `${hydration.databaseName}.${hydration.tableName}:hydrate`;
			if (!reportedRelationshipErrors.has(key)) {
				reportedRelationshipErrors.add(key);
				logger.error(
					`Unable to hydrate persisted relationships for ${hydration.databaseName}.${hydration.tableName}`,
					error
				);
			}
		}
	}
}

type ResolveRelationshipTarget = (target: RelationshipTarget) => any;

const resolveTargetGlobally: ResolveRelationshipTarget = (target) => databases[target.database]?.[target.table];

function hydrateTableRelationships(
	{ table, databaseName, tableName, definitions }: RelationshipHydration,
	resolveTarget: ResolveRelationshipTarget = resolveTargetGlobally
): void {
	const hydratable: { definition: PersistedRelationship; targetTable: any }[] = [];
	for (let index = 0; index < definitions.length; index++) {
		const definition = definitions[index] as PersistedRelationship;
		// Keyed by name rather than list position, so a reordered list cannot inherit the previous
		// occupant's reported state and swallow a different relationship's failure — and by reason, so
		// hydrating one entry does not clear the report of a same-named invalid duplicate.
		const errorKey = `${databaseName}.${tableName}:${(definition as any)?.name || `#${index}`}`;
		if (!validRelationshipDefinition(definition, definitions, index)) {
			reportRelationshipError(
				`${errorKey}:invalid`,
				`Ignoring invalid persisted relationship ${databaseName}.${tableName}[${index}]`
			);
			continue;
		}
		// a live schema attribute of the same name owns the name; the catalog copy is only a stand-in
		// for threads that never loaded the schema
		if (table.attributes.some((attribute) => attribute.name === definition.name && !attribute[CATALOG_RELATIONSHIP]))
			continue;
		const targetTable = resolveTarget(definition.target);
		if (!targetTable || !relationshipFieldsExist(table, targetTable, definition)) {
			reportRelationshipError(
				`${errorKey}:unavailable`,
				`Unable to hydrate persisted relationship ${databaseName}.${tableName}.${definition.name}: target or foreign key is unavailable`
			);
			continue;
		}
		reportedRelationshipErrors.delete(`${errorKey}:unavailable`);
		hydratable.push({ definition, targetTable });
	}

	const installed = table.attributes.filter((attribute) => attribute[CATALOG_RELATIONSHIP]);
	if (
		installed.length === hydratable.length &&
		hydratable.every(
			({ definition, targetTable }, index) =>
				relationshipEquals(installed[index], definition) &&
				(installed[index].definition || installed[index].elements?.definition)?.tableClass === targetTable
		)
	)
		return;

	const attributes = table.attributes.filter((attribute) => !attribute[CATALOG_RELATIONSHIP]);
	for (const { definition, targetTable } of hydratable)
		attributes.push(createCatalogRelationship(definition, targetTable));
	table.attributes.splice(0, table.attributes.length, ...attributes);
	table.schemaVersion++;
	table.updatedAttributes();
	databaseEventsEmitter.emit('updateTable', table);
}

function validRelationshipDefinition(definition: any, definitions: unknown[], index: number): boolean {
	if (!definition || typeof definition !== 'object') return false;
	const validName = (value: any) => typeof value === 'string' && value.length > 0 && !/[`/]/.test(value);
	if (!validName(definition.name) || !validName(definition.type)) return false;
	if (!validName(definition.target?.database) || !validName(definition.target?.table)) return false;
	if (!definition.relationship || typeof definition.relationship !== 'object') return false;
	const { from, to, filterMissing } = definition.relationship;
	if (from !== undefined && !validName(from)) return false;
	if (to !== undefined && !validName(to)) return false;
	if (!from && !to) return false;
	if (filterMissing !== undefined && typeof filterMissing !== 'boolean') return false;
	if (definition.type === 'array' ? !validName(definition.elements?.type) : definition.elements !== undefined)
		return false;
	for (let earlier = 0; earlier < index; earlier++)
		if ((definitions[earlier] as any)?.name === definition.name) return false;
	return true;
}

function relationshipFieldsExist(sourceTable: any, targetTable: any, definition: PersistedRelationship): boolean {
	if (
		definition.relationship.from &&
		!sourceTable.attributes.some((attribute) => attribute.name === definition.relationship.from)
	)
		return false;
	if (
		definition.relationship.to &&
		!targetTable.attributes.some((attribute) => attribute.name === definition.relationship.to)
	)
		return false;
	return true;
}

function createCatalogRelationship(definition: PersistedRelationship, targetTable: any): any {
	const attribute: any = {
		name: definition.name,
		attribute: definition.name,
		type: definition.type,
		relationship: { ...definition.relationship },
		target: { ...definition.target },
	};
	const targetDefinition = {
		tableClass: targetTable,
		type: targetTable.tableName,
		attributes: targetTable.attributes,
	};
	if (definition.elements) {
		attribute.elements = { type: definition.elements.type };
		Object.defineProperty(attribute.elements, 'definition', { value: targetDefinition, configurable: true });
	} else {
		Object.defineProperty(attribute, 'definition', { value: targetDefinition, configurable: true });
	}
	Object.defineProperty(attribute, CATALOG_RELATIONSHIP, { value: true });
	return attribute;
}

function reportRelationshipError(key: string, message: string): void {
	if (reportedRelationshipErrors.has(key)) return;
	reportedRelationshipErrors.add(key);
	logger.error(message);
}

/**
 * Scan a databases directory's entries for restore lock/marker files and return the names of
 * databases that must not be loaded: a held restore lock means a restore is in progress in some
 * process; an unheld lock with a surviving `.restoring` marker means a restore was interrupted
 * mid-purge (the directory may be partial garbage) and must be rerun. The files live *next to*
 * the database directory, so this also covers a database whose directory is missing or empty.
 */
function databasesBlockedByRestore(databasePath: string): Set<string> {
	const blocked = new Set<string>();
	for (const [dbName, state] of scanBlockedRestores(databasePath)) {
		if (state === 'in-progress') {
			logger.warn(`A restore of database '${dbName}' is in progress; not loading it`);
			blocked.add(dbName);
		} else if (state === 'incomplete') {
			logger.error(
				`Incomplete restore of database '${dbName}' detected (a restore started but did not finish); not loading it — rerun the restore to recover`
			);
			blocked.add(dbName);
		}
	}
	return blocked;
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
	const envInit = new OpenEnvironmentObject(path, isReadOnlyMode());
	try {
		let rootStore = lmdbDatabaseEnvs.get(path);
		if (rootStore) {
			rootStore.needsDeletion = false;
		} else {
			rootStore = open(envInit) as any;
			lmdbDatabaseEnvs.set(path, rootStore);
		}

		return initStores(path, rootStore, databaseName, { defaultTable, auditPath, isLegacy });
	} catch (error) {
		error.message += ` opening database ${path}`;
		throw error;
	}
}

function readRocksMetaDb(
	path: string,
	defaultTable?: string,
	databaseName: string = DEFAULT_DATABASE_NAME,
	{ destination, storeName, openedStores }: Pick<InitStoresOptions, 'destination' | 'storeName' | 'openedStores'> = {}
) {
	try {
		logger.trace(`loading rocksdb database: ${path}`);

		if (process.env.HARPER_PARENT_PROCESS_PID) {
			const parentProcessPid = parseInt(process.env.HARPER_PARENT_PROCESS_PID);
			if (isProcessRunning(parentProcessPid)) {
				logger.info(`Parent process ${parentProcessPid} is still running!`);
			}
		}

		let rootStore: RocksRootDatabase | undefined = rocksdbDatabaseEnvs.get(path);
		if (rootStore) {
			initStores(path, rootStore, databaseName, { defaultTable, destination, storeName, openedStores });
		} else {
			rootStore = openRocksDatabase(path, { disableWAL: false, enableStats: true }) as any;
			rocksdbDatabaseEnvs.set(path, rootStore);
			initStores(path, rootStore, databaseName, { defaultTable, destination, storeName, openedStores });
			// A branch (`destination`) recovers its transaction-log tail in `openOrCreate`
			// (branchDatabase.ts), not here: the branch claim elects exactly one replaying thread —
			// applications load on workers, where this call would be a no-op — and awaits the replay
			// before the branch is published to any reader. See the contract note on
			// `openBranchDatabase` (harper#643).
			if (!isReadOnlyMode() && !destination) {
				replayLogs(rootStore, databases[databaseName]);
			}
		}
		return rootStore;
	} catch (error) {
		error.message += ` opening database ${path}`;
		throw error;
	}
}

interface InitStoresOptions {
	defaultTable?: string;
	auditPath?: string;
	isLegacy?: boolean;
	/** Build the Table classes here instead of the global `databases` map, and emit no global event. */
	destination?: Tables;
	/**
	 * Identity stamped on the root store, when it must differ from the logical `databaseName` the
	 * Table classes carry. `getRootBlobPathsForDB` resolves blob directories from it.
	 */
	storeName?: string;
	/**
	 * Every column family opened here is appended, so a caller can release the ones a failure left
	 * unreachable — a table's stores are opened well before `setTable` publishes it into the graph.
	 */
	openedStores?: any[];
}

function initStores(
	path: string,
	rootStore: RootDatabaseKind,
	databaseName: string,
	{ defaultTable, auditPath, isLegacy, destination, storeName, openedStores }: InitStoresOptions = {}
) {
	// a store with no tables never reaches the per-table loop below, and blob roots resolve from this
	rootStore.databaseName = storeName ?? databaseName;
	const envInit = new OpenEnvironmentObject(path, isReadOnlyMode());
	const internalDbiInit = createOpenDBIObject(false);
	let attributesDbi = rootStore.dbisDb;
	if (!attributesDbi) {
		if (rootStore instanceof RocksDatabase) {
			attributesDbi = openRocksDatabase(rootStore.path, {
				...internalDbiInit,
				disableWAL: false,
				name: INTERNAL_DBIS_NAME,
			} as any);
		} else {
			attributesDbi = rootStore.openDB(INTERNAL_DBIS_NAME, internalDbiInit as any);
		}
		rootStore.dbisDb = markInternalDbiNonVersioned(attributesDbi);
	}

	let auditStore = rootStore.auditStore;
	if (!auditStore) {
		if (auditPath) {
			if (existsSync(auditPath)) {
				envInit.path = auditPath;
				if (rootStore instanceof RocksDatabase) {
					auditStore = openAuditStore(rootStore);
				} else {
					auditStore = open({
						...envInit,
						encoder: {
							encode: (auditRecord: AuditRecord) => createAuditEntry(auditRecord),
							decode: (encoding: Buffer) => readAuditEntry(encoding),
						},
					}) as any;
				}
				auditStore.isLegacy = true;
			}
		} else {
			auditStore = openAuditStore(rootStore);
		}
	}

	const tables = destination ?? ensureDB(databaseName);
	if (destination && !destination[DEFINED_TABLES]) destination[DEFINED_TABLES] = new Set<string>();
	const definedTables = tables[DEFINED_TABLES];
	(definedTables as any).rootStore = rootStore;
	const tablesToLoad = new Map<string, any>();

	for (const result of attributesDbi.getRange({ start: false })) {
		const { key, value } = result as { key: string; value: any };
		if (value == null) continue;
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
				value.indexed = !value.isPrimaryKey;
			}
		}
		definedTables?.add(tableName);
		let tableDef = tablesToLoad.get(tableName);
		if (!tableDef) tablesToLoad.set(tableName, (tableDef = { attributes: [] }));
		if (attribute_name == null || value.isPrimaryKey) tableDef.primary = value;
		if (attribute_name != null) tableDef.attributes.push(value);
		Object.defineProperty(value, 'key', { value: key, configurable: true });
	}

	// Complete any drops that were interrupted mid-flight. dropTable persists a
	// `dropping` tombstone on the table's primary catalog entry before removing
	// column families; if the process died or a column family drop failed
	// partway, the tombstone survives alongside the catalog rows. Without this
	// reconcile, those rows would silently resurrect the table below
	// (recreating any missing column families as empty stores).
	// The attempt budget is deliberately scoped to this reconcile: the create path
	// calls completeInterruptedDrop under the exclusive lock and must never skip
	// it, because creating over a half-dropped table would resurrect its catalog
	// rows. There a failure propagates to the caller as its own single error.
	for (const [tableName, tableDef] of tablesToLoad) {
		if (!tableDef.primary?.dropping) {
			// No tombstone, so any budget this table spent belongs to a drop that
			// has since been resolved - by the create path, which completes
			// interrupted drops itself and never passes through here. Leaving the
			// budget spent would permanently skip cleanup for the table's NEXT
			// interrupted drop. Checked (and, on the common all-live path, skipped)
			// before touching the generation or the map at all, since this runs for
			// every table on every reconcile pass.
			clearInterruptedDropEntries(path, tableName);
			continue;
		}
		const generation = tableDef.primary?.dropGeneration;
		const failedAttempts = getInterruptedDropAttempts(path, tableName, generation);
		if (failedAttempts < MAX_INTERRUPTED_DROP_ATTEMPTS) {
			try {
				completeInterruptedDrop(rootStore, attributesDbi, databaseName, tableName);
				// Sweep every generation this worker has ever tracked for this table, not
				// just the one just resolved: if a prior generation was exhausted here,
				// then resolved+recreated+re-dropped by another worker as this generation
				// without this worker ever observing a live row in between (the only other
				// place that sweeps), the prior generation's entry would otherwise never
				// be cleared.
				clearInterruptedDropEntries(path, tableName);
				definedTables?.delete(tableName);
			} catch (error) {
				const attempt = failedAttempts + 1;
				setInterruptedDropAttempts(path, tableName, generation, attempt);
				const dropLabel = `${databaseName}.${tableName}`;
				if (attempt < MAX_INTERRUPTED_DROP_ATTEMPTS) {
					logger.debug(`Failed to complete interrupted drop of table ${dropLabel}, attempt ${attempt}`, error);
				} else if (manageThreads.getWorkerIndex() === 0) {
					// The attempt budget (and this failure) is independently tracked per worker
					// thread, and the failure isn't transient, so every worker converges on the
					// same give-up outcome. Only worker 0 - which exists in every threading mode,
					// including threads:0 where the main thread acts as worker 0 - logs it, so one
					// stuck table produces one actionable error instead of one per worker.
					logger.error(
						`Unable to complete the interrupted drop of table ${dropLabel} after ${attempt} attempts; giving up until this worker restarts (a full node restart also resets this). ${tableName} stays unloaded, with its catalog rows and column families left in place. An "Invalid column family specified in write batch" cause means the storage environment for ${databaseName} has latched a background error and will reject every write to every table in it until this node restarts.`,
						error
					);
				}
			}
		}
		// whether or not cleanup succeeded, never load a table that was being dropped
		tablesToLoad.delete(tableName);
	}

	for (const [tableName, tableDef] of tablesToLoad) {
		let { attributes, primary: primaryAttribute } = tableDef;
		if (!primaryAttribute) {
			// this isn't defined, find it in the attributes
			for (const attribute of attributes) {
				if (attribute.isPrimaryKey) {
					primaryAttribute = attribute;
					break;
				}
			}
			if (!primaryAttribute) {
				logger.warn(
					`Unable to find a primary key attribute on table ${tableName}, with attributes: ${JSON.stringify(attributes)}`
				);
				continue;
			}
		}
		// if the table has already been defined, use that class, don't create a new one
		let table = tables[tableName];
		// unless its store was migrated to a different engine (e.g. LMDB to RocksDB on startup)
		const recreateForEngineChange =
			!!table && (table as any).primaryStore?.rootStore instanceof RocksDatabase !== rootStore instanceof RocksDatabase;
		let indices = {},
			existingAttributes = [];
		let tableId;
		let primaryStore;
		const audit =
			typeof primaryAttribute.audit === 'boolean' ? primaryAttribute.audit : envGet(CONFIG_PARAMS.LOGGING_AUDITLOG);
		const trackDeletes = primaryAttribute.trackDeletes;
		const expiration = primaryAttribute.expiration;
		const eviction = primaryAttribute.eviction;
		const sealed = primaryAttribute.sealed;
		const cacheControl = primaryAttribute.cacheControl;
		const splitSegments = primaryAttribute.splitSegments;
		const replicate = primaryAttribute.replicate;
		if (table && !recreateForEngineChange) {
			indices = table.indices;
			existingAttributes = table.attributes;
			table.schemaVersion++;
		} else {
			tableId = primaryAttribute.tableId;
			if (tableId) {
				if (tableId >= ((attributesDbi as any).getSync(NEXT_TABLE_ID) || 0)) {
					(attributesDbi as any).putSync(NEXT_TABLE_ID, tableId + 1);
					logger.info(`Updating next table id (it was out of sync) to ${tableId + 1} for ${tableName}`);
				}
			} else {
				primaryAttribute.tableId = tableId = (attributesDbi as any).getSync(NEXT_TABLE_ID);
				if (!tableId) tableId = 1;
				logger.debug(`Table {tableName} missing an id, assigning {tableId}`);
				(attributesDbi as any).putSync(NEXT_TABLE_ID, tableId + 1);
				(attributesDbi as any).putSync(primaryAttribute.key, primaryAttribute);
			}
			const dbiInit = createOpenDBIObject(!primaryAttribute.isPrimaryKey, primaryAttribute.isPrimaryKey);
			dbiInit.compression = primaryAttribute.compression;
			if (dbiInit.compression) {
				const compressionThreshold =
					envGet(CONFIG_PARAMS.STORAGE_COMPRESSION_THRESHOLD) || DEFAULT_COMPRESSION_THRESHOLD; // this is the only thing that can change;
				dbiInit.compression.threshold = compressionThreshold;
			}
			// per-table override of the storage.randomAccessFields default (see OpenDBIObject)
			if (typeof primaryAttribute.randomAccessFields === 'boolean')
				dbiInit.randomAccessStructure = primaryAttribute.randomAccessFields;
			// recorded before the wrapper below, which is the only thing between the native open and
			// the only list a failed open can release it from
			const opened =
				rootStore instanceof RocksDatabase
					? openRocksDatabase(rootStore.path, { ...dbiInit, name: primaryAttribute.key, cache: true } as any)
					: (rootStore as any).openDB(primaryAttribute.key, dbiInit as any);
			openedStores?.push(opened);
			primaryStore = handleLocalTimeForGets(opened, rootStore);
			primaryStore.tableId = tableId;
		}
		let attributesUpdated: boolean;
		for (const attribute of attributes) {
			attribute.attribute = attribute.name;
			try {
				// now load the non-primary keys, opening the dbs as necessary for indices
				if (!attribute.isPrimaryKey && (attribute.indexed || (attribute.attribute && !attribute.name))) {
					if (!indices[attribute.name]) {
						const dbi = openIndex(attribute.key, rootStore, attribute);
						openedStores?.push(dbi);
						indices[attribute.name] = dbi;
						indices[attribute.name].indexNulls = attribute.indexNulls;
					}
					const existingAttribute = existingAttributes.find(
						(existingAttribute) => existingAttribute.name === attribute.name
					);
					if (existingAttribute) existingAttributes.splice(existingAttributes.indexOf(existingAttribute), 1, attribute);
					else existingAttributes.push(attribute);
					attributesUpdated = true;
				} else if (!attribute.isPrimaryKey) {
					// Non-indexed, non-primary-key attributes (e.g. plain schema fields like `name: String`)
					// must also be kept in sync so that describe_database reflects schema changes after a
					// hot-reload / worker restart. Without this, resetDatabases() re-reads these attributes
					// from attributesDbi but never merges them back into table.attributes — causing stale
					// schema metadata until a full kill+restart. (RE-7)
					const existingIdx = existingAttributes.findIndex((ea) => ea.name === attribute.attribute);
					if (existingIdx >= 0) {
						existingAttributes.splice(existingIdx, 1, attribute);
						attributesUpdated = true;
					} else {
						existingAttributes.push(attribute);
						attributesUpdated = true;
					}
				}
			} catch (error) {
				logger.error(`Error trying to update attribute`, attribute, existingAttributes, indices, error);
			}
		}
		// Collect removals first; splicing while iterating `existingAttributes` skips adjacent
		// elements, which would silently leave stale fields behind when two or more were dropped
		// in the same reload.
		const toRemove = [];
		for (const existingAttribute of existingAttributes) {
			const attribute = attributes.find((attribute) => attribute.name === existingAttribute.name);
			if (!attribute) {
				if (existingAttribute.isPrimaryKey) {
					logger.error(
						new Error('Unable to remove existing primary key attribute'),
						existingAttribute,
						'from attributes',
						existingAttributes,
						'in',
						tableName,
						'requesting new attribute list',
						attributes,
						'full metadata list',
						Array.from(attributesDbi.getRange({ start: false }))
					);
					continue;
				}
				if (existingAttribute.indexed) {
					// we only remove attributes if they were indexed, in order to support dropAttribute that removes dynamic indexed attributes
					toRemove.push(existingAttribute);
				} else if (!existingAttribute.isPrimaryKey) {
					// Skip runtime-only attributes (e.g. relationship attrs — table()'s persistence loop
					// `continue`s past them at line 1138). They are present in `existingAttributes` but
					// never in the `attributes` list rebuilt from attributesDbi; removing them would drop
					// the resolver/search support added by updatedAttributes(). Computed attrs ARE
					// persisted, so only `relationship` is excluded here.
					if (existingAttribute.relationship) continue;
					toRemove.push(existingAttribute);
				}
			}
		}
		for (const existingAttribute of toRemove) {
			existingAttributes.splice(existingAttributes.indexOf(existingAttribute), 1);
			attributesUpdated = true;
		}
		if (table && !recreateForEngineChange) {
			if (attributesUpdated) {
				table.schemaVersion++;
				table.updatedAttributes();
			}
		} else {
			table = setTable(
				tables,
				tableName,
				makeTable({
					// A branch builds into a caller-owned destination; its tables must refuse DDL.
					isBranch: Boolean(destination),
					primaryStore,
					auditStore,
					audit,
					sealed,
					splitSegments,
					replicate,
					expirationMS: expiration && expiration * 1000,
					evictionMS: eviction && eviction * 1000,
					cacheControl,
					trackDeletes,
					tableName,
					tableId,
					primaryKey: primaryAttribute.name,
					databasePath: isLegacy ? `${databaseName}/${tableName}` : databaseName,
					databaseName,
					indices,
					attributes,
					schemaDefined: primaryAttribute.schemaDefined,
					dbisDB: attributesDbi,
				})
			);
			table.schemaVersion = 1;
			if (!destination) databaseEventsEmitter.emit('updateTable', table);
		}
		if (Array.isArray(primaryAttribute.relationships)) {
			relationshipsToHydrate.push({ table, databaseName, tableName, definitions: primaryAttribute.relationships });
		} else if (primaryAttribute.relationships !== undefined) {
			reportRelationshipError(
				`${databaseName}.${tableName}:list`,
				`Ignoring invalid persisted relationship list for ${databaseName}.${tableName}`
			);
			relationshipsToHydrate.push({ table, databaseName, tableName, definitions: [] });
		}
	}
	return rootStore;
}

/**
 * Branch directories live beside the base database's own storage root, never under the HDB root: a
 * database can be placed on its own volume, and `createCheckpoint` only hardlinks when source and
 * target share a filesystem — off-volume it degrades to a full byte copy, which is the property the
 * whole feature rests on.
 *
 * The backticks are what make the name reserved rather than merely conventional: `schemaRegex`
 * (validation/common_validators.ts) excludes 0x60, so no database can ever be created under this
 * name and shadow the branch root -- the same protection RESTORE_META_DIR uses.
 */
export const BRANCH_ROOT_DIR = '`branches`';

/**
 * Where the branch of `baseName` belonging to `appName` lives. Derived only from those two names, so
 * every node in a cluster resolves the same application's branch to the same place — the identity an
 * application's data needs if it is to be addressed, and eventually replicated, cluster-wide.
 *
 * App and database are separate path segments: joining them (`<app>__<db>`) is not injective —
 * `(a__b, c)` and `(a, b__c)` collide — so two declarations could otherwise open one directory.
 */
export function resolveBranchPath(baseName: string, appName: string): string {
	for (const [label, segment] of [
		['application', appName],
		['database', baseName],
	]) {
		if (!segment || segment.includes('/') || segment.includes('\\') || segment === '.' || segment === '..') {
			throw new Error(`Invalid ${label} name for a branch path: ${JSON.stringify(segment)}`);
		}
	}
	return join(resolveDatabaseStorageRoot(baseName), BRANCH_ROOT_DIR, appName, baseName);
}

/** A branch's private table graph plus the handle needed to tear it down. */
export interface BranchDatabase {
	tables: Tables;
	rootStore: RootDatabaseKind;
	/**
	 * Relationships this branch's tables declared, still un-hydrated. They cannot be resolved at open
	 * time: a branch's definitions name the BASE database (its tables carry the base's logical names),
	 * so resolving them through the global map would point the application's relationship reads at the
	 * base. `hydrateBranchRelationships` finishes the job once the whole branch set is known.
	 */
	pendingRelationships: RelationshipHydration[];
	close(): void;
}

/** `undefined` marks a path reserved by an open still in flight, which owns it just as firmly. */
const openBranches = new Map<string, BranchDatabase | undefined>();
/** Store identities in use, so two branches cannot resolve one set of blob roots. */
const openBranchIdentities = new Set<string>();

/**
 * True when `dbPath` is a directory an open branch owns. The database scan opens any directory that
 * holds CURRENT + MANIFEST-*, and harper#643 places a branch inside the directory it walks, so
 * without this a rescan would rebuild the branch's tables into the global map, overwrite the store
 * identity its blob roots resolve from, and hand its store to `closeLoadedDatabases`.
 */
function isOpenBranchPath(dbPath: string): boolean {
	if (openBranches.size === 0) return false;
	// the literal path first: `rocksdbDatabaseEnvs` is keyed by it too, so a directory unlinked under
	// a live branch handle (realpathSync then throws) must not read as unowned
	if (openBranches.has(dbPath)) return true;
	try {
		return openBranches.has(realpathSync(dbPath));
	} catch {
		return false;
	}
}

/**
 * A branch identity resolves its blob roots through `join(…, 'blobs', storeName)`, so it must be a
 * single path segment: `schemaRegex`, which every other database name is validated against, plus the
 * dot segments and backslash that regex permits but a path component must not be.
 */
function assertLegalBranchName(name: string, description: string): void {
	if (
		!name ||
		name.length > commonValidators.schema_length.maximum ||
		!schemaRegex.test(name) ||
		name.includes('\\') ||
		name === '.' ||
		name === '..'
	) {
		throw new Error(`Cannot use '${name}' as a branch ${description}: it is not a legal database name`);
	}
}

/**
 * Open a RocksDB directory as a **scope-private** database: its Table classes are built into an
 * object the caller owns and nothing is registered in the global `databases` map, so no enumerator
 * of that map — analytics, `describe_all`, worker teardown, replication — can observe it.
 *
 * `databaseName` is the *logical* name the application knows (`data`), so its schema and code need
 * no changes. `storeName` is the branch's own identity and is what `getRootBlobPathsForDB` resolves
 * blob directories from, which is how a branch gets its own blob roots rather than writing into the
 * base's.
 *
 * The caller owns the returned handle; the only thing that closes it on the caller's behalf is
 * `closeBranchDatabases`, which `closeLoadedDatabases` runs at thread teardown so a branch left open
 * on an exiting worker does not leak its handles into the process-global RocksDB registry.
 *
 * NOT SAFE FOR SCHEMA MUTATION. A branch's Table classes carry the base's logical name, so a
 * `dropTable()` or equivalent through one resolves against the global schema and would delete the
 * live base Table class — which is why schema operations through a branch are refused
 * (branchGuard.ts).
 *
 * A branch's blob roots are a hard-link clone of the base's, taken with the checkpoint, so a row
 * whose blob predates the branch reads back normally and the branch allocates new file ids in its own
 * directory (harper#644).
 *
 * A branch is the checkpoint's SST content plus its own transaction-log tail. This function opens
 * only the stores; replaying the tail is `openOrCreate`'s job (branchDatabase.ts), where the
 * cross-thread claim elects exactly one replayer and awaits it before any thread may open the
 * branch — the same recovery contract a base database gets at boot, without which a process that
 * died unflushed silently rewinds the branch to its last memtable flush (harper#643).
 */
/**
 * Refuse a branch store identity that something else already answers to.
 *
 * `storeName` picks the branch's blob roots, and blob file ids restart from each store's own counter,
 * so two holders of one identity write the same file paths and truncate each other. It must be
 * checked BEFORE anything destructive runs: materialization removes and replaces the blob root that
 * this name resolves to, and a real database may legally be called `5_myapp__data` -- `schemaRegex`
 * permits digits, `_` and `.`. The `.staging` sibling materialization writes is covered too, since a
 * database may legally carry that name as well.
 */
export function assertBranchIdentityAvailable(storeName: string): void {
	// The on-disk scan, not just the in-memory maps: a database that exists on disk but has not been
	// loaded is absent from both, and it owns the blob root this identity would destroy.
	getDatabases();
	for (const name of [storeName, `${storeName}.staging`]) {
		if (databases[name] || definedDatabases?.has(name) || openBranchIdentities.has(name)) {
			throw new Error(`Cannot use '${storeName}' as a branch store identity: '${name}' is already in use`);
		}
	}
}

/**
 * Claim the identity as well as checking it, so the window between the check and the branch actually
 * opening cannot be filled by a concurrent create or a second branch. `releaseBranchIdentity` hands
 * it back if materialization never gets as far as opening.
 */
export function reserveBranchIdentity(storeName: string): void {
	assertBranchIdentityAvailable(storeName);
	openBranchIdentities.add(storeName);
}

export function releaseBranchIdentity(storeName: string): void {
	openBranchIdentities.delete(storeName);
}

/** Is this name spoken for by a branch? Database creation has to refuse it -- they share a blob root. */
export function isBranchIdentity(name: string): boolean {
	return openBranchIdentities.has(name);
}

export function openBranchDatabase(path: string, databaseName: string, storeName: string): BranchDatabase {
	assertLegalBranchName(databaseName, 'logical database name');
	assertLegalBranchName(storeName, 'store identity');
	if (!existsSync(path)) throw new Error(`Cannot open branch database: no directory at ${path}`);
	// the guards compare against env-map keys, so two spellings of one directory must not read as two
	path = realpathSync(path);
	// FIRST: the guards below read the registry, and loading is itself what populates
	// `rocksdbDatabaseEnvs`. Claiming the path ahead of this scan would make the scan skip it, which
	// also means a directory that IS a real database no longer reads as one — so the pre-open window
	// where the scan can adopt a branch directory stays open, by choice (harper#643).
	getDatabases();
	// a rival graph over one shared root store; the two callers would disagree about who may close it
	if (openBranches.has(path)) throw new Error(`Branch database at ${path} is already open`);
	// a loaded database's store is closed by `closeLoadedDatabases`, so adopting it would mean this
	// handle's `close()` tears down a live database
	if (rocksdbDatabaseEnvs.has(path)) throw new Error(`Cannot branch ${path}: it is already open as a database`);
	assertBranchIdentityAvailable(storeName);

	const tables: Tables = Object.create(null);
	// initStores opens a table's column families well before `setTable` publishes it into `tables`,
	// so the graph is not a complete record of what a failed open must release
	const openedStores: any[] = [];
	// The boot-time hydration pass has already run by the time a branch opens, so anything this open
	// queues would never be drained. It is handed to the caller instead, which is the only place that
	// knows the application's other branches and can therefore resolve targets without leaking to base.
	const queuedRelationshipsAt = relationshipsToHydrate.length;
	let rootStore: RootDatabaseKind;
	// claim the path before the open, not after: readRocksMetaDb registers the store in
	// `rocksdbDatabaseEnvs` partway through, so anything re-entering `database()` during initStores
	// would otherwise find the branch's store on an unowned path
	openBranches.set(path, undefined);
	openBranchIdentities.add(storeName);
	try {
		rootStore = readRocksMetaDb(path, null, databaseName, { destination: tables, storeName, openedStores });
	} catch (error) {
		openBranches.delete(path);
		openBranchIdentities.delete(storeName);
		const stranded = rocksdbDatabaseEnvs.get(path);
		rocksdbDatabaseEnvs.delete(path);
		closeBranchHandles(path, stranded, openedStores);
		throw error;
	}
	let closed = false;
	const branch: BranchDatabase = {
		tables,
		rootStore,
		pendingRelationships: relationshipsToHydrate.splice(queuedRelationshipsAt),
		close() {
			// guard on the handle, not on the registrations: those are keyed by path, and a closed
			// branch frees its path, so a stale handle would otherwise tear down its successor
			if (closed) return;
			closed = true;
			openBranches.delete(path);
			openBranchIdentities.delete(storeName);
			rocksdbDatabaseEnvs.delete(path);
			closeBranchHandles(path, rootStore, openedStores);
		},
	};
	openBranches.set(path, branch);
	return branch;
}

/**
 * Release everything a branch open created. Each table's primary store and each index is its own
 * column family, on top of the internal-dbis and audit families, so closing the root alone leaves
 * all of them behind — which is why `closeDatabase` walks them individually for a real database.
 * Two process-global registrations outlive the stores as well, neither with a lifetime of its own:
 * a storage-reclamation handler per store path, whose closure pins the now-closed store, and the
 * memoized blob roots in `databasePaths`. A real database is opened once per thread; harper#643
 * makes branch open/close routine, so both would grow with branch churn.
 */
function closeBranchHandles(path: string, rootStore?: RootDatabaseKind, openedStores: any[] = []): void {
	const reclamationPaths = new Set<string>([path]);
	const closeStore = (store: any, description: string) => {
		if (store?.path) reclamationPaths.add(store.path);
		try {
			store?.close?.();
		} catch (error) {
			logger.warn(`Error closing ${description} for branch database at ${path}`, error);
		}
	};
	for (const store of openedStores) closeStore(store, 'column family');
	closeStore((rootStore as any)?.dbisDb, 'attributes store');
	closeStore((rootStore as any)?.auditStore, 'audit store');
	closeStore(rootStore, 'root store');
	if (rootStore) databasePaths.delete(rootStore as RootDatabase);
	for (const reclamationPath of reclamationPaths) removeStorageReclamation(reclamationPath);
}

/** Branches are process-local, so this is shutdown, not a data operation. */
export function closeBranchDatabases(): void {
	for (const branch of [...openBranches.values()]) branch?.close();
}

export function resetDatabases() {
	loadedDatabases = false;
	for (const store of Object.values(lmdbDatabaseEnvs)) {
		store.needsDeletion = true;
	}
	getDatabases();
	for (const [path, store] of lmdbDatabaseEnvs) {
		if (store.needsDeletion && !path.endsWith('system.mdb')) {
			store.close();
			lmdbDatabaseEnvs.delete(path);
		}
	}
	return databases;
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
	randomAccessFields?: boolean;
	trackDeletes?: boolean;
	attributes: any[];
	schemaDefined?: boolean;
	schemaRelationshipsDefined?: boolean;
	origin?: string;
	description?: string;
	properties?: Record<string, any>;
	hidden?: boolean;
	// default Cache-Control for anonymous REST reads; null = schema explicitly has none (clears a
	// prior value on reload), undefined = caller is not schema-defining (leave the current value)
	cacheControl?: string | null;
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
		const definedTables = new Set<string>(); // we create this so we can determine what was found in a reset and remove any removed dbs/tables
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
 * Resolve the directory that holds (or would hold) a database's storage, from the databases
 * config, storage path config/env, or the hdb root — without opening anything. This is the
 * parent directory selection used by `database()`; a RocksDB database lives at
 * `join(resolveDatabaseStorageRoot(...), databaseName)`.
 */
export function resolveDatabaseStorageRoot(databaseName: string, tableName?: string): string {
	const databaseConfig = envGet(CONFIG_PARAMS.DATABASES) || {};
	if (process.env.SCHEMAS_DATA_PATH) {
		databaseConfig.data = { path: process.env.SCHEMAS_DATA_PATH };
	}

	const tablePath = tableName && databaseConfig[databaseName]?.tables?.[tableName]?.path;

	const hdbBasePath = getHdbBasePath();
	const databasePath =
		tablePath ||
		databaseConfig[databaseName]?.path ||
		process.env.STORAGE_PATH ||
		getConfigPath(CONFIG_PARAMS.STORAGE_PATH) ||
		(hdbBasePath && existsSync(join(hdbBasePath, DATABASES_DIR_NAME))
			? join(hdbBasePath, DATABASES_DIR_NAME)
			: hdbBasePath
				? join(hdbBasePath, LEGACY_DATABASES_DIR_NAME)
				: undefined);

	if (!databasePath) {
		throw new Error(
			`Unable to determine database storage path. Ensure STORAGE_PATH, HDB_ROOT, or a valid config path is set.`
		);
	}
	return databasePath;
}

/**
 * Resolve the directory path of a RocksDB database (whether or not it exists or is loaded).
 */
export function resolveDatabasePath(databaseName: string): string {
	return join(resolveDatabaseStorageRoot(databaseName), databaseName);
}

/**
 * Get root store for a database
 * @param options
 * @returns
 */
export function database({ database: databaseName, table: tableName }) {
	if (!databaseName) databaseName = DEFAULT_DATABASE_NAME;
	getDatabases();
	ensureDB(databaseName);
	const definedDatabase = definedDatabases.get(databaseName);
	if ((definedDatabase as any)?.rootStore) {
		return (definedDatabase as any).rootStore;
	}
	const databaseConfig = envGet(CONFIG_PARAMS.DATABASES) || {};
	if (process.env.SCHEMAS_DATA_PATH) {
		databaseConfig.data = { path: process.env.SCHEMAS_DATA_PATH };
	}
	const tablePath = tableName && databaseConfig[databaseName]?.tables?.[tableName]?.path;
	const databasePath = resolveDatabaseStorageRoot(databaseName, tableName);

	let rootStore: RootDatabaseKind;
	const useRocksdb = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb';
	if (useRocksdb) {
		const path = join(databasePath, tablePath ? tableName : databaseName);
		// the scan is not the only way to reach a branch's directory: a branch leaves its store in
		// `rocksdbDatabaseEnvs`, so without this an on-demand open would staple it onto
		// `definedDatabases` and the next `closeDatabase` would close it under the live handle
		if (isOpenBranchPath(path)) {
			const error: any = new Error(`Database '${databaseName}' is open as a scope-private branch`);
			error.statusCode = 409;
			throw error;
		}
		rootStore = rocksdbDatabaseEnvs.get(path);
		if (!rootStore || rootStore.status === 'closed') {
			// this on-demand open (create_table/create_database and friends) must not resurrect a
			// database that a restore is rewriting (or left half-purged) — the scan-time restore
			// checks don't cover this path
			throwIfBlockedByRestore(path, databaseName);
			rootStore = openRocksDatabase(path, {
				disableWAL: false,
				enableStats: true,
			}) as any;
			rocksdbDatabaseEnvs.set(path, rootStore as any);
		}
	} else {
		const path = join(databasePath, `${tablePath ? tableName : databaseName}.mdb`);
		rootStore = lmdbDatabaseEnvs.get(path);
		if (!rootStore || rootStore.status === 'closed') {
			// TODO: validate database name
			const envInit = new OpenEnvironmentObject(path, isReadOnlyMode());
			rootStore = open(envInit) as any;
			lmdbDatabaseEnvs.set(path, rootStore as any);
		}
	}
	if (!rootStore.auditStore) {
		rootStore.auditStore = openAuditStore(rootStore as any);
	}
	if (definedDatabase) (definedDatabase as any).rootStore = rootStore;
	return rootStore;
}
function throwIfBlockedByRestore(dbPath: string, databaseName: string): void {
	const restoreState = checkRestoreState(dbPath);
	if (restoreState !== 'clear') {
		const error: any = new Error(
			restoreState === 'in-progress'
				? `Database '${databaseName}' is being restored; retry when the restore completes`
				: `Database '${databaseName}' has an incomplete restore; rerun restore_backup to recover it`
		);
		error.statusCode = 409;
		throw error;
	}
}

/**
 * Take the per-database restore lock for a drop, refusing (409) if a restore holds it (in-progress)
 * or a crashed restore left a marker (incomplete). Pushes the acquired lock onto `held` so the
 * caller releases it after the drop. On refusal, releases anything already held and throws.
 *
 * The lock is not reentrant within a process, so a path already in `held` must be skipped — every
 * table in a RocksDB database shares one root store (and one lock path), and re-acquiring it in the
 * same drop would spuriously 409 on the second table.
 */
function lockDatabaseForDrop(dbPath: string, databaseName: string, held: RestoreLock[]): void {
	if (held.some((h) => h.dbPath === dbPath)) return;
	let lock: RestoreLock;
	try {
		lock = acquireRestoreLock(dbPath);
	} catch (error) {
		for (const h of held) releaseRestoreLock(h);
		throw error; // 409: a restore is in progress and holds the lock
	}
	// We now hold the lock, so no restore is active. A surviving marker is therefore debris from a
	// crashed restore (incomplete) — refuse rather than delete a directory that still needs recovery.
	if (restoreMarkerPresent(dbPath)) {
		releaseRestoreLock(lock);
		for (const h of held) releaseRestoreLock(h);
		const error: any = new Error(
			`Database '${databaseName}' has an incomplete restore; rerun restore_backup to recover it`
		);
		error.statusCode = 409;
		throw error;
	}
	held.push(lock);
}

/**
 * Delete the database
 * @param databaseName
 */
export async function dropDatabase(databaseName) {
	if (!databases[databaseName]) throw new Error('Database does not exist');
	const dbTables = databases[databaseName];
	let rootStore;

	// Hold the per-database restore lock across the entire drop so its file deletion can never
	// interleave with a restore's purge-and-copy on the same directory — a destroy landing after a
	// restore's copy would gut a "successful" restore, and vice versa. Restore takes the same lock
	// (before writing its marker), so both operations serialize on this one primitive rather than on
	// a check-then-act marker probe. Released in the finally below.
	const restoreLocks: RestoreLock[] = [];
	try {
		for (const tableName in dbTables) {
			const table = dbTables[tableName];
			rootStore = table.primaryStore.rootStore;
			if (rootStore instanceof RocksDatabase) lockDatabaseForDrop(rootStore.path, databaseName, restoreLocks);
			lmdbDatabaseEnvs.delete(rootStore.path);
			rocksdbDatabaseEnvs.delete(rootStore.path);
		}

		for (const tableName in dbTables) {
			databaseEventsEmitter.emit('dropTable', tableName, databaseName);
		}

		if (databaseName === 'data') {
			for (const tableName in tables) {
				delete tables[tableName];
			}
			delete tables[DEFINED_TABLES];
		}
		delete databases[databaseName];

		databaseEventsEmitter.emit('dropDatabase', databaseName);

		if (rootStore) {
			if (rootStore.status === 'open') {
				if (rootStore instanceof RocksDatabase) {
					rootStore.close();
					rootStore.destroy();
				} else {
					await rootStore.close();
					await unlink(rootStore.path);
				}
			}
		} else {
			rootStore = database({ database: databaseName, table: null });
			// a tableless database resolves its root store here rather than in the loop above, so take
			// the drop lock now (still before any destructive step)
			if (rootStore instanceof RocksDatabase) lockDatabaseForDrop(rootStore.path, databaseName, restoreLocks);
			if (rootStore instanceof RocksDatabase) {
				rootStore.close();
				rootStore.destroy();
			} else if (rootStore.status === 'open') {
				await rootStore.close();
				await unlink(rootStore.path);
			}
		}

		await deleteRootBlobPathsForDB(rootStore);
	} finally {
		for (const lock of restoreLocks) releaseRestoreLock(lock);
	}
}

/**
 * Close a RocksDB database's store handles on the current thread and unregister it, without
 * touching its files. Used by the restore_backup flow: every thread must release its handles so
 * `backups.restore()` can purge and rewrite the (fully closed) database directory. A subsequent
 * `resetDatabases()`/`getDatabases()` rescan reloads it (or skips it while a restore is in
 * progress, per the restore marker checks in the scan).
 */
export function closeDatabase(databaseName: string): boolean {
	const dbTables = databases[databaseName];
	if (!dbTables) return false;
	const rootStores = new Set<any>();
	const closeStore = (store: any, description: string) => {
		try {
			store?.close?.();
		} catch (error) {
			logger.warn(`Error closing ${description} while closing database ${databaseName}:`, error);
		}
	};
	for (const tableName in dbTables) {
		const table: any = dbTables[tableName];
		if (!table?.primaryStore) continue;
		if (table.primaryStore.rootStore) rootStores.add(table.primaryStore.rootStore);
		for (const indexName in table.indices || {}) {
			closeStore(table.indices[indexName], `index ${tableName}.${indexName}`);
		}
		closeStore(table.primaryStore, `table ${tableName}`);
	}
	// a database with no tables (an empty schema, or one whose tables were all dropped) still holds
	// an open root store, tracked only on the defined-database entry rather than any table — include
	// it so its handles are released too (the Set dedupes it against the per-table root stores above)
	const definedRoot = (definedDatabases?.get(databaseName) as any)?.rootStore;
	if (definedRoot) rootStores.add(definedRoot);
	for (const rootStore of rootStores) {
		closeStore(rootStore.dbisDb, 'attributes store');
		closeStore(rootStore, 'root store');
		lmdbDatabaseEnvs.delete(rootStore.path);
		rocksdbDatabaseEnvs.delete(rootStore.path);
	}
	const definedDatabase = definedDatabases?.get(databaseName);
	if (definedDatabase) (definedDatabase as any).rootStore = undefined;
	if (databaseName === 'data') {
		for (const tableName in tables) {
			delete tables[tableName];
		}
		delete tables[DEFINED_TABLES];
	}
	delete databases[databaseName];
	return true;
}

/**
 * Close every RocksDB (user) database this thread has open, releasing its native handles.
 *
 * rocksdb-js's registry is process-global across worker threads, and a thread that exits WITHOUT
 * closing leaks its handles (the process-global refCount never drops), while the only alternative,
 * `shutdown()`, tears down rocksdb for the entire process. So a worker thread that opens databases
 * and then exits — notably a job worker (jobProcess), which opens the whole database graph via
 * `getDatabases()` and exits when the job finishes — must close its handles explicitly, or those
 * handles linger process-wide (and, e.g., block an online `restore_backup` from confirming the
 * database is closed). The `system` database is intentionally left open: it is non-enumerable here
 * (skipped by the loop), is never restored online, and the exiting worker may still touch the job
 * table during teardown. Best-effort: closing failures are swallowed inside `closeDatabase`.
 *
 * Branches are invisible to the loop below but hold handles from the same registry, so this — the
 * thread's one teardown entry point — closes them too.
 */
export function closeLoadedDatabases(): void {
	closeBranchDatabases();
	// snapshot the names first: closeDatabase() deletes from `databases` as it goes
	for (const databaseName of Object.keys(databases)) {
		const dbTables = databases[databaseName];
		if (!dbTables) continue;
		let isRocks = false;
		for (const tableName in dbTables) {
			if (dbTables[tableName]?.primaryStore?.rootStore instanceof RocksDatabase) {
				isRocks = true;
				break;
			}
		}
		// a tableless database exposes no table root store, so also check the defined-database
		// entry — otherwise its open root store would leak on worker exit
		if (!isRocks && (definedDatabases?.get(databaseName) as any)?.rootStore instanceof RocksDatabase) {
			isRocks = true;
		}
		if (isRocks) closeDatabase(databaseName);
	}
}
// HNSW_NO_AUTOVERSION kill-switch: when set, a NEW index initializes as legacy rather than
// versioned. process.env values are strings, so a bare truthiness check would treat "0"/"false"
// as enabling the switch — the opposite of intent. Treat "" / "0" / "false" (and unset) as NOT set.
function hnswAutoVersionDisabled(): boolean {
	const value = process.env.HNSW_NO_AUTOVERSION;
	return value != null && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Resolve the storage format of a custom-index object store (e.g. HNSW): `'versioned'` (each node
 * value is prefixed with a monotonic version the RocksDB Verification Table can extract → cached,
 * decode-free graph traversal) or `'legacy'` (un-versioned, un-cached).
 *
 * The format is decided ONCE — when the index is created — and persisted on the attribute
 * descriptor (`indexFormat`), so every worker and every reload reads the same authoritative value
 * rather than re-deriving it from the store's current contents. Re-deriving per-open is racy: a
 * store that is non-empty mid-backfill would be mis-read as legacy, and opening a versioned store
 * with the legacy decoder corrupts reads. table() persists the resolved value (and always persists
 * it BEFORE the first node is written, so by the time a store is non-empty its format is on disk).
 *
 * The empty-guard below is only the INITIALIZER for the first open under this feature (no format
 * persisted yet): an empty store will be written versioned; a pre-existing non-empty store holds
 * legacy un-prefixed values (incl. small-int id mappings the versioned decoder would misread) and
 * stays legacy until an explicit reindex rebuilds it. The HNSW_NO_AUTOVERSION kill-switch only
 * blocks a NEW index from initializing as versioned — an already-versioned store is still resolved
 * versioned so its reads stay correct. The resolved value is stamped back onto `attribute` so the
 * caller's attributesDbi.put persists it.
 */
function resolveIndexFormat(
	dbiKey: string,
	rootStore: RootDatabaseKind,
	dbi: any,
	attribute: any
): 'versioned' | 'legacy' {
	const persisted = (rootStore as any).dbisDb?.getSync(dbiKey)?.indexFormat;
	let format: 'versioned' | 'legacy' = persisted ?? attribute.indexFormat;
	if (format == null) {
		format = 'legacy';
		let isEmpty = true;
		// Probe with no start/end so any key type is counted — numeric, string-pk
		// safeKeys, and Symbol/array keys (e.g. entryPoint, KEY_PREFIX) are all
		// included. The old { start: 0, end: Infinity } range missed symbol-array and
		// string keys, misclassifying non-empty stores as empty after a delete-all.
		for (const _key of dbi.getKeys({ limit: 1 })) {
			isEmpty = false;
			break;
		}
		if (isEmpty && !hnswAutoVersionDisabled()) format = 'versioned';
	}
	attribute.indexFormat = format;
	return format;
}

// Arm a custom-index object store for versioned (VT-cacheable) reads and writes: enable the
// metadata-prefix encode/decode (isRocksDB) and self-versioning (autoVersion) on its encoder.
// Idempotent — safe to call again on a re-opened or reindexed store.
function armVersionedIndexEncoder(dbi: any, rootStore: any) {
	if (dbi.encoder?.autoVersion) return;
	handleLocalTimeForGets(dbi, rootStore);
	if (dbi.encoder) dbi.encoder.autoVersion = true;
}

// opens an index, consulting with custom indexes that may use alternate store configuration
function openIndex(dbiKey: string, rootStore: RootDatabaseKind, attribute: any) {
	const objectStorage =
		attribute.isPrimaryKey || (attribute.indexed.type && CUSTOM_INDEXES[attribute.indexed.type]?.useObjectStore);
	const dbiInit = createOpenDBIObject(!objectStorage, objectStorage);
	// Custom-index object stores (e.g. HNSW vector graphs) hold fixed-shape internal nodes —
	// numeric-keyed per-level connection arrays and quantized bins — that rely on random-access
	// struct encoding. Keep them in struct mode regardless of the table's storage.randomAccessFields
	// setting: their node shapes are controlled, so the wide/variably-typed OOM + divergence risks
	// that motivate the table-level default-off don't apply, and disabling structs corrupts the graph.
	if (attribute.indexed?.type && CUSTOM_INDEXES[attribute.indexed.type]?.useObjectStore) {
		dbiInit.randomAccessStructure = true;
	}
	let dbi:
		| LMDBDatabase
		| (RocksDatabase & {
				customIndex?: any;
				isIndexing?: boolean;
				indexNulls?: boolean;
				rootStore?: RocksRootDatabase;
		  });
	const isCustomObjectIndex = !!(attribute.indexed?.type && CUSTOM_INDEXES[attribute.indexed.type]?.useObjectStore);
	if (rootStore instanceof RocksDatabase) {
		// Enable cache (WeakLRUCache + VT) for all custom-object index stores so the VT is
		// available before resolveIndexFormat decides the format. Versioned stores need the VT
		// for cached traversal; legacy stores pay a small per-write cache.delete() overhead only.
		dbi = openRocksDatabase(rootStore.path, {
			...dbiInit,
			name: dbiKey,
			cache: isCustomObjectIndex,
		} as any) as any;
		(dbi as any).rootStore = rootStore;
		// Custom-index object stores (e.g. HNSW) write graph nodes via plain put() with no staged
		// transaction timestamp, so their values carry no version and the PrimaryRocksDatabase
		// Verification-Table cache can't track them. A versioned index initialises its encoder as a
		// versioned RocksDB store (isRocksDB → metadata-prefix encode/decode) and marks it
		// self-versioning, so each node gets a monotonic version the VT can extract — enabling cached,
		// decode-free graph traversal. The format is resolved from the persisted attribute descriptor
		// (decided once at create — see resolveIndexFormat) so every worker and reload agree on it.
		if (isCustomObjectIndex && resolveIndexFormat(dbiKey, rootStore, dbi, attribute) === 'versioned') {
			armVersionedIndexEncoder(dbi, rootStore);
		}
	} else {
		dbi = (rootStore as any).openDB(dbiKey, dbiInit as any);
	}
	if (attribute.indexed.type) {
		const CustomIndex = CUSTOM_INDEXES[attribute.indexed.type];
		if (CustomIndex) {
			dbi.customIndex = new CustomIndex(dbi, attribute.indexed);
		} else {
			logger.error(`The indexing type '${attribute.indexed.type}' is unknown`);
		}
	}
	return dbi;
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
export function table<TableResourceType>(tableDefinition: TableDefinition): TableResourceType {
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
		randomAccessFields,
		trackDeletes,
		schemaDefined,
		schemaRelationshipsDefined,
		origin,
		description,
		properties,
		hidden,
		cacheControl,
	} = tableDefinition;
	if (!databaseName) databaseName = DEFAULT_DATABASE_NAME;
	// Reject reserved names here too, not only at the operations API: a database
	// is also created by schema authoring — a `schema.graphql` `@table(database:)`
	// or a programmatic `table()` call — which bypasses the create_schema
	// validation. A reserved name collides with a role permission flag (harper#1016).
	// Deliberately on this authoring path only, NOT in `database()`/`makeTable`: those
	// are also the load and drop paths, so a reserved-name database created before this
	// fix still loads (data stays accessible) and can be dropped to remediate.
	if ((RESERVED_DATABASE_NAMES as readonly string[]).includes(databaseName)) {
		throw new ClientError(`'${databaseName}' is a reserved name and cannot be used as a database name`);
	}
	// A branch resolves its blob root from its store identity, so a database created under that same
	// name would share the root: two allocators minting the same file paths and truncating each other,
	// and the branch's teardown removing the database's blobs.
	if (isBranchIdentity(databaseName)) {
		throw new ClientError(`'${databaseName}' is in use as a branch store identity and cannot be a database name`);
	}
	const rootStore = database({ database: databaseName, table: tableName });
	const tables = databases[databaseName];
	logger.trace(`Defining ${tableName} in ${databaseName}`);
	let Table = tables?.[tableName];
	if (rootStore.status === 'closed') {
		throw new Error(`Can not use a closed data store for ${tableName}`);
	}
	let primaryKey;
	let primaryKeyAttribute;
	let attributesDbi;
	// Track whether the caller explicitly supplied schemaDefined; callers that omit it (cluster
	// schema-replication in Table.ts, dataLoader.ts) are operating on already-live tables whose
	// flag must be left as-is. Only an explicit value can re-assert on the existing-Table branch.
	const schemaDefinedExplicit = tableDefinition.schemaDefined !== undefined;
	if (schemaDefined == undefined) schemaDefined = true;
	const relationshipDefinitions = schemaRelationshipsDefined ? normalizeRelationships(attributes) : undefined;
	const internalDbiInit = createOpenDBIObject(false);

	for (const attribute of attributes) {
		if (attribute.attribute && !attribute.name) {
			// there is some legacy code that calls the attribute's name the attribute's attribute
			attribute.name = attribute.attribute;
			attribute.indexed = true;
		} else attribute.attribute = attribute.name;
		if (attribute.expiresAt) attribute.indexed = true;
	}
	let hasChanges;
	let refreshRelationshipAttributes = false;
	let releaseExclusiveLock: (() => void) | undefined;
	const attributesToIndex = [];
	const indicesToRemove = [];
	try {
		if (Table) {
			primaryKey = Table.primaryKey;
			if (Table.primaryStore.rootStore.status === 'closed') {
				throw new Error(`Can not use a closed data store from ${tableName} class`);
			}
			// Reject moving the primary key to a different attribute on a table that already has records.
			// The storage key (Table.primaryKey) is never re-pointed here, so honoring the change would
			// leave describe reporting the new attribute while every record — old and newly inserted — stays
			// keyed by the original one; search_by_id/update/delete by the declared key then all miss. Only
			// schema-authored callers (@table / defineTable / create_table) reassert the declaration, so
			// gate on schemaDefinedExplicit to leave cluster schema-replication / data-loader callers alone.
			// See HarperFast/studio#1199.
			const declaredPrimaryKey = attributes.find((attribute) => attribute.isPrimaryKey)?.name;
			if (schemaDefinedExplicit && declaredPrimaryKey && declaredPrimaryKey !== Table.primaryKey) {
				let hasRecords = false;
				for (const _entry of Table.primaryStore.getRange({ start: true })) {
					hasRecords = true;
					break;
				}
				if (hasRecords) {
					throw new ClientError(
						`Cannot change the primary key of table '${databaseName}.${tableName}' from '${Table.primaryKey}' to ` +
							`'${declaredPrimaryKey}' because it already contains records. Recreate the table with the new primary ` +
							`key, or migrate the existing records.`,
						400
					);
				}
			}
			// Acquire before the first mutation of the live Table below, so a lost race leaves no
			// attributes this worker describes but never persisted. Only the RocksDB acquire is bounded
			// and can throw, and only it is cheap when uncontended: LMDB's exclusiveLock() opens an
			// environment-wide write transaction that cannot time out, so it stays lazy.
			if (rootStore instanceof RocksDatabase) exclusiveLock();
			// it table already exists, get the split segments setting
			if (splitSegments == undefined) splitSegments = Table.splitSegments;
			if (origin === 'cluster') {
				const merged = Table.attributes.slice();
				for (const attribute of attributes) {
					const existing = merged.find((existingAttribute) => existingAttribute.name === attribute.name);
					if (!existing) {
						merged.push(attribute);
						continue;
					}
					// Nodes that apply the same peer definitions in a different order keep different index sets, and
					// this warn is the only signal of it. An absent field and an explicit falsy one declare the same
					// thing, so neither direction of that pair is a difference.
					const discarded = PEER_DECLARABLE_FIELDS.filter(
						(field) =>
							(attribute[field] || existing[field]) &&
							JSON.stringify(attribute[field]) !== JSON.stringify(existing[field])
					);
					if (discarded.length > 0)
						logger.warn(
							`Ignoring peer redefinition of ${databaseName}.${tableName}.${attribute.name} (${discarded
								.map(
									(field) =>
										`${field}: local ${JSON.stringify(existing[field])}, peer ${JSON.stringify(attribute[field])}`
								)
								.join('; ')}); the local schema is authoritative`
						);
				}
				attributes = merged;
			}
			Table.attributes.splice(0, Table.attributes.length, ...attributes);
			// Re-assert from the live declaration so a stale value on disk (replicated event,
			// v4-era backfill) is corrected on every reload. Gated on `schemaDefinedExplicit` so
			// callers that omit the flag (cluster schema-replication, data loader) don't flip a
			// dynamic table to true via the default at the top of table(), and on origin so a
			// peer-derived definition never overrides the local declaration.
			if (schemaDefinedExplicit && origin !== 'cluster') Table.schemaDefined = schemaDefined;
			// Refresh class-level schema metadata to track docstring/directive changes across reloads.
			Table.description = description;
			Table.properties = properties;
			Table.hidden = hidden;
			// undefined means a non-schema caller (add_attribute, cluster schema events) — don't clobber
			if (cacheControl !== undefined) Table.cacheControl = cacheControl;
		} else {
			const auditStore = rootStore.auditStore;
			primaryKeyAttribute = attributes.find((attribute) => attribute.isPrimaryKey) || {};
			primaryKey = primaryKeyAttribute.name;
			primaryKeyAttribute.isPrimaryKey = true;
			primaryKeyAttribute.is_hash_attribute = true; // backward-compat: harperdb@4.x reads this field to open the DBI with correct flags
			primaryKeyAttribute.schemaDefined = schemaDefined;
			// Old readers treat every attribute row as live schema, so relationships stay on the ignored primary descriptor.
			if (relationshipDefinitions) primaryKeyAttribute.relationships = relationshipDefinitions;
			// can't change compression after the fact (except threshold), so save only when we create the table
			primaryKeyAttribute.compression = getDefaultCompression();
			if (trackDeletes) primaryKeyAttribute.trackDeletes = true;
			audit = primaryKeyAttribute.audit = typeof audit === 'boolean' ? audit : envGet(CONFIG_PARAMS.LOGGING_AUDITLOG);
			if (expiration) primaryKeyAttribute.expiration = expiration;
			if (eviction) primaryKeyAttribute.eviction = eviction;
			// persist cacheControl so all threads (and future boots) see it; undefined callers inherit
			// a descriptor value carried by cluster schema events; null (schema has no directive)
			// clears a stale value the carried descriptor may hold
			if (cacheControl === undefined) cacheControl = primaryKeyAttribute.cacheControl;
			else if (cacheControl === null) delete primaryKeyAttribute.cacheControl;
			else primaryKeyAttribute.cacheControl = cacheControl;
			splitSegments ??= false;
			primaryKeyAttribute.splitSegments = splitSegments; // always default to not splitting segments going forward
			if (typeof sealed === 'boolean') primaryKeyAttribute.sealed = sealed;
			if (typeof replicate === 'boolean') primaryKeyAttribute.replicate = replicate;
			// An explicit directive PINS this table's encoding: we persist the boolean, so later changes
			// to the global storage.randomAccessFields default never affect this table. Tables WITHOUT the
			// directive are intentionally not persisted here — they follow the current global default on
			// each open (a runtime lever to flip encoding fleet-wide). Switching either way is safe: the
			// struct READ hook always stays on and struct (0x20-0x3f) vs classic-record (0x40-0x7f) bytes
			// are disjoint, so already-written records still decode; only the encoding of NEW writes changes.
			if (typeof randomAccessFields === 'boolean') primaryKeyAttribute.randomAccessFields = randomAccessFields;
			if (origin) {
				if (!primaryKeyAttribute.origins) primaryKeyAttribute.origins = [origin];
				else if (!primaryKeyAttribute.origins.includes(origin)) primaryKeyAttribute.origins.push(origin);
			}
			logger.trace(`${tableName} table loading, opening primary store`);
			const dbiInit = createOpenDBIObject(false, true);
			dbiInit.compression = primaryKeyAttribute.compression;
			// per-table override of the storage.randomAccessFields default (see OpenDBIObject)
			if (typeof primaryKeyAttribute.randomAccessFields === 'boolean')
				dbiInit.randomAccessStructure = primaryKeyAttribute.randomAccessFields;
			const dbiName = tableName + '/';

			if (rootStore instanceof RocksDatabase) {
				attributesDbi = (rootStore as any).dbisDb = openRocksDatabase(rootStore.path, {
					...internalDbiInit,
					disableWAL: false,
					name: INTERNAL_DBIS_NAME,
				} as any);
			} else {
				attributesDbi = (rootStore as any).dbisDb = (rootStore as any).openDB(
					INTERNAL_DBIS_NAME,
					internalDbiInit as any
				);
			}
			markInternalDbiNonVersioned(attributesDbi);

			exclusiveLock(); // get an exclusive lock on the database so we can verify that we are the only thread creating the table (and assigning the table id)
			const existingTableMeta = (attributesDbi as any).getSync(dbiName);
			if (existingTableMeta && !existingTableMeta.dropping) {
				// table was created while we were setting up; the lock is not reentrant, so release
				// before the recursive reload
				releaseLock();
				resetDatabases();
				return table(tableDefinition);
			}

			let primaryStore;
			if (existingTableMeta?.dropping) {
				// A previous drop of this table was interrupted after its tombstone
				// was written. Complete it now (under the exclusive lock) so the
				// create below starts from a clean slate; treating the tombstoned
				// entry as an existing table would recurse forever on the stale
				// catalog row.
				completeInterruptedDrop(rootStore, attributesDbi, databaseName, tableName);
				// This resolves the drop without ever going through the schema-load
				// reconcile below, which is the only other place that returns a spent
				// budget. Without clearing it here too, a table that gets dropped again
				// before any reconcile observes it live in between would have its NEXT
				// interrupted drop inherit this one's spent attempts. Generation-scoped
				// keying (see interruptedDropAttempts) already makes that impossible, but
				// clearing it here too avoids leaving a dead entry behind - for every
				// generation this table has ever spent, not just the one on this row.
				clearInterruptedDropEntries(rootStore.path, tableName);
			}
			if (rootStore instanceof RocksDatabase) {
				// Usually a genuinely new column family (existingTableMeta above found no catalog
				// entry), but an interrupted drop just completed above can leave the physical CF
				// behind under its old codec even though the catalog entry is gone — same fallback
				// as the reconcile paths covers that remnant case too.
				primaryStore = openRocksDatabase(rootStore.path, { ...dbiInit, name: dbiName, cache: true } as any);
			} else {
				primaryStore = (rootStore as any).openDB(dbiName, dbiInit as any);
			}
			primaryStore = handleLocalTimeForGets(primaryStore, rootStore);
			rootStore.databaseName = databaseName;
			primaryStore.tableId = attributesDbi.getSync(NEXT_TABLE_ID);
			logger.trace(`Assigning new table id ${primaryStore.tableId} for ${tableName}`);
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
					description,
					properties,
					hidden,
					cacheControl,
				})
			);
			Table.schemaVersion = 1;
			hasChanges = true;

			attributesDbi.put(dbiName, primaryKeyAttribute);
		}
		const indices = Table.indices;
		if (!attributesDbi) {
			if (rootStore instanceof RocksDatabase) {
				(rootStore as any).dbisDb = openRocksDatabase(rootStore.path, {
					...internalDbiInit,
					disableWAL: false,
					name: INTERNAL_DBIS_NAME,
				} as any);
			} else {
				(rootStore as any).dbisDb = (rootStore as any).openDB(INTERNAL_DBIS_NAME, internalDbiInit as any);
			}
			attributesDbi = markInternalDbiNonVersioned((rootStore as any).dbisDb);
		}
		Table.dbisDB = attributesDbi;
		// A cluster-origin list can miss a descriptor another thread committed moments ago, so removal
		// reconciliation is reserved for local schema authoring.
		const reconcileRemovals = origin !== 'cluster';
		for (const { key, value } of reconcileRemovals ? attributesDbi.getRange({ start: true }) : []) {
			if (value == null) continue;
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
				exclusiveLock();
				hasChanges = true;
				if (!attribute) attributesDbi.remove(key);
				if (removeIndex) {
					const indexDbi = Table.indices[attributeTableName];
					if (indexDbi) indicesToRemove.push(indexDbi);
				}
			}
		}
		// TODO: If we have attributes and the schemaDefined flag is not set, turn it on
		// iterate through the attributes to ensure that we have all the dbis created and indexed
		for (const attribute of attributes || []) {
			if (attribute.relationship) {
				refreshRelationshipAttributes = true;
				continue;
			}
			if (attribute.computed) hasChanges = true;
			let dbiKey = tableName + '/' + (attribute.name || '');
			Object.defineProperty(attribute, 'key', { value: dbiKey, configurable: true });
			let attributeDescriptor = attributesDbi.getSync(dbiKey);
			if (attribute.isPrimaryKey) {
				attributeDescriptor = attributeDescriptor || attributesDbi.getSync((dbiKey = tableName + '/')) || {};
				// Persist schemaDefined when the explicit live value disagrees with disk. Without this,
				// a stale `false` (from a v4-era write or replicated event) survives every reload: the
				// in-memory re-assert in the existing-Table branch only fixes the worker that ran @table,
				// but other workers' next disk-load re-reads the stale value. The whole settings update is
				// gated off for cluster-origin callers: their values come from this worker's (possibly
				// stale) snapshot, so a rewrite could revert a newer local declaration already on disk.
				const schemaDefinedMismatch = schemaDefinedExplicit && attributeDescriptor.schemaDefined !== schemaDefined;
				// primary key can't change indexing, but settings can change
				if (
					origin !== 'cluster' &&
					(schemaDefinedMismatch ||
						(audit !== undefined && audit !== Table.audit) ||
						(sealed !== undefined && sealed !== Table.sealed) ||
						(replicate !== undefined && replicate !== Table.replicate) ||
						(+expiration || undefined) !== (+attributeDescriptor.expiration || undefined) ||
						(+eviction || undefined) !== (+attributeDescriptor.eviction || undefined) ||
						attribute.type !== attributeDescriptor.type)
				) {
					exclusiveLock();
					const currentPrimaryAttribute = attributesDbi.getSync(dbiKey);
					if (!currentPrimaryAttribute || tableIsDropping(currentPrimaryAttribute, dbiKey)) continue;
					const updatedPrimaryAttribute = { ...currentPrimaryAttribute };
					if (typeof audit === 'boolean') {
						if (audit) Table.enableAuditing();
						updatedPrimaryAttribute.audit = audit;
					}
					if (expiration) updatedPrimaryAttribute.expiration = +expiration;
					if (eviction) updatedPrimaryAttribute.eviction = +eviction;
					if (sealed !== undefined) updatedPrimaryAttribute.sealed = sealed;
					if (replicate !== undefined) updatedPrimaryAttribute.replicate = replicate;
					if (attribute.type) updatedPrimaryAttribute.type = attribute.type;
					if (schemaDefinedMismatch) updatedPrimaryAttribute.schemaDefined = schemaDefined;
					hasChanges = true; // send out notification of the change
					attributesDbi.put(dbiKey, updatedPrimaryAttribute);
				}

				continue;
			}

			if (attributeDescriptor?.attribute && !attributeDescriptor.name) attributeDescriptor.indexed = true; // legacy descriptor

			if (origin === 'cluster' && attributeDescriptor) {
				// An existing descriptor is a local declaration this caller may not have seen yet, so it wins
				// over the incoming definition and is never written back from it.
				applyDurableDeclaration(attribute, attributeDescriptor);
				const abandonedIndexBuild =
					attribute.indexed &&
					(attributeDescriptor.indexingFailed ||
						(attributeDescriptor.indexingPID && attributeDescriptor.indexingPID !== process.pid) ||
						attributeDescriptor.restartNumber < (workerData?.restartNumber ?? manageThreads.restartNumber));
				if (abandonedIndexBuild) {
					// Recovery is the exception to skipping the handling below, because without it `isIndexing`
					// stays pinned on with nothing left to clear it and every query on the attribute fails with
					// IndexRebuildingError for the life of the worker. It persists the attribute (here and again
					// from runIndexing), so restate the declaration from a descriptor read under the lock.
					exclusiveLock();
					applyDurableDeclaration(attribute, attributesDbi.getSync(dbiKey) ?? attributeDescriptor);
				} else {
					if (attribute.indexed) {
						const dbi = openIndex(dbiKey, rootStore, attribute);
						// Persisting the indexFormat openIndex just resolved adds a field the descriptor lacks
						// rather than rewriting one it has. Without it an empty index resolves 'versioned', writes
						// versioned nodes, then re-derives 'legacy' on the next load — see indexFormatNeedsPersist.
						if (attribute.indexFormat != null && attributeDescriptor.indexFormat == null) {
							exclusiveLock();
							const durableDescriptor = attributesDbi.getSync(dbiKey);
							if (durableDescriptor && durableDescriptor.indexFormat == null) {
								hasChanges = true;
								attributesDbi.put(dbiKey, { ...durableDescriptor, indexFormat: attribute.indexFormat });
							}
						}
						if (attributeDescriptor.indexingPID) dbi.isIndexing = true;
						dbi.indexNulls = attribute.indexNulls;
						indices[attribute.name] = dbi;
					}
					continue;
				}
			}

			// note that non-indexed attributes do not need a dbi
			// Some index options affect only search, not the stored structure (e.g. HNSW's
			// efConstructionSearch). Changing those should persist the new metadata but NOT trigger a
			// reindex. A custom index declares such keys via a static `searchOnlyOptions`.
			const indexType = attribute.indexed && typeof attribute.indexed === 'object' ? attribute.indexed.type : undefined;
			const searchOnlyOptions: string[] = (indexType && CUSTOM_INDEXES[indexType]?.searchOnlyOptions) || [];
			const stripSearchOnly = (indexed: any): any => {
				if (!indexed || typeof indexed !== 'object' || searchOnlyOptions.length === 0) return indexed;
				const copy = { ...indexed };
				for (const key of searchOnlyOptions) delete copy[key];
				return copy;
			};
			// Canonical key for the structural (reindex-triggering) comparison only: strip search-only
			// options, then sort keys and coerce numeric-looking string scalars so a representation-only
			// difference (key order, string-vs-number) does not force a needless rebuild. harper#1357
			const canonicalIndexKey = (indexed: any) => JSON.stringify(canonicalizeIndexOptions(stripSearchOnly(indexed)));
			const commonChanged =
				!attributeDescriptor ||
				attributeDescriptor.type !== attribute.type ||
				attributeDescriptor.nullable !== attribute.nullable ||
				attributeDescriptor.version !== attribute.version ||
				attributeDescriptor.enumerable !== attribute.enumerable ||
				JSON.stringify(attributeDescriptor.properties) !== JSON.stringify(attribute.properties) ||
				JSON.stringify(attributeDescriptor.elements) !== JSON.stringify(attribute.elements) ||
				// Include `embed` so a source/model change refreshes the embed registry.
				JSON.stringify(attributeDescriptor.embed) !== JSON.stringify(attribute.embed);
			// any metadata difference (drives persistence)
			const changed =
				commonChanged || JSON.stringify(attributeDescriptor?.indexed) !== JSON.stringify(attribute.indexed);
			// structure-affecting difference (drives reindex) — ignores search-only option changes and
			// representation-only differences (key order, string-vs-number) via canonicalIndexKey
			const indexOptionsStructurallyChanged =
				canonicalIndexKey(attributeDescriptor?.indexed) !== canonicalIndexKey(attribute.indexed);
			const structurallyChanged = commonChanged || indexOptionsStructurallyChanged;
			if (attribute.indexed) {
				// The restart generation that owns any in-progress build of this index. Use the
				// worker's stable startup generation (workerData.restartNumber), NOT the mutable
				// manageThreads counter: during a worker's shutdown/drain the global counter has
				// already advanced to the replacement generation, so stamping that would make the
				// replacement worker see an equal generation (and a possibly-reused PID) and skip
				// crash-recovery, leaving the index stuck. Falls back to manageThreads.restartNumber
				// on the main thread, where workerData is undefined (and it is initialized to 1).
				const currentRestartGeneration = workerData?.restartNumber ?? manageThreads.restartNumber;
				const dbi = openIndex(dbiKey, rootStore, attribute);
				// openIndex resolves and stamps attribute.indexFormat for a versioned-capable (RocksDB
				// custom-object) index. An index created before this field existed has no indexFormat on
				// disk; persist the resolved value now — even when nothing else changed — so the format is
				// durable BEFORE any node is written. Otherwise an empty pre-existing index would resolve
				// 'versioned', write versioned nodes, and on the next load re-derive 'legacy' from the
				// now-non-empty store, opening versioned data with the legacy decoder (silent corruption).
				// (Scoped by attribute.indexFormat != null: only RocksDB custom-object indexes set it.)
				const indexFormatNeedsPersist =
					attribute.indexFormat != null && attributeDescriptor?.indexFormat !== attribute.indexFormat;
				if (
					changed ||
					indexFormatNeedsPersist ||
					attributeDescriptor?.indexingFailed ||
					(attributeDescriptor?.indexingPID && attributeDescriptor?.indexingPID !== process.pid) ||
					attributeDescriptor?.restartNumber < currentRestartGeneration
				) {
					hasChanges = true;
					exclusiveLock();
					attributeDescriptor = attributesDbi.getSync(dbiKey);
					if (
						structurallyChanged ||
						attributeDescriptor?.indexingFailed ||
						(attributeDescriptor?.indexingPID && attributeDescriptor?.indexingPID !== process.pid) ||
						attributeDescriptor?.restartNumber < currentRestartGeneration
					) {
						hasChanges = true;
						if (attribute.indexNulls === undefined) attribute.indexNulls = true;
						let hasExistingData = false;
						for (let _entry of Table.primaryStore.getRange({ start: true })) {
							hasExistingData = true;
							break;
						}
						if (hasExistingData) {
							// When the index definition itself has structurally changed (different distance
							// metric, M, quantization, etc.), any
							// previous lastIndexedKey checkpoint is for a graph built under the old options —
							// resuming from it would mix two incompatible graphs. Reset to undefined so
							// runIndexing clears the dbi and starts from scratch.
							// For pure crash-recovery (same options, different PID/restartNumber) — including a
							// representation-only option difference — preserve the checkpoint so the backfill
							// resumes rather than restarts. Canonicalized to match structurallyChanged above.
							const indexOptionsChanged =
								canonicalIndexKey(attributeDescriptor?.indexed) !== canonicalIndexKey(attribute.indexed);
							attribute.lastIndexedKey = indexOptionsChanged
								? undefined
								: (attributeDescriptor?.lastIndexedKey ?? undefined);
							// Explicit reindex is the upgrade path from a legacy (un-versioned) custom-index
							// object store to the versioned, VT-cacheable format. A full rebuild from scratch
							// (lastIndexedKey === undefined) clears the store and rewrites every node, so the
							// new nodes can carry versions: flip the persisted format and re-arm the dbi encoder
							// (openIndex armed it from the pre-rebuild format, which for a legacy index was
							// un-versioned). A crash-recovery resume (lastIndexedKey preserved) keeps the
							// existing format — its partial graph was already written under it.
							if (
								rootStore instanceof RocksDatabase &&
								indexType &&
								CUSTOM_INDEXES[indexType]?.useObjectStore &&
								!hnswAutoVersionDisabled() &&
								attribute.lastIndexedKey === undefined
							) {
								attribute.indexFormat = 'versioned';
								armVersionedIndexEncoder(dbi, rootStore);
							}
							attribute.indexingPID = process.pid;
							// Persist the owning restart generation (see currentRestartGeneration above) so
							// the trigger can re-detect an incomplete index after a worker restart even when
							// the new process reuses the old PID. Cleared on clean completion; left in place
							// on failure/crash so the next, higher-numbered restart re-triggers the backfill.
							attribute.restartNumber = currentRestartGeneration;
							delete attribute.indexingFailed; // clear failure flag for the new run
							dbi.isIndexing = true;
							Object.defineProperty(attribute, 'dbi', { value: dbi, configurable: true, enumerable: false });
							// Explainability: log which trigger fired so an unexpected rebuild is diagnosable. harper#1357
							const reindexReasons: string[] = [];
							if (commonChanged)
								reindexReasons.push(attributeDescriptor ? 'attribute-definition-changed' : 'new-index');
							if (attributeDescriptor && indexOptionsStructurallyChanged)
								reindexReasons.push('structural-options-changed');
							if (attributeDescriptor?.indexingFailed) reindexReasons.push('indexing-failed-retry');
							if (attributeDescriptor?.indexingPID && attributeDescriptor.indexingPID !== process.pid)
								reindexReasons.push(`crash-recovery(pid=${attributeDescriptor.indexingPID})`);
							if (attributeDescriptor?.restartNumber < currentRestartGeneration) reindexReasons.push('restart-number');
							logger.info(
								`reindex ${databaseName}.${tableName}.${attribute.name}: reason=${reindexReasons.join(',') || 'unknown'}`
							);
							// we only set indexing nulls to true if new or reindexing, we can't have partial indexing of null
							attributesToIndex.push(attribute);
						}
					} else if (attributeDescriptor.indexingPID) {
						// Metadata-only change (e.g. a search-only option like efConstructionSearch) while a
						// backfill is in progress: we did NOT re-trigger indexing, so carry over the in-progress
						// indexing state instead of persisting a descriptor that looks complete — otherwise other
						// workers / a reload would treat the still-partial index as ready and return incomplete results.
						attribute.indexingPID = attributeDescriptor.indexingPID;
						attribute.lastIndexedKey = attributeDescriptor.lastIndexedKey;
						// Carry the in-progress restart generation too, so persisting this metadata-only
						// change doesn't drop it and break the crash-recovery trigger for the running backfill.
						attribute.restartNumber = attributeDescriptor.restartNumber;
						if (attributeDescriptor.indexingFailed) attribute.indexingFailed = attributeDescriptor.indexingFailed;
					}
					attributesDbi.put(dbiKey, attribute);
				}
				// If a migration is in progress (indexingPID set), any newly opened dbi must also
				// reflect isIndexing = true. A resetDatabases() during an active runIndexing creates
				// a new dbi object; without this, queries could use the new dbi (isIndexing = false)
				// and return incomplete results while the backfill is still running.
				if (attributeDescriptor?.indexingPID) dbi.isIndexing = true;
				if (attributeDescriptor?.indexNulls && attribute.indexNulls === undefined) attribute.indexNulls = true;
				dbi.indexNulls = attribute.indexNulls;
				indices[attribute.name] = dbi;
			} else if (changed) {
				hasChanges = true;
				exclusiveLock();
				attributesDbi.put(dbiKey, attribute);
			}
		}
		// a table with no declared primary key has no attribute row to carry relationships, and the
		// loop above never visits its descriptor
		if (relationshipDefinitions) {
			const relationshipsKey = primaryDescriptorKey();
			if (!relationshipListsEqual(attributesDbi.getSync(relationshipsKey)?.relationships, relationshipDefinitions)) {
				exclusiveLock();
				const currentPrimaryAttribute = attributesDbi.getSync(relationshipsKey);
				// a missing row means a concurrent drop completed; writing one back would resurrect the table
				if (
					currentPrimaryAttribute &&
					!tableIsDropping(currentPrimaryAttribute, relationshipsKey) &&
					!relationshipListsEqual(currentPrimaryAttribute.relationships, relationshipDefinitions)
				) {
					attributesDbi.put(relationshipsKey, { ...currentPrimaryAttribute, relationships: relationshipDefinitions });
					hasChanges = true;
				}
			}
		}
	} finally {
		releaseLock();
	}
	if (hasChanges || refreshRelationshipAttributes) {
		Table.schemaVersion++;
		Table.updatedAttributes();
	}
	logger.trace(`${tableName} table loading, running index`);
	if (attributesToIndex.length > 0 || indicesToRemove.length > 0) {
		Table.indexingOperation = runIndexing(Table, attributesToIndex, indicesToRemove);
	} else if (hasChanges)
		signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'schema-change', Table.databaseName, Table.tableName)
		);

	Table.origin = origin;
	if (hasChanges || refreshRelationshipAttributes) {
		databaseEventsEmitter.emit('updateTable', Table, origin !== 'cluster');
	}
	if (expiration || eviction || scanInterval)
		Table.setTTLExpiration({
			expiration,
			eviction,
			scanInterval,
		});
	logger.trace(`${tableName} table loaded`);

	return Table as TableResourceType;
	// dropTable() tombstones the bare table row, which is not the row a legacy catalog keeps the
	// table's settings in, so a drop in flight has to be checked on both.
	function tableIsDropping(descriptor: any, descriptorKey: string) {
		if (descriptor?.dropping) return true;
		return descriptorKey !== tableName + '/' && attributesDbi.getSync(tableName + '/')?.dropping;
	}
	// The catalog row initStores() reads a table's settings from: the primary key's own row when it
	// has one, and the bare table row otherwise.
	function primaryDescriptorKey() {
		const declaredPrimaryKey = attributes?.find((attribute) => attribute.isPrimaryKey)?.name;
		if (declaredPrimaryKey) {
			const attributeKey = tableName + '/' + declaredPrimaryKey;
			if (attributesDbi.getSync(attributeKey)) return attributeKey;
		}
		return tableName + '/';
	}
	// Acquire an exclusive lock for attribute updates
	function exclusiveLock() {
		if (releaseExclusiveLock) return;
		if (rootStore instanceof RocksDatabase) {
			acquireUpdateAttributesLock(rootStore, `table '${databaseName}.${tableName}'`);
			releaseExclusiveLock = () => releaseUpdateAttributesLock(rootStore);
		} else {
			// we only need an exclusive transaction lock in lmdb
			rootStore.transactionSync(() => {
				return {
					then(callback) {
						releaseExclusiveLock = callback;
					},
				};
			});
		}
	}
	// idempotent: the early release before the recursive reload and the finally both run, and a
	// second unlock could release another thread's lock
	function releaseLock() {
		const release = releaseExclusiveLock;
		releaseExclusiveLock = undefined;
		if (release) release();
	}
}
/**
 * Canonical form used ONLY for the structural (reindex-triggering) comparison of index options.
 * `@indexed(...)` records options in source-argument order and as strings, while the operations API
 * and config objects can supply them reordered or as numbers; without canonicalizing, such a
 * representation-only difference flips the structural comparison and forces a needless full rebuild
 * (clearing + rebuilding the index, 503-ing the attribute throughout) for a semantically identical
 * index. Sorts object keys and coerces numeric-looking (non-zero) string scalars to numbers.
 * Conservative by design: boolean-vs-object, absent-vs-present, and string-"0"-vs-number-0
 * differences are all preserved, so a genuine change (`true` vs `{ type: 'HNSW' }`, an added/removed
 * option, a changed value) still triggers a rebuild. Persistence keys off the raw form, so the stored
 * descriptor self-heals toward this shape over time. harper#1357
 */
export function canonicalizeIndexOptions(value: any): any {
	if (Array.isArray(value)) return value.map(canonicalizeIndexOptions);
	if (value && typeof value === 'object') {
		const canonical: Record<string, any> = {};
		for (const key of Object.keys(value).sort()) canonical[key] = canonicalizeIndexOptions(value[key]);
		return canonical;
	}
	// Coerce numeric-looking strings ("16" -> 16) so string-vs-number representations of the same
	// option compare equal — EXCEPT zero: the string "0" is truthy while the number 0 is falsy, and
	// index code may branch on truthiness (e.g. HNSW `if (this.optimizeRouting)` doubles maxConnections),
	// so "0" and 0 build structurally different indexes and must still trigger a rebuild. Zero is the
	// only finite number whose string and numeric forms diverge in truthiness, so excluding it fully
	// closes that gap. Leave non-numeric strings, booleans, null, etc. intact.
	if (typeof value === 'string' && value.trim() !== '') {
		const numeric = Number(value);
		if (numeric !== 0 && Number.isFinite(numeric)) return numeric;
	}
	return value;
}
const MAX_OUTSTANDING_INDEXING = 1000;
const MIN_OUTSTANDING_INDEXING = 10;
async function runIndexing(Table, attributes, indicesToRemove) {
	try {
		logger.info(`Indexing ${Table.tableName} attributes`, attributes);
		await signalling.signalSchemaChange(
			new SchemaEventMsg(process.pid, 'schema-change', Table.databaseName, Table.tableName)
		);
		let lastResolution;
		for (const index of indicesToRemove) {
			lastResolution = index.drop();
		}
		let interrupted;
		let hadIndexingErrors = false;
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
					if (attribute.dbi.clearAsync) {
						// LMDB, note that we don't need to wait for this to complete, just gets enqueued in front of the other writes
						attribute.dbi.clearAsync();
					} else {
						await attribute.dbi.clear();
					}
				}
			}
			let outstanding = 0;
			// this means that a new attribute has been introduced that needs to be indexed
			for (const { key, value: record } of Table.primaryStore.getRange({
				start,
				lazy: attributesLength < 4,
				versions: true,
				snapshot: false, // don't hold a read transaction this whole time
			})) {
				if (!record) continue; // deletion entry
				// TODO: Do we ever need to interrupt due to a schema change that was not a restart?
				//if (Table.schemaVersion !== schemaVersion) return; // break out if there are any schema changes and let someone else pick it up
				outstanding++;
				// Custom indexes (e.g. HNSW) index synchronously and never raise `outstanding`, so the
				// outstanding-based yield below never fires for them. Track that this row did synchronous
				// indexing work so we can still yield the event loop after it.
				let didSynchronousIndexing = false;
				// every index operation needs to be guarded by the version still be the same. If it has already changed before
				// we index, that's fine because indexing is idempotent, we can just put the same values again. If it changes
				// during the indexing, the indexing here will fail. This is also fine because it means the other thread will have
				// performed indexing and we don't need to do anything further
				for (let i = 0; i < attributesLength; i++) {
					const attribute = attributes[i];
					const property = attribute.name;
					const index = attribute.dbi;
					try {
						const resolver = attribute.resolve;
						const value = record && (resolver ? resolver(record) : record[property]);
						if (index.customIndex) {
							index.customIndex.index(key, value);
							didSynchronousIndexing = true;
							continue;
						}
						const values = getIndexedValues(value, index.indexNulls);
						if (values) {
							for (let i = 0, l = values.length; i < l; i++) {
								lastResolution = index.put(values[i], key);
							}
						}
					} catch (error) {
						hadIndexingErrors = true;
						if (!attributeErrorReported[property]) {
							// just report an indexing error once per attribute so we don't spam the logs.
							// A store closed by worker shutdown surfaces here as "Database not open"; that is
							// a benign interruption (the next generation re-runs the backfill), so don't log
							// it as an error — the outer catch returns quietly once the iterator also throws.
							attributeErrorReported[property] = true;
							if (Table.primaryStore?.rootStore?.status === 'closed')
								logger.debug(`Indexing attribute ${property} interrupted by store shutdown`, error);
							else logger.error(`Error indexing attribute ${property}`, error);
						}
					}
				}
				when(
					lastResolution,
					() => outstanding--,
					(error) => {
						outstanding--;
						hadIndexingErrors = true;
						logger.error(error);
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
				else if (outstanding > MIN_OUTSTANDING_INDEXING)
					await new Promise((resolve) => setImmediate(resolve)); // yield event turn, don't want to use all computation
				else if (didSynchronousIndexing) await new Promise((resolve) => setImmediate(resolve)); // custom indexes (e.g. HNSW) index synchronously and never raise `outstanding`; without this yield a large backfill runs in a single event-loop turn, starving keepalive/replication and queries and never letting the isIndexing flag be observed
			}
		}
		// Await the last pending put. If it rejects, that is also an indexing error.
		// Note: the when() calls above already attach rejection handlers to each record's
		// last-put promise; this try-catch specifically handles the case where lastResolution
		// itself rejects (i.e. the very last put in the loop failed) which would otherwise
		// throw past the hadIndexingErrors check to the outer catch. The broader issue of
		// unhandled rejections from non-last puts in multi-value attributes is pre-existing
		// and out of scope for this fix.
		try {
			await lastResolution;
		} catch (error) {
			hadIndexingErrors = true;
			logger.error(error);
		}
		// Yield one more event turn so any queued when() error callbacks (which fire as
		// microtasks when their tracked promise settles) have a chance to set hadIndexingErrors
		// before we decide whether to mark indexing as complete.
		await new Promise((resolve) => setImmediate(resolve));
		if (hadIndexingErrors) {
			// Some records failed to index. Persist the failure marker in the descriptor so
			// the next call to table() (including after a restart with a fresh PID) re-triggers
			// the backfill from the last checkpoint. Do NOT clear indexingPID or isIndexing —
			// leave the index in its incomplete state so queries return 503 "not indexed yet"
			// rather than silently returning partial results. This is the key fix for the
			// serent-canopy issue #135 fingerprint: a completed migration with transient errors
			// (e.g. ERR_BUSY from RocksDB under load) leaving gaps while appearing successful.
			for (const attribute of attributes) {
				attribute.indexingFailed = true;
				// Preserve lastIndexedKey so the retry resumes from the last checkpoint.
				lastResolution = Table.dbisDB.put(attribute.key, attribute);
				// Keep isIndexing = true on both the attribute.dbi and the currently-active dbi
				// in Table.indices (which may differ if resetDatabases() ran during this pass).
				attribute.dbi.isIndexing = true;
				const activeDbi = Table.indices[attribute.name];
				if (activeDbi) activeDbi.isIndexing = true;
			}
			await lastResolution;
			logger.warn(
				`Indexing of ${Table.tableName} encountered errors on some records - index will remain incomplete. ` +
					`On next restart the migration will be retried from the last checkpoint (indexingFailed=true). ` +
					`Affected attributes: ${attributes.map((a) => a.name).join(', ')}`
			);
		} else {
			// update the attributes to indicate that we are finished
			for (const attribute of attributes) {
				delete attribute.lastIndexedKey;
				delete attribute.indexingPID;
				delete attribute.indexingFailed;
				delete attribute.restartNumber;
				attribute.dbi.isIndexing = false;
				// Also clear isIndexing on the currently-active dbi in Table.indices, which may
				// differ from attribute.dbi if a resetDatabases() call during this migration
				// opened a new dbi and registered it there.
				const activeDbi = Table.indices[attribute.name];
				if (activeDbi) activeDbi.isIndexing = false;
				lastResolution = Table.dbisDB.put(attribute.key, attribute);
			}
			await lastResolution;
			// now notify all the threads that we are done and the index is ready to use
			await signalling.signalSchemaChange(
				new SchemaEventMsg(process.pid, 'indexing-finished', Table.databaseName, Table.tableName)
			);
			logger.info(`Finished indexing ${Table.tableName} attributes`, attributes);
		}
	} catch (error) {
		// A worker shutting down closes its stores mid-backfill, so the range iterator or a
		// put throws (e.g. "Database not open" / "Iterator not initialized"). This is an
		// interruption, not a data error: the next worker generation re-runs the backfill via
		// the crash-recovery trigger (indexingPID / restartNumber mismatch), and persisting
		// indexingFailed here would fail anyway against the closed store. Treat it as a benign
		// interruption instead of logging a misleading error and a "failed to persist" warning.
		if (Table.primaryStore?.rootStore?.status === 'closed') {
			logger.debug(
				`Indexing of ${Table.tableName} interrupted by store shutdown; recovery resumes on the next worker generation`,
				error
			);
			return;
		}
		logger.error('Error in indexing', error);
		// Persist indexingFailed so the next restart re-triggers the rebuild from an
		// explicitly failed state rather than silently looping. Without this,
		// indexingPID (written before runIndexing was called) stays in the descriptor
		// but indexingFailed is never set, leaving isIndexing stuck with no recovery
		// signal. Mirrors the hadIndexingErrors path. harper#843
		try {
			const puts: Promise<unknown>[] = [];
			for (const attribute of attributes) {
				attribute.indexingFailed = true;
				puts.push(Table.dbisDB.put(attribute.key, attribute));
				attribute.dbi.isIndexing = true;
				const activeDbi = Table.indices[attribute.name];
				if (activeDbi) activeDbi.isIndexing = true;
			}
			await Promise.all(puts);
		} catch (persistError) {
			logger.warn('Failed to persist indexing failure state', persistError);
		}
	}
}

/**
 * Completes a table drop that was interrupted after its `dropping` tombstone
 * was written: drops any surviving table stores and removes the table's
 * catalog rows. Called from the boot-time schema load and from the create
 * path when a same-named table is created over a tombstoned entry. Callers
 * are expected to hold the database's exclusive lock or be in single-threaded
 * startup; a redundant drop of an already-gone store (another worker may be
 * completing the same drop concurrently) is tolerated, but any other
 * per-store failure propagates so the catalog rows are NOT removed - a store
 * that failed to drop must keep its tombstone, or a same-name recreate could
 * reuse (LMDB) or resurrect (RocksDB) the old store's data. Logged only at
 * debug: the caller's retry loop is what decides when a failure is
 * actionable, and logging here on every attempt would flood at the same
 * volume this function's callers are bounding.
 */
function completeInterruptedDrop(rootStore, attributesDbi, databaseName: string, tableName: string) {
	logger.debug(`Completing interrupted drop of table ${databaseName}.${tableName}`);
	if (rootStore instanceof RocksDatabase) {
		for (const columnName of (rootStore as any).columns) {
			if (columnName.startsWith(tableName + '/')) {
				const columnStore = openRocksDatabase(rootStore.path, { name: columnName });
				try {
					columnStore.dropSync();
				} catch (error) {
					ignoreAlreadyDropped(error);
				} finally {
					columnStore.close();
				}
			}
		}
	} else {
		// LMDB reuses an existing named sub-database on open, so the stores must
		// be dropped too; removing only the catalog rows would let a same-name
		// recreate silently inherit the previous table's records.
		for (const { key, value } of attributesDbi.getRange({ start: tableName + '/', end: tableName + '0' })) {
			const objectStorage =
				value?.isPrimaryKey || (value?.indexed?.type && CUSTOM_INDEXES[value.indexed.type]?.useObjectStore);
			const store = (rootStore as any).openDB(key, createOpenDBIObject(!objectStorage, objectStorage) as any);
			try {
				// dropSync (not drop): this function is synchronous, and its callers rely on
				// a thrown error to count against the retry budget below - the async drop()
				// resolves/rejects after this try/catch has already returned, so a failure
				// there would silently bypass the retry accounting entirely.
				store.dropSync?.();
			} catch (error) {
				ignoreAlreadyDropped(error);
			}
		}
	}
	// The primary catalog row (the `dropping` tombstone itself, keyed at exactly
	// `tableName + '/'`) sorts first among these keys and so would be removed
	// before the attribute rows that follow it. Removing it last instead means a
	// removeSync failure partway through leaves the tombstone in place alongside
	// whatever attribute rows didn't get removed yet, so a later retry still
	// recognizes the table as mid-drop - instead of the tombstone vanishing
	// first and stranding orphaned attribute rows that the next load would
	// misread as a live (non-dropping) table.
	const primaryCatalogKey = tableName + '/';
	let removePrimaryLast = false;
	for (const key of attributesDbi.getKeys({ start: tableName + '/', end: tableName + '0' })) {
		if (key === primaryCatalogKey) {
			removePrimaryLast = true;
			continue;
		}
		// removeSync (not remove): same reasoning as dropSync above - the async
		// remove() rejects after this function has already returned, so a
		// catalog-removal failure would bypass the retry accounting entirely.
		(attributesDbi as any).removeSync(key);
	}
	if (removePrimaryLast) (attributesDbi as any).removeSync(primaryCatalogKey);
}

export function dropTableMeta({ table: tableName, database: databaseName }) {
	const rootStore = database({ database: databaseName, table: tableName });
	const removals = [];
	const dbisDb = rootStore.dbisDb;
	for (const key of dbisDb.getKeys({ start: tableName + '/', end: tableName + '0' })) {
		removals.push(dbisDb.remove(key));
	}
	databaseEventsEmitter.emit('dropTable', tableName, databaseName);
	return Promise.all(removals);
}

export function onUpdatedTable(listener: (table: Table) => void) {
	databaseEventsEmitter.on('updateTable', listener);
	return {
		remove() {
			databaseEventsEmitter.off('updateTable', listener);
		},
	};
}
export function onRemovedTable(listener: (tableName: string, databaseName: string) => void) {
	databaseEventsEmitter.on('dropTable', listener);
	return {
		remove() {
			databaseEventsEmitter.off('dropTable', listener);
		},
	};
}
export function onRemovedDB(listener: (databaseName: string) => void) {
	databaseEventsEmitter.on('dropDatabase', listener);
	return {
		remove() {
			databaseEventsEmitter.off('dropDatabase', listener);
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
		LMDB_COMPRESSION_OPTS['dictionary'] = readFileSync(STORAGE_COMPRESSION_DICTIONARY);
	if (STORAGE_COMPRESSION_THRESHOLD) LMDB_COMPRESSION_OPTS['threshold'] = STORAGE_COMPRESSION_THRESHOLD;
	// normalize disabled to false so a falsy config value ('' or null) is never persisted
	// into table metadata as-is (openRocksDatabase maps defined-falsy to 'none')
	return LMDB_COMPRESSION ? LMDB_COMPRESSION_OPTS : false;
}

/**
 * Force all RocksDB databases to flush to disk.
 */
export async function flushDatabases() {
	// flush all RocksDB databases
	return Promise.all(Array.from(rocksdbDatabaseEnvs.values()).map((db) => db.flush()));
}
