'use strict';

const { Readable } = require('stream');
const { getDatabases } = require('../../../../resources/databases');
const { readSync, openSync, createReadStream } = require('fs');
const { open } = require('lmdb');
const OpenDBIObject = require('../../../../utility/lmdb/OpenDBIObject');
const OpenEnvironmentObject = require('../../../../utility/lmdb/OpenEnvironmentObject');
const { INTERNAL_DBIS_NAME } = require('../../../../utility/lmdb/terms');

module.exports = getBackup;
const META_SIZE = 32768;
const DELAY_ITERATIONS = 100;
/**
 * function execute the read_transaction_log operation
 * @param {GetBackupObject} get_backup_obj
 * @returns {Promise<[]>}
 */
async function getBackup(get_backup_obj) {
	const database_name = get_backup_obj.database || get_backup_obj.schema || 'data';
	const database = getDatabases()[database_name];
	const backup_date = new Date().toISOString();
	let tables = get_backup_obj.tables || (get_backup_obj.table && [get_backup_obj.table]);
	if (tables) {
		// if tables are specified, we have to copy the database with just the specified tables and then stream that
		let table_class = database[tables[0]];
		if (!table_class) throw new Error(`Can not find table ${tables[0]}`);
		// we use the attribute store to drive this process, finding the right stores to duplicate
		let attribute_store = table_class.dbisDB;
		let backup_root = open({ noSync: true, maxDbs: OpenEnvironmentObject.MAX_DBS }); // open a temporary database (this
		// will also cause it to
		// close on completion)
		let resolution;
		let backup_attribute_store = backup_root.openDB(INTERNAL_DBIS_NAME, new OpenDBIObject(false));
		let readTxn = attribute_store.useReadTransaction();
		let i = 0;
		for (let { key, value: attribute_info } of attribute_store.getRange({ transaction: readTxn, start: false })) {
			if (tables.some((table) => key.startsWith?.(table + '/'))) {
				// it is a store we need to copy
				backup_attribute_store.put(key, attribute_info);
				const [, attribute] = key.split('/');
				let is_primary_key = !attribute;
				let options = new OpenDBIObject(!is_primary_key, is_primary_key);
				options.encoding = 'binary'; // directly copy bytes
				let backup_store = backup_root.openDB(key, options);
				let source_store = attribute_store.openDB(key, options);
				for (let { key, version, value } of source_store.getRange({ transaction: readTxn, versions: is_primary_key })) {
					resolution = backup_store.put(key, value, version);
					if (i++ % DELAY_ITERATIONS === 0) await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
		}
		await resolution;
		let stream = createReadStream(backup_root.path);
		stream.headers = getHeaders();
		stream.on('close', () => {
			readTxn.done();
			backup_root.close(); // this should delete it
		});
		return stream;
	}
	const first_table = database[Object.keys(database)[0]];
	const store = first_table.primaryStore;

	let fd = openSync(store.path);
	return store.transaction(() => {
		let metaBuffers = Buffer.alloc(META_SIZE);
		readSync(fd, metaBuffers, 0, META_SIZE); // sync, need to do this as fast as possible since we are in a write txn
		let readTxn = store.useReadTransaction(); // this guarantees the current transaction is preserved in the backup
		// create a file stream that starts after the meta area
		let file_stream = createReadStream(null, { fd, start: META_SIZE });
		let stream = new Readable.from(
			(async function* () {
				yield metaBuffers; // return the meta area that was frozen inside the write transaction
				for await (const chunk of file_stream) {
					yield chunk;
				}
				readTxn.done(); // done with the read txn
			})()
		);
		stream.headers = getHeaders();
		return stream;
	});
	function getHeaders() {
		const headers = new Map();
		headers.set('content-type', 'application/octet-stream');
		headers.set('content-disposition', `attachment; filename="${database_name}"`);
		headers.set('date', backup_date);
		return headers;
	}
}
