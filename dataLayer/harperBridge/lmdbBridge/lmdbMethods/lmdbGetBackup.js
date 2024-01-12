'use strict';

const { Readable } = require('stream');
const { getDatabases } = require('../../../../resources/databases');
const { readSync, openSync, createReadStream } = require('fs');
const { open } = require('lmdb');
const OpenDBIObject = require('../../../../utility/lmdb/OpenDBIObject');
const OpenEnvironmentObject = require('../../../../utility/lmdb/OpenEnvironmentObject');
const { AUDIT_STORE_OPTIONS } = require('../../../../resources/auditStore');
const { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } = require('../../../../utility/lmdb/terms');

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
		let read_txn = attribute_store.useReadTransaction();
		let i = 0;
		const copyDatabase = async function (store_name, options) {
			options.encoding = 'binary'; // directly copy bytes
			options.encoder = undefined;
			let backup_store = backup_root.openDB(store_name, options);
			let source_store = attribute_store.openDB(store_name, options);
			for (let { key, version, value } of source_store.getRange({
				transaction: read_txn,
				versions: source_store.useVersions,
			})) {
				resolution = backup_store.put(key, value, version);
				if (i++ % DELAY_ITERATIONS === 0) {
					await new Promise((resolve) => setTimeout(resolve, 20));
					if (read_txn.openTimer) read_txn.openTimer = 0; // reset any timer monitoring this
				}
			}
		};
		for (let { key, value: attribute_info } of attribute_store.getRange({ transaction: read_txn, start: false })) {
			if (tables.some((table) => key.startsWith?.(table + '/'))) {
				// it is a store we need to copy
				backup_attribute_store.put(key, attribute_info);
				const [, attribute] = key.split('/');
				let is_primary_key = !attribute;
				let options = new OpenDBIObject(!is_primary_key, is_primary_key);
				await copyDatabase(key, options);
			}
		}
		if (get_backup_obj.include_audit) {
			await copyDatabase(AUDIT_STORE_NAME, Object.assign({}, AUDIT_STORE_OPTIONS));
		}
		await resolution;
		let stream = createReadStream(backup_root.path);
		stream.headers = getHeaders();
		stream.on('close', () => {
			read_txn.done();
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
		store.resetReadTxn(); // make sure we are not using a cached read transaction, force a fresh one
		let read_txn = store.useReadTransaction(); // this guarantees the current transaction is preserved in the backup
		// renew is necessary because normally renew is actually lazily called on the next db operation, but
		// we are not performing any db operations
		read_txn.renew();
		// create a file stream that starts after the meta area
		let file_stream = createReadStream(null, { fd, start: META_SIZE });
		let stream = new Readable.from(
			(async function* () {
				yield metaBuffers; // return the meta area that was frozen inside the write transaction
				for await (const chunk of file_stream) {
					if (read_txn.openTimer) read_txn.openTimer = 0; // reset any timer monitoring this
					yield chunk;
				}
				read_txn.done(); // done with the read txn
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
