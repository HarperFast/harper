import { getDatabases, getDefaultCompression, resetDatabases } from '../resources/databases.ts';
import { open } from 'lmdb';
import { join } from 'path';
import { move, remove } from 'fs-extra';
import { get } from '../utility/environment/environmentManager.js';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject.js';
import OpenDBIObject from '../utility/lmdb/OpenDBIObject.js';
import { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } from '../utility/lmdb/terms.js';
import { CONFIG_PARAMS, DATABASES_DIR_NAME } from '../utility/hdbTerms.ts';
import { AUDIT_STORE_OPTIONS } from '../resources/auditStore.ts';
import { describeSchema } from '../dataLayer/schemaDescribe.js';
import { updateConfigValue } from '../config/configUtils.js';
import * as hdbLogger from '../utility/logging/harper_logger.js';

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
		}
		try {
			resetDatabases();
		} catch (err) {
			hdbLogger.error('Error resetting databases after backup', err);
			console.error('Error resetting databases after backup', err);
		}
		// Move compacted DB to back to original DB path
		for (const [db, { dbPath, copyDest }] of compactedDb) {
			console.log('Moving copy compacted', db, 'to', dbPath);
			await move(copyDest, dbPath, { overwrite: true });
			await remove(join(rootPath, DATABASES_DIR_NAME, `${db}-copy.mdb-lock`));
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

		for (const [db, { dbPath, backupDest }] of compactedDb) {
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
		let removeBackup = true;
		const compactRecordCount = await getTotalDBRecordCount(db);
		console.log('Database', db, 'after compact has a total record count of', compactRecordCount);

		if (recordCount !== compactRecordCount) {
			removeBackup = false;
			const errMsg = `There is a discrepancy between pre and post compact record count for database ${db}.\nTotal record count before compaction: ${recordCount}, total after: ${compactRecordCount}.\nDatabase backup has not been removed and can be found here: ${backupDest}`;
			hdbLogger.error(errMsg);
			console.error(errMsg);
		}

		if (get(CONFIG_PARAMS.STORAGE_COMPACTONSTARTKEEPBACKUP) === true || removeBackup === false) continue;
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

export async function copyDb(sourceDatabase: string, targetDatabasePath: string) {
	console.log('copyDb start');
	const sourceDb = getDatabases()[sourceDatabase];
	let rootStore;
	for (const tableName in sourceDb) {
		rootStore = sourceDb[tableName].primaryStore.rootStore;
		break;
	}
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
			const isPrimary = attribute.is_hash_attribute || attribute.isPrimaryKey;
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
			let retries = 10000000;
			let start = null;
			while (retries-- > 0) {
				try {
					for (const key of sourceDbi.getKeys({ start, transaction })) {
						try {
							start = key;
							const { value, version } = sourceDbi.getEntry(key, { transaction });
							written = targetDbi.put(key, value, isPrimary ? version : undefined);
							recordsCopied++;
							if (transaction.openTimer) transaction.openTimer = 0; // reset the timer, don't want it to time out
							bytesCopied += (key?.length || 10) + value.length;
							if (outstandingWrites++ > 5000) {
								await written;
								console.log('copied', recordsCopied, 'entries', bytesCopied, 'bytes');
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
					console.log('finish copying, copied', recordsCopied, 'entries', bytesCopied, 'bytes');
					return;
				} catch (error) {
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
