import { getDatabases, getDefaultCompression, resetDatabases } from '../resources/databases';
import { open } from 'lmdb';
import { join } from 'path';
import { move, remove } from 'fs-extra';
import { get } from '../utility/environment/environmentManager';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
import OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } from '../utility/lmdb/terms';
import { CONFIG_PARAMS, DATABASES_DIR_NAME } from '../utility/hdbTerms';
import { AUDIT_STORE_OPTIONS } from '../resources/auditStore';
import { describeSchema } from '../dataLayer/schemaDescribe';
import { updateConfigValue } from '../config/configUtils';
import * as hdb_logger from '../utility/logging/harper_logger';

export async function compactOnStart() {
	hdb_logger.notify('Running compact on start');
	console.log('Running compact on start');

	// Create compact copy and backup
	const root_path = get(CONFIG_PARAMS.ROOTPATH);
	const compacted_db = new Map();
	const databases = getDatabases();

	updateConfigValue(CONFIG_PARAMS.STORAGE_COMPACTONSTART, false); // don't run this again, and update it before starting so that it fails we don't just keep retrying over and over

	try {
		for (const database_name in databases) {
			if (database_name === 'system') continue;
			if (database_name.endsWith('-copy')) continue; // don't copy the copy
			let db_path;
			for (const table_name in databases[database_name]) {
				db_path = databases[database_name][table_name].primaryStore.path;
				break;
			}
			if (!db_path) {
				console.log("Couldn't find any tables in database", database_name);
				continue;
			}

			const backup_dest = join(root_path, 'backup', database_name + '.mdb');
			const copy_dest = join(root_path, DATABASES_DIR_NAME, database_name + '-copy.mdb');
			let record_count = 0;
			try {
				record_count = await getTotalDBRecordCount(database_name);
				console.log('Database', database_name, 'before compact has a total record count of', record_count);
			} catch (error) {
				hdb_logger.error('Error getting record count for database', database_name, error);
				console.error('Error getting record count for database', database_name, error);
			}
			compacted_db.set(database_name, {
				db_path,
				copy_dest,
				backup_dest,
				record_count,
			});

			await copyDb(database_name, copy_dest);

			console.log('Backing up', database_name, 'to', backup_dest);
			await move(db_path, backup_dest, { overwrite: true });
		}
		try {
			resetDatabases();
		} catch (err) {
			hdb_logger.error('Error resetting databases after backup', err);
			console.error('Error resetting databases after backup', err);
		}
		// Move compacted DB to back to original DB path
		for (const [db, { db_path, copy_dest }] of compacted_db) {
			console.log('Moving copy compacted', db, 'to', db_path);
			await move(copy_dest, db_path, { overwrite: true });
			await remove(join(root_path, DATABASES_DIR_NAME, `${db}-copy.mdb-lock`));
		}

		try {
			resetDatabases();
		} catch (err) {
			hdb_logger.error('Error resetting databases after backup', err);
			console.error('Error resetting databases after backup', err);
			process.exit(0); // just let the process restart
		}
	} catch (err) {
		hdb_logger.error('Error compacting database, rolling back operation', err);
		console.error('Error compacting database, rolling back operation', err);

		updateConfigValue(CONFIG_PARAMS.STORAGE_COMPACTONSTART, false);

		for (const [db, { db_path, backup_dest }] of compacted_db) {
			console.error('Moving backup database', backup_dest, 'back to', db_path);
			try {
				await move(backup_dest, db_path, { overwrite: true });
			} catch (err) {
				console.error(err);
			}
		}
		resetDatabases();

		throw err;
	}

	// Clean up backups
	for (const [db, { backup_dest, record_count }] of compacted_db) {
		let remove_backup = true;
		const compact_record_count = await getTotalDBRecordCount(db);
		console.log('Database', db, 'after compact has a total record count of', compact_record_count);

		if (record_count !== compact_record_count) {
			remove_backup = false;
			const err_msg = `There is a discrepancy between pre and post compact record count for database ${db}.\nTotal record count before compaction: ${record_count}, total after: ${compact_record_count}.\nDatabase backup has not been removed and can be found here: ${backup_dest}`;
			hdb_logger.error(err_msg);
			console.error(err_msg);
		}

		if (get(CONFIG_PARAMS.STORAGE_COMPACTONSTARTKEEPBACKUP) === true || remove_backup === false) continue;
		console.log('Removing backup', backup_dest);
		await remove(backup_dest);
	}
}

async function getTotalDBRecordCount(database: string) {
	const db_describe = await describeSchema({ database });
	let total = 0;
	for (const table in db_describe) {
		total += db_describe[table].record_count;
	}

	return total;
}

// we replace the write functions with a noop during this process, just in case they get called
function noop() {
	// if there are any attempts to write to the db, ignore them
}

export async function copyDb(source_database: string, target_database_path: string) {
	console.log(`Copying database ${source_database} to ${target_database_path}`);
	const source_db = getDatabases()[source_database];
	if (!source_db) throw new Error(`Source database not found: ${source_database}`);
	let root_store;
	for (const table_name in source_db) {
		const table = source_db[table_name];
		// ensure that writes aren't occurring
		table.primaryStore.put = noop;
		table.primaryStore.remove = noop;
		for (const attributeName in table.indices) {
			const index = table.indices[attributeName];
			index.put = noop;
			index.remove = noop;
		}
		table.auditStore.put = noop;
		table.auditStore.remove = noop;
		root_store = table.primaryStore.rootStore;
	}
	if (!root_store) throw new Error(`Source database does not have any tables: ${source_database}`);
	// this contains the list of all the dbis
	const source_dbis_db = root_store.dbisDb;
	const source_audit_store = root_store.auditStore;
	const target_env = open(new OpenEnvironmentObject(target_database_path));
	const target_dbis_db = target_env.openDB(INTERNAL_DBIS_NAME);
	let written;
	let outstanding_writes = 0;
	// we use a single transaction to get a snapshot, also we can't use snapshot: false on dupsort dbs
	const transaction = source_dbis_db.useReadTransaction();
	try {
		for (const { key, value: attribute } of source_dbis_db.getRange({ transaction })) {
			const is_primary = attribute.is_hash_attribute || attribute.isPrimaryKey;
			let existing_compression, new_compression;
			if (is_primary) {
				existing_compression = attribute.compression;
				new_compression = getDefaultCompression();
				if (new_compression) attribute.compression = new_compression;
				else delete attribute.compression;
				if (existing_compression?.dictionary?.toString() === new_compression?.dictionary?.toString()) {
					// no need to change the compression, it's the same, so we can, and should, skip decompressing and recompressing
					existing_compression = null;
					new_compression = null;
				}
			}
			target_dbis_db.put(key, attribute);
			if (!(is_primary || attribute.indexed)) continue;
			const dbi_init = new OpenDBIObject(!is_primary, is_primary);
			// we want to directly copy bytes so we don't have the overhead of
			// encoding and decoding
			dbi_init.encoding = 'binary';
			dbi_init.compression = existing_compression;
			//dbi_init.keyEncoding = 'binary';
			const source_dbi = root_store.openDB(key, dbi_init);
			source_dbi.decoder = null;
			source_dbi.decoderCopies = false;
			source_dbi.encoding = 'binary';
			dbi_init.compression = new_compression;
			const target_dbi = target_env.openDB(key, dbi_init);
			target_dbi.encoder = null;
			console.log('copying', key, 'from', source_database, 'to', target_database_path);
			await copyDbi(source_dbi, target_dbi, is_primary, transaction);
		}
		if (source_audit_store) {
			const target_audit_store = root_store.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
			console.log('copying audit log for', source_database, 'to', target_database_path);
			copyDbi(source_audit_store, target_audit_store, false, transaction);
		}

		async function copyDbi(source_dbi, target_dbi, is_primary, transaction) {
			let records_copied = 0;
			let bytes_copied = 0;
			let retries = 10000000;
			let start = null;
			while (retries-- > 0) {
				try {
					for (const key of source_dbi.getKeys({ start, transaction })) {
						try {
							start = key;
							const { value, version } = source_dbi.getEntry(key, { transaction });
							written = target_dbi.put(key, value, is_primary ? version : undefined);
							records_copied++;
							if (transaction.openTimer) transaction.openTimer = 0; // reset the timer, don't want it to time out
							bytes_copied += (key?.length || 10) + value.length;
							if (outstanding_writes++ > 5000) {
								await written;
								console.log('copied', records_copied, 'entries', bytes_copied, 'bytes');
								outstanding_writes = 0;
							}
						} catch (error) {
							console.error(
								'Error copying record',
								typeof key === 'symbol' ? 'symbol' : key,
								'from',
								source_database,
								'to',
								target_database_path,
								error
							);
						}
					}
					console.log('finish copying, copied', records_copied, 'entries', bytes_copied, 'bytes');
					return;
				} catch (error) {
					// try to resume with a bigger key
					if (typeof start === 'string') {
						if (start === 'z') {
							return console.error('Reached end of dbi', start, 'for', source_database, 'to', target_database_path);
						}
						start = start.slice(0, -2) + 'z';
					} else if (typeof start === 'number') start++;
					else return console.error('Unknown key type', start, 'for', source_database, 'to', target_database_path);
				}
			}
		}

		await written;
		console.log('copied database ' + source_database + ' to ' + target_database_path);
	} finally {
		transaction.done();
		target_env.close();
	}
}
