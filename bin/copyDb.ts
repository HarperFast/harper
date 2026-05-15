import { getDatabases, getDefaultCompression, resetDatabases } from '../resources/databases.ts';
import { open, asBinary } from 'lmdb';
import { join } from 'path';
import { move, remove } from 'fs-extra';
import { existsSync, mkdirSync } from 'node:fs';
import { get } from '../utility/environment/environmentManager.js';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject.js';
import { OpenDBIObject } from '../utility/lmdb/OpenDBIObject.js';
import { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } from '../utility/lmdb/terms.js';
import { CONFIG_PARAMS, DATABASES_DIR_NAME } from '../utility/hdbTerms.ts';
import { AUDIT_STORE_OPTIONS } from '../resources/auditStore.ts';
import { describeSchema } from '../dataLayer/schemaDescribe.js';
import { updateConfigValue } from '../config/configUtils.js';
import * as hdbLogger from '../utility/logging/harper_logger.js';
import { RocksDatabase, type RocksDatabaseOptions } from '@harperfast/rocksdb-js';
import { RocksIndexStore } from '../resources/RocksIndexStore.ts';
import { encodeBlobsWithFilePath } from '../resources/blob.ts';
import { RecordEncoder, setNextEncoding, lastMetadata, METADATA } from '../resources/RecordEncoder.ts';

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
			let dbPath;
			for (const tableName in databases[databaseName]) {
				dbPath = databases[databaseName][tableName].primaryStore.path;
				break;
			}
			if (!dbPath) {
				console.log("Couldn't find any tables in database", databaseName);
				continue;
			}

			const backupDest = join(rootPath, 'backup', databaseName + '.mdb');
			const copyDest = join(rootPath, DATABASES_DIR_NAME, databaseName + '-copy.mdb');
			let recordCount = 0;
			try {
				recordCount = await getTotalDBRecordCount(databaseName);
				console.log('Database', databaseName, 'before compact has a total record count of', recordCount);
			} catch (error) {
				hdbLogger.error('Error getting record count for database', databaseName, error);
				console.error('Error getting record count for database', databaseName, error);
			}
			compactedDb.set(databaseName, {
				dbPath,
				copyDest,
				backupDest,
				recordCount,
			});

			await copyDb(databaseName, copyDest);

			console.log('Backing up', databaseName, 'to', backupDest);
			try {
				await move(dbPath, backupDest, { overwrite: true });
			} catch (error) {
				console.log('Error moving database', dbPath, 'to', backupDest, error);
			}
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

		for (const [_db, { dbPath, backupDest }] of compactedDb) {
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

export async function copyDb(sourceDatabase: string, targetDatabasePath: string) {
	console.log(`Copying database ${sourceDatabase} to ${targetDatabasePath}`);
	const sourceDb = getDatabases()[sourceDatabase];
	if (!sourceDb) throw new Error(`Source database not found: ${sourceDatabase}`);
	let rootStore;
	for (const tableName in sourceDb) {
		const table = sourceDb[tableName];
		// ensure that writes aren't occurring
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
	if (!rootStore) throw new Error(`Source database does not have any tables: ${sourceDatabase}`);
	// this contains the list of all the dbis
	const sourceDbisDb = rootStore.dbisDb;
	const sourceAuditStore = rootStore.auditStore;
	const targetEnv = open(new OpenEnvironmentObject(targetDatabasePath));
	const targetDbisDb = targetEnv.openDB(INTERNAL_DBIS_NAME);
	let written;
	let outstandingWrites = 0;
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
			const sourceDbi = rootStore.openDB(key, dbiInit);
			sourceDbi.decoder = null;
			sourceDbi.decoderCopies = false;
			sourceDbi.encoding = 'binary';
			dbiInit.compression = newCompression;
			const targetDbi = targetEnv.openDB(key, dbiInit);
			targetDbi.encoder = null;
			console.log('copying', key, 'from', sourceDatabase, 'to', targetDatabasePath);
			await copyDbi(sourceDbi, targetDbi, isPrimary, transaction);
		}
		if (sourceAuditStore) {
			const targetAuditStore = rootStore.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
			console.log('copying audit log for', sourceDatabase, 'to', targetDatabasePath);
			copyDbi(sourceAuditStore, targetAuditStore, false, transaction);
		}

		async function copyDbi(sourceDbi, targetDbi, isPrimary, transaction) {
			let recordsCopied = 0;
			let bytesCopied = 0;
			let skippedRecord = 0;
			let retries = 10000000;
			let start = null;
			while (retries-- > 0) {
				try {
					for (const key of sourceDbi.getKeys({ start, transaction })) {
						try {
							start = key;
							const { value, version } = sourceDbi.getEntry(key, { transaction });
							// deleted entries should be 13 bytes long (8 for timestamp, 4 bytes for flags, 1 byte of the encoding of null)
							if (value?.length < 14 && isPrimary) {
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
							console.error(
								'Error copying record',
								typeof key === 'symbol' ? 'symbol' : key,
								'from',
								sourceDatabase,
								'to',
								targetDatabasePath,
								error
							);
						}
					}
					console.log(
						'finish copying, copied',
						recordsCopied,
						'entries, skipped',
						skippedRecord,
						'delete records,',
						bytesCopied,
						'bytes'
					);
					return;
				} catch {
					// try to resume with a bigger key
					if (typeof start === 'string') {
						if (start === 'z') {
							return console.error('Reached end of dbi', start, 'for', sourceDatabase, 'to', targetDatabasePath);
						}
						start = start.slice(0, -2) + 'z';
					} else if (typeof start === 'number') start++;
					else return console.error('Unknown key type', start, 'for', sourceDatabase, 'to', targetDatabasePath);
				}
			}
		}

		await written;
		console.log('copied database ' + sourceDatabase + ' to ' + targetDatabasePath);
	} finally {
		transaction.done();
		targetEnv.close();
	}
}

function openRocksDb(path: string, options: RocksDatabaseOptions & { dupSort?: boolean } = {}) {
	options.disableWAL ??= false;
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
	let db;
	if (options.dupSort) {
		db = new RocksIndexStore(path, options).open();
	} else {
		db = RocksDatabase.open(path, options);
		db.encoder.name = options.name;
	}
	return db;
}

export async function migrateOnStart() {
	hdbLogger.notify('Running migrate on start (LMDB to RocksDB)');
	console.log('Running migrate on start (LMDB to RocksDB)');

	const rootPath = get(CONFIG_PARAMS.ROOTPATH);
	const databases = getDatabases();

	updateConfigValue(CONFIG_PARAMS.STORAGE_MIGRATEONSTART, false);

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

			await copyDbToRocks(rootStore, databaseName, targetPath);

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

async function copyDbToRocks(sourceRootStore, sourceDatabase: string, targetPath: string) {
	console.log(`Migrating database ${sourceDatabase} to RocksDB at ${targetPath}`);
	const sourceDbisDb = sourceRootStore.dbisDb;

	const targetRootStore = openRocksDb(targetPath, { disableWAL: false });
	const targetDbisDb = openRocksDb(targetPath, {
		disableWAL: false,
		name: INTERNAL_DBIS_NAME,
	});

	const STRUCTURES_KEY = Symbol.for('structures');
	const copyStructures = (sourceDbi, storeName: string) => {
		const buffer = sourceDbi.getBinary?.(STRUCTURES_KEY);
		if (buffer) {
			targetRootStore.putSync([STRUCTURES_KEY, storeName], asBinary(buffer));
		}
	};

	copyStructures(sourceDbisDb, INTERNAL_DBIS_NAME);

	let written;
	let outstandingWrites = 0;
	const transaction = sourceDbisDb.useReadTransaction();
	try {
		for (const { key, value: attribute } of sourceDbisDb.getRange({ transaction })) {
			const isPrimary = attribute.isPrimaryKey;
			targetDbisDb.put(key, attribute);
			if (!(isPrimary || attribute.indexed)) continue;

			// Open source LMDB dbi with default encoding so values are decoded
			const dbiInit = new OpenDBIObject(!isPrimary, isPrimary);
			const sourceDbi = sourceRootStore.openDB(key, dbiInit);

			let targetDbi;
			if (!isPrimary) {
				targetDbi = openRocksDb(targetPath, { dupSort: true, name: key });
			} else {
				targetDbi = openRocksDb(targetPath, { name: key });
				// Patch the existing encoder (encoder is a getter-only property on RocksDatabase, cannot be replaced)
				// to install RecordEncoder's encode method so metadata headers (timestamps, HAS_BLOBS flag) are written
				const existingEncoder = targetDbi.encoder as any;
				existingEncoder.isRocksDB = true;
				existingEncoder.rootStore = targetRootStore;
				const tempEncoder = new RecordEncoder({ name: key }) as any;
				existingEncoder.encode = tempEncoder.encode;
				existingEncoder.saveStructures = tempEncoder.saveStructures;
				existingEncoder.getStructures = tempEncoder.getStructures;
			}

			copyStructures(sourceDbi, key);

			console.log('migrating', key, 'from', sourceDatabase, 'to RocksDB');
			await copyDbiToRocks(sourceDbi, targetDbi, isPrimary, transaction);
		}

		// Note: audit store is not migrated because LMDB and RocksDB use fundamentally different
		// audit store formats (LMDB uses a custom binary encoding in a regular DB, RocksDB uses TransactionLog).
		// A new audit store will be created automatically when the RocksDB database is opened.

		await written;

		// Preserve the node ID mapping from the LMDB audit store so replication can resume
		// incrementally instead of triggering a full table copy after migration.
		const REMOTE_NODE_IDS_KEY = Symbol.for('remote-ids');
		const idMappingBytes = sourceRootStore.auditStore?.getBinary?.(REMOTE_NODE_IDS_KEY);
		if (idMappingBytes) {
			targetRootStore.putSync(REMOTE_NODE_IDS_KEY, asBinary(idMappingBytes));
		}

		console.log('migrated database ' + sourceDatabase + ' to RocksDB');
	} finally {
		transaction.done();
		targetRootStore.close();
	}

	async function copyDbiToRocks(sourceDbi, targetDbi, isPrimary, transaction) {
		let recordsCopied = 0;
		let skippedRecord = 0;
		let retries = 1000000;
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
							setNextEncoding(
								version,
								entryMetadataFlags ?? sourceMeta?.[METADATA] ?? 0,
								entryExpiresAt ?? sourceMeta?.expiresAt ?? -1,
								entryNodeId ?? sourceMeta?.nodeId ?? -1,
								entryResidencyId ?? sourceMeta?.residencyId ?? 0
							);
							written = encodeBlobsWithFilePath(
								() => targetDbi.put(key, value, version),
								typeof key === 'number' ? key : recordsCopied,
								sourceRootStore
							);
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
				return;
			} catch {
				if (typeof start === 'string') {
					if (start === 'z') {
						return console.error('Reached end of dbi', start, 'for', sourceDatabase);
					}
					start = start.slice(0, -2) + 'z';
				} else if (typeof start === 'number') start++;
				else return console.error('Unknown key type', start, 'for', sourceDatabase);
			}
		}
	}
}
