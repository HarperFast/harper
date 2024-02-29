import { getDatabases, getDefaultCompression } from '../resources/databases';
import { open } from 'lmdb';
import OpenEnvironmentObject from '../utility/lmdb/OpenEnvironmentObject';
import OpenDBIObject from '../utility/lmdb/OpenDBIObject';
import { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } from '../utility/lmdb/terms';
import { AUDIT_STORE_OPTIONS } from '../resources/auditStore';

export async function copyDb(source_database: string, target_database_path: string) {
	console.log('copyDb start');
	const source_db = getDatabases()[source_database];
	let root_store;
	for (const table_name in source_db) {
		root_store = source_db[table_name].primaryStore.rootStore;
		break;
	}
	// this contains the list of all the dbis
	const source_dbis_db = root_store.dbisDb;
	let source_audit_store = root_store.auditStore;
	const target_env = open(new OpenEnvironmentObject(target_database_path));
	const target_dbis_db = target_env.openDB(INTERNAL_DBIS_NAME);
	let written;
	let outstanding_writes = 0;
	for (const { key, value: attribute } of source_dbis_db.getRange({})) {
		target_dbis_db.put(key, attribute);
		const is_primary = attribute.is_hash_attribute || attribute.isPrimaryKey;
		if (!(is_primary || attribute.indexed)) continue;
		const dbi_init = new OpenDBIObject(!is_primary, is_primary);
		// we want to directly copy bytes so we don't have the overhead of
		// encoding and decoding
		dbi_init.encoding = 'binary';
		//dbi_init.keyEncoding = 'binary';
		const source_dbi = root_store.openDB(key, dbi_init);
		source_dbi.decoder = null;
		const target_dbi = target_env.openDB(key, dbi_init);
		target_dbi.encoder = null;
		target_dbi.compression = getDefaultCompression();
		console.log('copying', key, 'from', source_database, 'to', target_database_path);
		await copyDbi(source_dbi, target_dbi, is_primary);
	}
	const target_audit_store = root_store.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
	console.log('copying audit log');
	copyDbi(source_audit_store, target_audit_store, false);
	async function copyDbi(source_dbi, target_dbi, is_primary) {
		let records_copied = 0;
		let bytes_copied = 0;
		for (const { key, value, version } of source_dbi.getRange({ start: null, versions: is_primary })) {
			written = target_dbi.put(key, value, version);
			records_copied++;
			bytes_copied += (key.length || 10) + value.length;
			if (outstanding_writes++ > 5000) {
				await written;
				console.log('copied', records_copied, 'entries', bytes_copied, 'bytes');
				outstanding_writes = 0;
			}
		}
		console.log('finish copying, copied', records_copied, 'entries', bytes_copied, 'bytes');
	}
	await written;
	console.log('copied all dbis', JSON.stringify(target_env.getStats(), null, 2));
	target_env.close();
	console.log('copyDb end');
}
