import {
	getDatabases,
	getDefaultCompression,
	resetDatabases,
	getRocksCompression,
	toRocksCompression,
} from '../resources/databases.ts';
import { open, asBinary } from 'lmdb';
import { isAbsolute, join, relative } from 'node:path';
import { move, remove } from 'fs-extra';
import { existsSync, mkdirSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { get } from '../utility/environment/environmentManager.ts';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject.ts';
import { OpenDBIObject } from '../utility/lmdb/OpenDBIObject.ts';
import { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } from '../utility/lmdb/terms.ts';
import { CONFIG_PARAMS, DATABASES_DIR_NAME, MIGRATING_DIR_SUFFIX } from '../utility/hdbTerms.ts';
import { AUDIT_STORE_OPTIONS, auditRetention } from '../resources/auditStore.ts';
import { blobsReadmeContent, copyBlobRootsByIndex } from '../dataLayer/blobBackup.ts';
import { describeSchema } from '../dataLayer/schemaDescribe.ts';
import { updateConfigValue } from '../config/configUtils.ts';
import * as hdbLogger from '../utility/logging/harper_logger.ts';
import { RocksDatabase, type RocksDatabaseOptions } from '@harperfast/rocksdb-js';
import { RocksIndexStore } from '../resources/RocksIndexStore.ts';
import {
	Blob,
	beginPendingMigrationBlobSaves,
	encodeBlobsWithFilePath,
	endPendingMigrationBlobSaves,
	getBlobPathsForDatabaseName,
} from '../resources/blob.ts';
import {
	RecordEncoder,
	setNextEncoding,
	clearNextEncoding,
	lastMetadata,
	METADATA,
} from '../resources/RecordEncoder.ts';

export async function compactOnStart() {
	hdbLogger.notify('Running compact on start');
	console.log('Running compact on start');

	// Create compact copy and backup
	const rootPath = get(CONFIG_PARAMS.ROOTPATH);
	const compactedDb = new Map();
	const databases = getDatabases();

	updateConfigValue(CONFIG_PARAMS.STORAGE_COMPACTONSTART, false); // don't run this again, and update it before starting so that it fails we don't just keep retrying over and over

	try {
		for (const databaseName in databases) {
			if (databaseName === 'system') continue;
			if (databaseName.endsWith('-copy')) continue; // don't copy the copy
			const rootStores = getRootStores(databases[databaseName]);
			if (rootStores.size === 0) {
				console.log("Couldn't find any tables in database", databaseName);
				continue;
			}
			if ([...rootStores].some((rootStore) => rootStore instanceof RocksDatabase)) {
				console.log('Database', databaseName, 'is RocksDB, which compacts itself, skipping');
				continue;
			}
			// Compaction replaces one environment file, and leaves the blob roots alone because the
			// compacted copy goes back to this exact path under this database name. Tables in separate
			// environments have no single file to replace, so compacting them would relocate tables and
			// strand their blobs.
			if (rootStores.size > 1) {
				const message = `Skipping compaction of database ${databaseName}: its tables span ${rootStores.size} storage environments (table-specific paths), which compaction cannot replace as one file`;
				hdbLogger.warn(message);
				console.warn(message);
				continue;
			}
			const dbPath = [...rootStores][0].path;

			const backupDest = join(rootPath, 'backup', databaseName + '.mdb');
			const copyDest = join(rootPath, DATABASES_DIR_NAME, databaseName + '-copy.mdb');
			const copyDatabaseName = databaseName + '-copy';
			const copyDatabaseRootStores = databases[copyDatabaseName] && getRootStores(databases[copyDatabaseName]);
			if (
				copyDatabaseRootStores &&
				[...copyDatabaseRootStores].some((rootStore) => relative(copyDest, rootStore.path) === '')
			) {
				const message = `Skipping compaction of database ${databaseName}: ${copyDatabaseName} is an existing database at the compaction target path; rename it before retrying`;
				hdbLogger.warn(message);
				console.warn(message);
				continue;
			}
			let recordCount = 0;
			try {
				recordCount = await getTotalDBRecordCount(databaseName);
				console.log('Database', databaseName, 'before compact has a total record count of', recordCount);
			} catch (error) {
				hdbLogger.error('Error getting record count for database', databaseName, error);
				console.error('Error getting record count for database', databaseName, error);
			}
			const compactionState = {
				dbPath,
				copyDest,
				backupDest,
				recordCount,
				backedUp: false,
			};
			compactedDb.set(databaseName, compactionState);

			// A copy target left behind by an interrupted run would be opened and merged into, mixing
			// stale entries into this compaction's output.
			await remove(copyDest);
			await remove(copyDest + '-lock');

			await copyDb(databaseName, copyDest, { blobs: 'preserve-source-roots' });

			// The backup is the only rollback for the overwrite below, so a failed backup fails the
			// compaction (leaving the source in place) instead of overwriting the only copy.
			console.log('Backing up', databaseName, 'to', backupDest);
			await move(dbPath, backupDest, { overwrite: true });
			compactionState.backedUp = true;
			// Move compacted DB to back to original DB path
			console.log('Moving copy compacted', databaseName, 'to', dbPath);
			await move(copyDest, dbPath, { overwrite: true });
			await remove(join(rootPath, DATABASES_DIR_NAME, `${databaseName}-copy.mdb-lock`));
		}
		try {
			resetDatabases();
		} catch (err) {
			hdbLogger.error('Error resetting databases after backup', err);
			console.error('Error resetting databases after backup', err);
		}

		try {
			resetDatabases();
		} catch (err) {
			hdbLogger.error('Error resetting databases after backup', err);
			console.error('Error resetting databases after backup', err);
			process.exit(0); // just let the process restart
		}
	} catch (err) {
		hdbLogger.error('Error compacting database, rolling back operation', err);
		console.error('Error compacting database, rolling back operation', err);

		updateConfigValue(CONFIG_PARAMS.STORAGE_COMPACTONSTART, false);

		for (const [_db, { dbPath, backupDest, backedUp }] of compactedDb) {
			// Only a backup this run created is this run's source to restore. `backupDest` is a fixed
			// path per database, so a retained backup from an earlier run can be sitting there — moving
			// that over a database whose compaction failed before its own backup was taken would
			// replace healthy data with a stale snapshot.
			if (!backedUp) continue;
			console.error('Moving backup database', backupDest, 'back to', dbPath);
			try {
				await move(backupDest, dbPath, { overwrite: true });
			} catch (err) {
				console.error(err);
			}
		}
		resetDatabases();

		throw err;
	}

	// Clean up backups
	for (const [db, { backupDest, recordCount }] of compactedDb) {
		const compactRecordCount = await getTotalDBRecordCount(db);
		console.log('Database', db, 'after compact has a total record count of', compactRecordCount);

		if (recordCount !== compactRecordCount) {
			const errMsg = `There is a discrepancy between pre and post compact record count for database ${db}.\nTotal record count before compaction: ${recordCount}, total after: ${compactRecordCount}.\nDatabase backup has not been removed and can be found here: ${backupDest}`;
			hdbLogger.warn(errMsg);
			console.warn(errMsg);
		}

		if (get(CONFIG_PARAMS.STORAGE_COMPACTONSTARTKEEPBACKUP) === true) continue;
		console.log('Removing backup', backupDest);
		await remove(backupDest);
	}
}

async function getTotalDBRecordCount(database: string) {
	const dbDescribe = await describeSchema({ database });
	let total = 0;
	for (const table in dbDescribe) {
		total += dbDescribe[table].record_count;
	}

	return total;
}

// we replace the write functions with a noop during this process, just in case they get called
function noop() {
	// if there are any attempts to write to the db, ignore them
}

function getRootStores(database): Set<any> {
	const rootStores = new Set<any>();
	for (const tableName in database) rootStores.add(database[tableName].primaryStore.rootStore);
	return rootStores;
}

const BLOB_COPY_SUFFIX = '-blobs';

const STRUCTURES_KEY = Symbol.for('structures');

const MAX_COPY_RETRIES = 1000;

const MSGPACK_NIL = 0xc0;

function isWithin(path: string, directory: string): boolean {
	const relativePath = relative(directory, path);
	return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

/**
 * Read and write raw stored bytes through this handle: `openDB` builds a RecordEncoder from the DBI
 * options whatever `encoding` says, and the live audit store also wraps `getRange` to yield decoded
 * audit records, so a byte-for-byte copy needs the encoder detached.
 */
function useRawBytes(store) {
	store.encoder = null;
	store.decoder = null;
	store.decoderCopies = false;
	store.encoding = 'binary';
	return store;
}

/**
 * Copy a database's blob roots into `<targetDatabasePath>-blobs/<rootIndex>/…`. Blob files live
 * outside the environment file and are addressed by database *name* against the running instance's
 * configured roots, so a copy without them is unreadable anywhere but its own origin.
 */
async function copyDatabaseBlobs(sourceDatabase: string, targetDatabasePath: string, blobRoots: string[]) {
	const populatedRoots = blobRoots.filter((root) => existsSync(root));
	if (populatedRoots.length === 0) return;
	const destination = targetDatabasePath + BLOB_COPY_SUFFIX;
	await copyBlobRootsByIndex(destination, blobRoots);
	await writeFile(join(destination, 'README.md'), blobsReadmeContent(blobRoots, { variant: 'copy' }));
	const message =
		`Copied ${populatedRoots.length} blob root(s) of ${sourceDatabase} to ${destination}. This copy is not ` +
		`restorable without them: blobs are addressed by database name, so each <rootIndex> directory has to be ` +
		`placed into the matching blob root of the database the copy is restored as (see ${join(destination, 'README.md')})`;
	hdbLogger.notify(message);
	console.log(message);
}

/**
 * Copy a database's LMDB environment to `targetDatabasePath`.
 *
 * `blobs` declares what happens to the database's file-backed blobs, and is required because both
 * answers are silently destructive when wrong: `'copy'` writes them beside the target (what an
 * operator copying a database elsewhere needs), `'preserve-source-roots'` leaves them untouched and
 * is only sound when the copy replaces the source environment under the same database name, which is
 * what makes the existing roots keep resolving.
 */
export async function copyDb(
	sourceDatabase: string,
	targetDatabasePath: string,
	options: { blobs: 'copy' | 'preserve-source-roots' }
) {
	const blobDisposition = options?.blobs;
	if (blobDisposition !== 'copy' && blobDisposition !== 'preserve-source-roots')
		throw new Error(
			`copyDb requires a blob disposition: { blobs: 'copy' } to copy ${sourceDatabase}'s blob files beside the target, ` +
				`or { blobs: 'preserve-source-roots' } when the copy replaces the source environment in place`
		);
	console.log(`Copying database ${sourceDatabase} to ${targetDatabasePath}`);
	const sourceDb = getDatabases()[sourceDatabase];
	if (!sourceDb) throw new Error(`Source database not found: ${sourceDatabase}`);
	const rootStores = getRootStores(sourceDb);
	if (rootStores.size === 0) throw new Error(`Source database does not have any tables: ${sourceDatabase}`);
	if (rootStores.size > 1)
		throw new Error(
			`Database ${sourceDatabase} spans ${rootStores.size} storage environments (table-specific paths); ` +
				`copying it into the single environment ${targetDatabasePath} would relocate tables and strand their blobs`
		);
	const [rootStore] = rootStores;
	if (rootStore instanceof RocksDatabase)
		throw new Error(`Database ${sourceDatabase} is stored in RocksDB; copyDb copies LMDB environments only`);
	if (existsSync(targetDatabasePath))
		throw new Error(
			`Copy target ${targetDatabasePath} already exists; remove it first — opening it would merge this copy into whatever it holds`
		);
	const blobRoots = blobDisposition === 'copy' ? getBlobPathsForDatabaseName(sourceDatabase) : [];
	const blobDestination = targetDatabasePath + BLOB_COPY_SUFFIX;
	if (blobDisposition === 'copy') {
		if (existsSync(blobDestination))
			throw new Error(`Blob copy target ${blobDestination} already exists; remove it first`);
		for (const root of blobRoots) {
			if (isWithin(blobDestination, root) || isWithin(root, blobDestination))
				throw new Error(
					`Copy target ${targetDatabasePath} overlaps the source blob root ${root}; choose a target outside it`
				);
		}
	}
	// Suppress source writes only once the copy is going ahead: a caller that catches a rejection above
	// keeps using these stores.
	const primaryStoresByDbi = new Map<string, any>();
	for (const tableName in sourceDb) {
		const table = sourceDb[tableName];
		table.primaryStore.put = noop;
		table.primaryStore.remove = noop;
		for (const attributeName in table.indices) {
			const index = table.indices[attributeName];
			index.put = noop;
			index.remove = noop;
		}
		if (table.auditStore) {
			table.auditStore.put = noop;
			table.auditStore.remove = noop;
		}
		primaryStoresByDbi.set(table.primaryStore.name, table.primaryStore);
	}
	try {
		await copyDbEnvironment(sourceDatabase, targetDatabasePath, rootStore, primaryStoresByDbi);
		if (blobDisposition === 'copy') await copyDatabaseBlobs(sourceDatabase, targetDatabasePath, blobRoots);
	} catch (error) {
		// Every path removed here was created by this call — both targets are rejected above if they
		// already exist — and a partial copy left behind is a copy someone can restore from.
		await remove(targetDatabasePath).catch(() => {});
		await remove(targetDatabasePath + '-lock').catch(() => {});
		if (blobDisposition === 'copy') await remove(blobDestination).catch(() => {});
		throw error;
	}
}

async function copyDbEnvironment(
	sourceDatabase: string,
	targetDatabasePath: string,
	rootStore,
	primaryStoresByDbi: Map<string, any>
) {
	// this contains the list of all the dbis
	const sourceDbisDb = rootStore.dbisDb;
	const sourceAuditStore = rootStore.auditStore;
	const targetEnv = open(new OpenEnvironmentObject(targetDatabasePath));
	const targetDbisDb = targetEnv.openDB({ name: INTERNAL_DBIS_NAME });
	let written;
	let outstandingWrites = 0;
	// One cutoff for the whole copy so a long copy classifies every tombstone against the same instant
	const tombstoneCutoff = Date.now() - auditRetention;
	// we use a single transaction to get a snapshot, also we can't use snapshot: false on dupsort dbs
	const transaction = sourceDbisDb.useReadTransaction();
	try {
		for (const { key, value: attribute } of sourceDbisDb.getRange({ transaction })) {
			const isPrimary = attribute.isPrimaryKey;
			let existingCompression, newCompression;
			if (isPrimary) {
				existingCompression = attribute.compression;
				newCompression = getDefaultCompression();
				if (newCompression) attribute.compression = newCompression;
				else delete attribute.compression;
				if (existingCompression?.dictionary?.toString() === newCompression?.dictionary?.toString()) {
					// no need to change the compression, it's the same, so we can, and should, skip decompressing and recompressing
					existingCompression = null;
					newCompression = null;
				}
			}
			targetDbisDb.put(key, attribute);
			if (!(isPrimary || attribute.indexed)) continue;
			const dbiInit = new OpenDBIObject(!isPrimary, isPrimary);
			// we want to directly copy bytes so we don't have the overhead of
			// encoding and decoding
			dbiInit.encoding = 'binary';
			dbiInit.compression = existingCompression;
			//dbiInit.keyEncoding = 'binary';
			const sourceDbi = useRawBytes(rootStore.openDB(key, dbiInit));
			dbiInit.compression = newCompression;
			const targetDbi = useRawBytes((targetEnv as any).openDB(key, dbiInit));
			console.log('copying', key, 'from', sourceDatabase, 'to', targetDatabasePath);
			await copyDbi(sourceDbi, targetDbi, isPrimary, transaction, primaryStoresByDbi.get(key));
			if (isPrimary) await verifyStructuresCopied(sourceDbi, targetDbi, key);
		}
		if (sourceAuditStore) {
			// Each handle belongs to its own environment: a "target" handle opened on the source env
			// writes the audit log back into the source and leaves the copy without one.
			const sourceAuditDbi = rootStore.openDB(AUDIT_STORE_NAME, { create: false, ...AUDIT_STORE_OPTIONS });
			if (!sourceAuditDbi) throw new Error(`Could not open the audit store of ${sourceDatabase} to copy it`);
			const targetAuditStore = (targetEnv as any).openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
			console.log('copying audit log for', sourceDatabase, 'to', targetDatabasePath);
			await copyDbi(useRawBytes(sourceAuditDbi), useRawBytes(targetAuditStore), false, transaction);
		}

		/**
		 * A primary DBI's shared-structures dictionary is the whole table's decodability: without it
		 * every copied record decodes to null. It rides through the copy as a symbol-keyed entry, so
		 * confirm it landed rather than trusting the walk.
		 */
		async function verifyStructuresCopied(sourceDbi, targetDbi, dbiName) {
			const sourceStructures = sourceDbi.getBinary?.(STRUCTURES_KEY);
			if (!sourceStructures) return;
			await written;
			const copiedStructures = targetDbi.getBinary(STRUCTURES_KEY);
			if (!copiedStructures || !Buffer.from(copiedStructures).equals(Buffer.from(sourceStructures)))
				throw new Error(
					`Copy of ${sourceDatabase}/${dbiName} to ${targetDatabasePath} lost the shared-structures dictionary ` +
						`(${sourceStructures.length} source bytes, ${copiedStructures?.length ?? 0} copied) — every record in the copy would decode as null`
				);
		}

		/**
		 * Return a delete tombstone's local retention timestamp, decided by decoding it with the live table's
		 * record decoder. Length cannot decide it — a small shared-structures dictionary and a small
		 * record both land in a tombstone's usual size range — and `decode` returning null is not
		 * sufficient either, since it also returns null for a record whose shared structure is missing
		 * on this node. Only a metadata-bearing decode proves a tombstone; anything unprovable is kept.
		 */
		function getDeletedRecordTime(value, primaryStore, version) {
			if (!primaryStore?.decoder) return;
			try {
				if (primaryStore.decoder.decode(value) === null && lastMetadata?.value === null)
					return lastMetadata.localTime ?? version;
			} catch {
				return;
			}
		}

		async function copyDbi(sourceDbi, targetDbi, isPrimary, transaction, primaryStore?) {
			let recordsCopied = 0;
			let bytesCopied = 0;
			let skippedRecord = 0;
			let failedRecords = 0;
			let retries = MAX_COPY_RETRIES;
			let start = null;
			let completed = false;
			while (!completed && retries-- > 0) {
				try {
					// getRange, not getKeys + getEntry: on a dupSort index the latter yields one entry per
					// unique key, dropping every duplicate
					for (const { key, value, version } of sourceDbi.getRange(
						isPrimary ? { start, transaction, versions: true } : { start, transaction }
					)) {
						try {
							start = key;
							// Drop a tombstone only once it is past audit retention, the point the runtime
							// removes it too: dropping a live one loses the delete, letting a peer that
							// missed it resurrect the record. A tombstone's body is a lone msgpack nil, so
							// the trailing byte keeps the decode off every other record.
							const deletedRecordTime =
								isPrimary && typeof key !== 'symbol' && value?.[value.length - 1] === MSGPACK_NIL
									? getDeletedRecordTime(value, primaryStore, version)
									: undefined;
							if (deletedRecordTime != null && deletedRecordTime < tombstoneCutoff) {
								skippedRecord++;
								continue;
							}
							written = targetDbi.put(key, value, isPrimary ? version : undefined);
							recordsCopied++;
							if (transaction.openTimer) transaction.openTimer = 0; // reset the timer, don't want it to time out
							bytesCopied += (key?.length || 10) + value.length;
							if (outstandingWrites++ > 5000) {
								await written;
								console.log(
									'copied',
									recordsCopied,
									'entries, skipped',
									skippedRecord,
									'delete records,',
									bytesCopied,
									'bytes'
								);
								outstandingWrites = 0;
							}
						} catch (error) {
							failedRecords++;
							console.error(
								'Error copying record',
								typeof key === 'symbol' ? 'symbol' : key,
								'from',
								sourceDatabase,
								'to',
								targetDatabasePath,
								error
							);
							break;
						}
					}
					completed = true;
				} catch (error) {
					// Resume from the last key read, never past it: re-copying that key is idempotent (an
					// identical put, and an identical dupSort pair, is a no-op) while advancing the key
					// would jump the copy over everything in between and still reach the success path.
					console.error(
						`Error iterating ${sourceDatabase} near key ${typeof start === 'symbol' ? 'symbol' : JSON.stringify(start)}, retrying (${retries} retries left):`,
						error
					);
				}
			}
			// A copy that lost entries, or stopped part-way through a DBI, must not report success
			if (!completed)
				throw new Error(
					`Copy of ${sourceDatabase} to ${targetDatabasePath} could not get past key ` +
						`${typeof start === 'symbol' ? 'symbol' : JSON.stringify(start)} in ${MAX_COPY_RETRIES} attempts`
				);
			if (failedRecords > 0)
				throw new Error(
					`Copy of ${sourceDatabase} to ${targetDatabasePath} failed on ${failedRecords} entry/entries after copying ${recordsCopied}`
				);
			console.log(
				'finish copying, copied',
				recordsCopied,
				'entries, skipped',
				skippedRecord,
				'delete records,',
				bytesCopied,
				'bytes'
			);
		}

		await written;
		console.log('copied database ' + sourceDatabase + ' to ' + targetDatabasePath);
	} finally {
		transaction.done();
		await targetEnv.close();
	}
}

// Returns a skeleton of `value` that produces the same classic/named structure (key list) when
// encoded, but stubs every leaf — strings, numbers, Buffers, Blobs, Dates, etc. — to a primitive.
// Objects (plain AND decoded records) and arrays are recursed so nested structures (e.g. a record's
// `headers` object) are built. The migration reads source records as RecordObject instances (the
// encoder's structPrototype), not plain Object, so gating recursion on `constructor === Object`
// stubbed every record to a scalar — the observer then minted no structure and the canonical seed was
// never persisted, so v5 workers fork the dictionary from an empty durable (HarperFast/harper#1508).
// Leaf object types (Blob, Date, Buffer/typed arrays, Map, Set) stay stubbed; a Blob especially must
// not be walked — that would pull the file-backed payload this skeleton exists to avoid.
export function shapeForStructure(value: any): any {
	if (Array.isArray(value)) return value.map(shapeForStructure);
	if (
		value &&
		typeof value === 'object' &&
		!(value instanceof Blob) &&
		!(value instanceof Date) &&
		!ArrayBuffer.isView(value) &&
		!(value instanceof ArrayBuffer) &&
		!(value instanceof SharedArrayBuffer) &&
		!(value instanceof Map) &&
		!(value instanceof Set)
	) {
		const out: any = {};
		// Own enumerable keys only — match the struct fields msgpackr encodes for the real record, and
		// don't pull enumerable prototype-chain properties into the skeleton's key set.
		for (const k of Object.keys(value)) out[k] = shapeForStructure(value[k]);
		return out;
	}
	return 1;
}

function openRocksDb(path: string, options: RocksDatabaseOptions & { dupSort?: boolean } = {}) {
	options.disableWAL ??= false;
	// Migration creates a complete replacement database, so use the deployment codec for the files
	// it writes; runtime opens additionally reconcile pre-existing sibling column families.
	const legacyOptions = options as { compression?: unknown };
	legacyOptions.compression = getRocksCompression() ?? toRocksCompression(legacyOptions.compression);
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
	let db;
	if (options.dupSort) {
		db = new (RocksIndexStore as any)(path, options).open();
	} else {
		db = RocksDatabase.open(path, options);
		if (db.encoder) db.encoder.name = options.name;
	}
	return db;
}

export async function migrateOnStart() {
	hdbLogger.notify('Running migrate on start (LMDB to RocksDB)');
	console.log('Running migrate on start (LMDB to RocksDB)');

	const rootPath = get(CONFIG_PARAMS.ROOTPATH);
	const databases = getDatabases();

	try {
		let databaseNames = Object.keys(databases);
		// system is a dontenum property, so we have to manually add it
		if (!databaseNames.includes('system')) databaseNames.push('system');
		for (const databaseName of databaseNames) {
			if (databaseName.endsWith('-copy')) continue;
			let rootStore;
			for (const tableName in databases[databaseName]) {
				const table = databases[databaseName][tableName];
				table.primaryStore.put = noop;
				table.primaryStore.remove = noop;
				for (const attributeName in table.indices) {
					const index = table.indices[attributeName];
					index.put = noop;
					index.remove = noop;
				}
				if (table.auditStore) {
					table.auditStore.put = noop;
					table.auditStore.remove = noop;
				}
				rootStore = table.primaryStore.rootStore;
			}
			if (!rootStore) {
				console.log("Couldn't find any tables in database", databaseName);
				continue;
			}
			if (rootStore instanceof RocksDatabase) {
				console.log('Database', databaseName, 'is already RocksDB, skipping');
				continue;
			}

			const targetPath = join(rootPath, DATABASES_DIR_NAME, databaseName);
			const lmdbPath = rootStore.path;
			const backupDest = join(rootPath, 'backup', databaseName + '.mdb');

			console.log('Migrating', databaseName, 'from LMDB to RocksDB at', targetPath);

			await migrateDatabaseToRocks(rootStore, databaseName, targetPath);

			// Back up the original LMDB file
			console.log('Backing up LMDB', databaseName, 'to', backupDest);
			try {
				await move(lmdbPath, backupDest, { overwrite: true });
			} catch (error) {
				console.log('Error moving database', lmdbPath, 'to', backupDest, error);
			}
			// Remove the lock file
			try {
				await remove(lmdbPath + '-lock');
			} catch {
				// lock file may not exist
			}
		}

		// Only clear the flag after all databases have migrated successfully
		updateConfigValue(CONFIG_PARAMS.STORAGE_MIGRATEONSTART, false);

		try {
			resetDatabases();
		} catch (err) {
			hdbLogger.error('Error resetting databases after migration', err);
			console.error('Error resetting databases after migration', err);
		}
	} catch (err) {
		hdbLogger.error('Error migrating database', err);
		console.error('Error migrating database', err);
		throw err;
	}
}

/**
 * Count records in a raw (encoding: false) store whose value lacks the 8-byte version prefix
 * (0x42 = first byte of a ms-epoch float64). Symbol keys are internal and skipped. First-byte
 * classification is a heuristic: a prefix-less classic record can also lead with 0x42 (structure
 * ref id 2) and would be undercounted — fine for the whole-table detection this report serves.
 */
function countRecords(rawDbi): { records: number; unversioned: number } {
	let records = 0;
	let unversioned = 0;
	for (const { key, value } of rawDbi.getRange({})) {
		if (typeof key === 'symbol') continue;
		records++;
		if (!value || value.length < 8 || value[0] !== 0x42) unversioned++;
	}
	return { records, unversioned };
}

/**
 * Verification sweep for an already-migrated RocksDB database (harper#2012): reports, per
 * primary-key dbi, how many records lack the version/metadata prefix. Such records decode
 * without their record prototype on point reads and carry no version; a nonzero count beyond a
 * table's known version-less records means it needs the no-op rewrite pass. Read-only, but takes
 * the RocksDB lock — run in-process (inspector) on a live instance, or offline.
 */
export function verifyMigratedDatabase(databasePath: string): Record<string, { records: number; unversioned: number }> {
	// Every open handle, so a failure at any point (e.g. the second open throwing on lock
	// contention) cannot leak an earlier handle that would hold the RocksDB lock on the very
	// diagnostic path operators use after a broken migration.
	const handles: RocksDatabase[] = [];
	const report: Record<string, { records: number; unversioned: number }> = {};
	try {
		handles.push(RocksDatabase.open(databasePath, {}));
		const dbisDb = RocksDatabase.open(databasePath, {
			name: INTERNAL_DBIS_NAME,
			sharedStructuresKey: Symbol.for('structures'),
		});
		handles.push(dbisDb);
		for (const { key, value: attribute } of dbisDb.getRange({})) {
			if (typeof key === 'symbol' || !attribute?.isPrimaryKey) continue;
			// per-table handles close per-iteration so a many-table sweep does not hold every CF
			// handle open at once; only the two pre-loop opens need the leak-safety array
			const rawDbi = RocksDatabase.open(databasePath, { name: key, encoding: false });
			try {
				report[key] = countRecords(rawDbi);
			} finally {
				rawDbi.close();
			}
		}
	} finally {
		for (const handle of handles.reverse()) {
			try {
				handle.close();
			} catch (error) {
				console.error('Error closing verification store', error);
			}
		}
	}
	return report;
}

/**
 * Migrate one database LMDB→RocksDB with restart-safe promotion: copy into a staging directory
 * (excluded from database discovery) and atomically rename it to targetPath only after the copy
 * fully verifies. A failure part-way must never leave a partial RocksDB at targetPath — on the
 * next boot both <db>.mdb and <db>/ would be discovered, and whichever binds last wins; if the
 * partial RocksDB won, migrateOnStart would see "already RocksDB", clear the flag, and abandon
 * the intact LMDB. Any stale staging dir is removed before retrying, so an interrupted migration
 * (throw or SIGKILL) always recovers by re-migrating from the untouched LMDB source.
 */
export async function migrateDatabaseToRocks(sourceRootStore, databaseName: string, targetPath: string) {
	const stagingPath = targetPath + MIGRATING_DIR_SUFFIX;
	await remove(stagingPath);
	try {
		await copyDbToRocks(sourceRootStore, databaseName, stagingPath);
	} catch (error) {
		try {
			await remove(stagingPath);
		} catch {
			// discovery ignores the staging dir and the next attempt removes it
		}
		throw error;
	}
	// A directory already at targetPath can only be a stale partial from a pre-staging build's
	// failed attempt (or a complete copy from a crash after rename but before the flag cleared) —
	// discovery bound the LMDB source this boot, and we just produced a fresh verified copy from
	// it, so replace.
	await remove(targetPath);
	// On Windows a directory rename can transiently fail while RocksDB background threads release
	// their last file handles after close(); retry briefly before giving up.
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(stagingPath, targetPath);
			break;
		} catch (error: any) {
			if (attempt >= 4 || !(error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES')) throw error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}

export async function copyDbToRocks(sourceRootStore, sourceDatabase: string, targetPath: string) {
	console.log(`Migrating database ${sourceDatabase} to RocksDB at ${targetPath}`);
	const sourceDbisDb = sourceRootStore.dbisDb;
	// Runtime Harper stores disable RocksDB's native WAL for data/index column families and recover
	// them from rocksdb-js transaction logs. This copier does not write those transaction logs, so
	// only use the same fast write path for migrateOnStart's disposable staging directory: after an
	// interruption it is deleted and recopied from LMDB. Direct copyDbToRocks callers retain WAL.
	const disableDataWAL = targetPath.endsWith(MIGRATING_DIR_SUFFIX);

	// Keep native WAL for the root/log-owner and __dbis__ handles, matching Harper's runtime policy.
	// Their migration writes are metadata-sized; the 600 GB bulk is in the data/index handles below.
	const targetRootStore = openRocksDb(targetPath, { disableWAL: false });
	// Every handle opened on targetPath. All must be closed before returning so the caller can
	// atomically rename a staging directory into place — rocksdb-js registers descriptors by
	// path string, so a handle left open on the staging path would hold the DB lock against the
	// runtime's open of the renamed directory (harper#2012 restart-safety).
	const targetHandles: RocksDatabase[] = [targetRootStore];
	// sharedStructuresKey wires the rocksdb-js getStructures/saveStructures closures
	// so that the plain msgpackr.Encoder used here persists structures within the
	// __dbis__ CF at Symbol.for('structures'). The runtime attributesDbi RecordEncoder
	// takes the non-isRocksDB path (handleLocalTimeForGets is never called on it) and
	// reads from the same CF key via superGetStructures. Without this, own structure
	// IDs starting at 0x40 are minted in-memory and silently lost on restart →
	// runtime decoder interprets 0x40 as fixint 64 → "Data read, but end of buffer
	// not reached 64" (harper#1260).
	const targetDbisDb = openRocksDb(targetPath, {
		disableWAL: false,
		name: INTERNAL_DBIS_NAME,
		sharedStructuresKey: Symbol.for('structures'),
	});
	targetHandles.push(targetDbisDb);

	const copyStructures = (sourceDbi, storeName: string, extraTarget?: RocksDatabase) => {
		const buffer = sourceDbi.getBinary?.(STRUCTURES_KEY);
		if (buffer) {
			const binaryBuffer = asBinary(buffer);
			targetRootStore.putSync([STRUCTURES_KEY, storeName], binaryBuffer);
			// Also write to the extra target CF when provided (e.g. __dbis__ CF,
			// which the runtime RecordEncoder reads via its superGetStructures path).
			extraTarget?.putSync(STRUCTURES_KEY, binaryBuffer);
		}
	};

	copyStructures(sourceDbisDb, INTERNAL_DBIS_NAME, targetDbisDb);

	let written;
	let outstandingWrites = 0;
	// Open a blob-save tracking window for this database's migration. saveBlob inside
	// encodeBlobsWithFilePath pushes every in-flight save promise into `pendingBlobSaves` so we
	// can await them before declaring the database migrated. Without this, fire-and-forget blob
	// writes could be left mid-pipeline at migration end, producing records in the target DB
	// referencing fileIds whose files were never durably written — exactly the missing-blob-file
	// state that triggers the base-copy resync wedge in harper#1337.
	const pendingBlobSaves = beginPendingMigrationBlobSaves();
	// Acquired inside the try: if it throws, the finally must still close the target handles so a
	// staging directory can be removed and its path reopened cleanly (harper#2012).
	let transaction;
	try {
		transaction = sourceDbisDb.useReadTransaction();
		for (const { key, value: attribute } of sourceDbisDb.getRange({ transaction })) {
			const isPrimary = attribute.isPrimaryKey;
			targetDbisDb.put(key, attribute);
			if (!(isPrimary || attribute.indexed)) continue;

			// Open source LMDB dbi with default encoding so values are decoded.
			// Compression must be passed through from the attribute descriptor so lmdb-js
			// installs its decompression layer; without it, compressed record/structure bytes
			// are interpreted as raw msgpack, which on records that reference shared structures
			// triggers infinite getStructures recursion → "Maximum call stack size exceeded".
			const dbiInit = new OpenDBIObject(!isPrimary, isPrimary);
			dbiInit.compression = attribute.compression;
			const sourceDbi = sourceRootStore.openDB(key, dbiInit);
			// The primary dbi uses a RecordEncoder, whose decode resolves file-backed blob references
			// against `rootStore`. Without it, decoding any record that holds a blob throws "No store
			// specified, cannot load blob from storage", the error is swallowed (record decodes to null),
			// and the record is silently dropped from the migration (HarperFast/harper#857).
			if (isPrimary && sourceDbi.encoder) sourceDbi.encoder.rootStore = sourceRootStore;

			let targetDbi;
			// A SEPARATE shared-mode encoder that observes each re-encoded record to build the canonical
			// v5 classic shared-structures dictionary, captured here and persisted once after the loop.
			// The migration's own/inline encoder (below) is left untouched so the migrated records stay
			// self-describing; this observer only accumulates the structure shapes.
			let observerEncoder: any;
			let canonicalStructures: any;
			if (!isPrimary) {
				targetDbi = openRocksDb(targetPath, { disableWAL: disableDataWAL, dupSort: true, name: key });
				targetHandles.push(targetDbi);
			} else {
				targetDbi = openRocksDb(targetPath, { disableWAL: disableDataWAL, name: key });
				targetHandles.push(targetDbi);
				// Patch the existing encoder (encoder is a getter-only property on RocksDatabase, cannot be replaced)
				// to install RecordEncoder's encode method so metadata headers (timestamps, HAS_BLOBS flag) are written
				const existingEncoder = targetDbi.encoder as any;
				existingEncoder.isRocksDB = true;
				existingEncoder.rootStore = targetRootStore;
				const tempEncoder = new RecordEncoder({ name: key }) as any;
				// msgpackr's pack closure captures `packr = this` at construction, so during
				// re-encoding the structure callbacks resolve to tempEncoder's getStructures/
				// saveStructures (invoked with this === tempEncoder), not existingEncoder's.
				// tempEncoder must therefore carry the RocksDB wiring too, or getStructures hits
				// the non-RocksDB branch where the captured super is undefined and throws.
				tempEncoder.name = key;
				tempEncoder.isRocksDB = true;
				tempEncoder.rootStore = targetRootStore;
				existingEncoder.encode = tempEncoder.encode;
				existingEncoder.getStructures = tempEncoder.getStructures;
				// The shared structures dictionary is copied verbatim from the source by
				// copyStructures() below, so re-encoding never needs to persist new structures.
				// A no-op saveStructures avoids opening a targetRootStore.transactionSync() in the
				// middle of each record's encode, which otherwise discards the targetDbi record writes.
				const noopSaveStructures = () => true;
				existingEncoder.saveStructures = noopSaveStructures;
				tempEncoder.saveStructures = noopSaveStructures;

				// Observer: shared structures on, so it accumulates one classic dictionary. We capture
				// the full set from saveStructures (msgpackr passes it on every mint) rather than persist
				// per-record — opening a targetRootStore transaction mid-encode would discard record
				// writes; we persist once after the loop instead.
				observerEncoder = new RecordEncoder({ name: key, structures: [] }) as any;
				observerEncoder.name = key;
				observerEncoder.isRocksDB = true;
				observerEncoder.rootStore = targetRootStore;
				observerEncoder.saveStructures = (structures: any) => {
					canonicalStructures = Array.isArray(structures) ? structures.slice() : structures;
					return true;
				};
			}

			copyStructures(sourceDbi, key);

			console.log('migrating', key, 'from', sourceDatabase, 'to RocksDB');
			const copied = await copyDbiToRocks(sourceDbi, targetDbi, isPrimary, transaction, observerEncoder);
			if (copied?.firstVersioned !== undefined) {
				const { firstVersioned, versionlessKeys } = copied;
				// Invariant tripwire (#2012): a versioned record must round-trip with its 8-byte
				// version prefix. The full big-endian float64 is compared to the source version —
				// a first-byte check alone is ambiguous, since a prefix-less classic record can
				// also lead with 0x42 (structure ref id 2). Failing here keeps the migration
				// incomplete (LMDB source intact, migrateOnStart flag retained) instead of
				// shipping a database whose records silently lost versions and record prototypes.
				await firstVersioned.written;
				await written;
				const roundTrip = targetDbi.getBinarySync(firstVersioned.key);
				const roundTripVersion = roundTrip && roundTrip.length >= 8 ? roundTrip.readDoubleBE(0) : undefined;
				if (roundTripVersion !== firstVersioned.version) {
					throw new Error(
						`Migration of ${sourceDatabase} wrote record ${JSON.stringify(firstVersioned.key)} without its ` +
							`version/metadata prefix (expected version ${firstVersioned.version}, read back ${roundTripVersion}) — ` +
							`records would lose versions and prototypes`
					);
				}
				// Full verification sweep (harper#2012 ask #3): every migrated record that had a source
				// version must carry the prefix. Version-less source records are exempted by KEY, not
				// by byte inspection — a plain classic body can also lead with 0x42 (structure ref
				// id 2), so byte sniffing could misclassify them and throw spuriously. For versioned
				// records the first-byte check suffices: a systemic prefix regression trips on the
				// very first record (and the exact-header tripwire above already validated one).
				const rawDbi = openRocksDb(targetPath, { name: key, encoding: false });
				targetHandles.push(rawDbi);
				let unprefixed = 0;
				let scanned = 0;
				for (const { key: recordKey, value } of rawDbi.getRange({})) {
					if (typeof recordKey === 'symbol') continue;
					if (versionlessKeys.has(typeof recordKey === 'object' ? JSON.stringify(recordKey) : recordKey)) continue;
					scanned++;
					if (!value || value.length < 8 || value[0] !== 0x42) unprefixed++;
				}
				if (unprefixed > 0) {
					throw new Error(
						`Migration of ${sourceDatabase}/${key} left ${unprefixed} of ${scanned} versioned record(s) without ` +
							`the version/metadata prefix — records would lose versions and prototypes`
					);
				}
			}

			// Persist the canonical v5 classic structures the observer built, so every v5 runtime worker
			// adopts one agreed dictionary on startup instead of minting its own from an empty durable and
			// racing (the structure-id fork that silently nulls records; HarperFast/harper#1453). Written
			// as a plain classic named array — the migrated records self-describe via inline definitions
			// so they do not depend on this, and dropping the v4 typed structs avoids the typed-length
			// mismatch that makes a classic encoder's saveStructures CAS reject (the reload/re-mint churn
			// behind the fork). The runtime reads this composite key via RecordEncoder.getStructures.
			if (isPrimary && canonicalStructures?.length) {
				targetRootStore.transactionSync(
					(txn) => {
						txn.putSync([Symbol.for('structures'), key], canonicalStructures);
					},
					{ retryOnBusy: true }
				);
			}
		}

		// Note: audit store is not migrated because LMDB and RocksDB use fundamentally different
		// audit store formats (LMDB uses a custom binary encoding in a regular DB, RocksDB uses TransactionLog).
		// A new audit store will be created automatically when the RocksDB database is opened.

		await written;

		// Await every blob save that was kicked off during this database's migration. The promises
		// were pushed into pendingBlobSaves by saveBlob (see resources/blob.ts). We must do this
		// BEFORE writing the remote-ids mapping (which signals "this DB is migrated and ready")
		// and BEFORE closing targetRootStore — otherwise any blob whose pipeline hasn't yet
		// flushed will be silently dropped when the store handle goes away.
		if (pendingBlobSaves.length > 0) {
			console.log(`awaiting ${pendingBlobSaves.length} in-flight blob save(s) for ${sourceDatabase}`);
			const results = await Promise.allSettled(pendingBlobSaves);
			const failed = results.filter((r) => r.status === 'rejected');
			if (failed.length > 0) {
				// Fail loudly so migrateOnStart leaves the migration incomplete (LMDB source still
				// in place, migrateOnStart flag retained) and the next start retries. Silently
				// dropping records here is what produced the production missing-blob-files state.
				throw new Error(
					`Migration of ${sourceDatabase} failed: ${failed.length} blob save(s) failed: ` +
						failed
							.slice(0, 5)
							.map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason))
							.join('; ')
				);
			}
		}

		// Preserve the node ID mapping from the LMDB audit store so replication can resume
		// incrementally instead of triggering a full table copy after migration.
		const REMOTE_NODE_IDS_KEY = Symbol.for('remote-ids');
		const idMappingBytes = sourceRootStore.auditStore?.getBinary?.(REMOTE_NODE_IDS_KEY);
		if (idMappingBytes) {
			targetRootStore.putSync(REMOTE_NODE_IDS_KEY, asBinary(idMappingBytes));
		}

		console.log('migrated database ' + sourceDatabase + ' to RocksDB');
	} finally {
		endPendingMigrationBlobSaves();
		// If the migration threw before we awaited pendingBlobSaves above, in-flight save
		// promises in the list have no rejection handler attached. Attach a no-op catch so a
		// later background failure is silently observed instead of crashing the process via
		// Node's unhandledRejection.
		for (const saving of pendingBlobSaves) saving.catch(() => {});
		transaction?.done();
		// Close every target handle (dbi CFs before the root) so no descriptor holds the DB lock
		// on this path — required for the caller's staging-directory rename (harper#2012).
		for (const handle of targetHandles.reverse()) {
			try {
				handle.close();
			} catch (error) {
				console.error('Error closing migration target store', error);
			}
		}
	}

	async function copyDbiToRocks(sourceDbi, targetDbi, isPrimary, transaction, observerEncoder?) {
		let recordsCopied = 0;
		let skippedRecord = 0;
		let firstVersioned;
		// keys (normalized for compound keys) of source records with no version, deliberately
		// encoded plain — the verification sweep exempts them by key, never by byte sniffing
		const versionlessKeys = new Set();
		const MAX_RETRIES = 1000;
		let retries = MAX_RETRIES;
		let start = null;
		while (retries-- > 0) {
			try {
				if (isPrimary) {
					for (const {
						key,
						value,
						version,
						expiresAt: entryExpiresAt,
						nodeId: entryNodeId,
						residencyId: entryResidencyId,
						metadataFlags: entryMetadataFlags,
					} of sourceDbi.getRange({ start, transaction, versions: true })) {
						try {
							start = key;
							if (typeof key === 'symbol') {
								skippedRecord++;
								continue;
							}
							if (value == null) {
								skippedRecord++;
								continue;
							}
							// lastMetadata is set by RecordEncoder.decode for unpatched stores;
							// entry fields are set by handleLocalTimeForGets for patched stores
							const sourceMeta = lastMetadata;
							if (version) {
								setNextEncoding(
									version,
									entryMetadataFlags ?? sourceMeta?.[METADATA] ?? 0,
									entryExpiresAt ?? sourceMeta?.expiresAt ?? -1,
									entryNodeId ?? sourceMeta?.nodeId ?? -1,
									entryResidencyId ?? sourceMeta?.residencyId ?? 0
								);
							} else {
								// A flags-word-only prefix (no leading timestamp) is misparsed by the RocksDB
								// decode heuristic (8 bytes consumed as a timestamp), so a version-less source
								// record must be encoded plain; the read path repairs its prototype (#2012).
								// Cleared even though the plain-encode hook would not consume stale globals:
								// they may have leaked from a prior record whose encode was skipped or threw.
								clearNextEncoding();
								versionlessKeys.add(typeof key === 'object' ? JSON.stringify(key) : key);
							}
							written = encodeBlobsWithFilePath(
								() => targetDbi.put(key, value, version),
								typeof key === 'number' ? key : recordsCopied,
								sourceRootStore
							);
							// Capture the put promise so the tripwire awaits THIS record's write, not
							// an ordering assumption about later puts in the batch.
							if (version) firstVersioned ??= { key, version, written };
							// Feed only the record's SHAPE to the observer so it accumulates the canonical
							// classic structure (key list) for this shape; the encoded output is discarded.
							// A classic/named structure depends only on the keys, so we stub every leaf value
							// to a primitive — critically, this avoids re-reading file-backed Blob values (the
							// real put runs inside encodeBlobsWithFilePath which keeps blobs as file references;
							// a second raw encode here would otherwise readFileSync the full blob into memory
							// just to build the dictionary). Guarded: structure-building must never fail the record.
							if (observerEncoder) {
								try {
									observerEncoder.encode(shapeForStructure(value));
								} catch {}
							}
							recordsCopied++;
							if (transaction.openTimer) transaction.openTimer = 0;
							if (outstandingWrites++ > 5000) {
								await written;
								console.log('migrated', recordsCopied, 'entries, skipped', skippedRecord, 'delete records');
								outstandingWrites = 0;
							}
						} catch (error) {
							console.error(
								'Error migrating record',
								typeof key === 'symbol' ? 'symbol' : key,
								'from',
								sourceDatabase,
								error
							);
						}
					}
				} else {
					for (const { key, value } of sourceDbi.getRange({ start, transaction })) {
						try {
							start = key;
							if (typeof key === 'symbol') {
								continue;
							}
							written = targetDbi.put(key, value);
							recordsCopied++;
							if (transaction.openTimer) transaction.openTimer = 0;
							if (outstandingWrites++ > 5000) {
								await written;
								console.log('migrated', recordsCopied, 'index entries');
								outstandingWrites = 0;
							}
						} catch (error) {
							console.error(
								'Error migrating index record',
								typeof key === 'symbol' ? 'symbol' : key,
								'from',
								sourceDatabase,
								error
							);
						}
					}
				}
				console.log('finish migrating, copied', recordsCopied, 'entries, skipped', skippedRecord, 'delete records');
				return { firstVersioned, versionlessKeys };
			} catch (err) {
				console.error(
					`Error iterating dbi for ${sourceDatabase} near key ${JSON.stringify(start)}, retrying (${retries} retries left):`,
					err
				);
				if (typeof start === 'string') {
					if (start === 'z') {
						console.error('Reached end of dbi', start, 'for', sourceDatabase);
						return;
					}
					start = start.slice(0, -2) + 'z';
				} else if (typeof start === 'number') start++;
				else {
					console.error('Unknown key type', start, 'for', sourceDatabase);
					return;
				}
			}
		}
		// Fail loudly so migrateOnStart's try/catch preserves the migrateOnStart flag and
		// skips moving the LMDB files to backup, instead of leaving a partial copy.
		throw new Error(
			`Migration of ${sourceDatabase} exceeded ${MAX_RETRIES} retries, giving up at key ${JSON.stringify(start)}`
		);
	}
}
