'use strict';

const { Readable } = require('stream');
const { getDatabases } = require('../../../../resources/databases.ts');
const { readSync, openSync, createReadStream } = require('fs');
const { open } = require('lmdb');
const { OpenDBIObject } = require('../../../../utility/lmdb/OpenDBIObject.js');
const OpenEnvironmentObject = require('../../../../utility/lmdb/OpenEnvironmentObject.js');
const { AUDIT_STORE_OPTIONS } = require('../../../../resources/auditStore.ts');
const { INTERNAL_DBIS_NAME, AUDIT_STORE_NAME } = require('../../../../utility/lmdb/terms.js');

module.exports = getBackup;
const META_SIZE = 32768;
const DELAY_ITERATIONS = 100;
/**
 * function execute the readTransactionLog operation
 * @param {GetBackupObject} getBackupObj
 * @returns {Promise<[]>}
 */
async function getBackup(getBackupObj) {
	const databaseName = getBackupObj.database || getBackupObj.schema || 'data';
	const database = getDatabases()[databaseName];
	const backupDate = new Date().toISOString();
	let tables = getBackupObj.tables || (getBackupObj.table && [getBackupObj.table]);
	if (tables) {
		// if tables are specified, we have to copy the database with just the specified tables and then stream that
		let tableClass = database[tables[0]];
		if (!tableClass) throw new Error(`Can not find table ${tables[0]}`);
		// we use the attribute store to drive this process, finding the right stores to duplicate
		let attributeStore = tableClass.dbisDB;
		let backupRoot = open({ noSync: true, maxDbs: OpenEnvironmentObject.MAX_DBS }); // open a temporary database (this
		// will also cause it to
		// close on completion)
		let resolution;
		let backupAttributeStore = backupRoot.openDB(INTERNAL_DBIS_NAME, new OpenDBIObject(false));
		let readTxn = attributeStore.useReadTransaction();
		let i = 0;
		const copyDatabase = async function (storeName, options) {
			options.encoding = 'binary'; // directly copy bytes
			options.encoder = undefined;
			let backupStore = backupRoot.openDB(storeName, options);
			let sourceStore = attributeStore.openDB(storeName, options);
			for (let { key, version, value } of sourceStore.getRange({
				start: null,
				transaction: readTxn,
				versions: sourceStore.useVersions,
			})) {
				resolution = backupStore.put(key, value, version);
				if (i++ % DELAY_ITERATIONS === 0) {
					await new Promise((resolve) => setTimeout(resolve, 20));
					if (readTxn.openTimer) readTxn.openTimer = 0; // reset any timer monitoring this
				}
			}
		};
		for (let { key, value: attributeInfo } of attributeStore.getRange({ transaction: readTxn, start: false })) {
			if (tables.some((table) => key.startsWith?.(table + '/'))) {
				// it is a store we need to copy
				backupAttributeStore.put(key, attributeInfo);
				const [, attribute] = key.split('/');
				let isPrimaryKey = !attribute;
				let options = new OpenDBIObject(!isPrimaryKey, isPrimaryKey);
				await copyDatabase(key, options);
			}
		}
		if (getBackupObj.include_audit) {
			await copyDatabase(AUDIT_STORE_NAME, { ...AUDIT_STORE_OPTIONS });
		}
		await resolution;
		let stream = createReadStream(backupRoot.path);
		stream.headers = getHeaders();
		stream.on('close', () => {
			readTxn.done();
			backupRoot.close(); // this should delete it
		});
		return stream;
	}
	const firstTable = database[Object.keys(database)[0]];
	const store = firstTable.primaryStore;

	let fd = openSync(store.path);
	return store.transaction(() => {
		let metaBuffers = Buffer.alloc(META_SIZE);
		readSync(fd, metaBuffers, 0, META_SIZE); // sync, need to do this as fast as possible since we are in a write txn
		store.resetReadTxn(); // make sure we are not using a cached read transaction, force a fresh one
		let readTxn = store.useReadTransaction(); // this guarantees the current transaction is preserved in the backup
		// renew is necessary because normally renew is actually lazily called on the next db operation, but
		// we are not performing any db operations
		readTxn.renew();
		// create a file stream that starts after the meta area
		let fileStream = createReadStream(null, { fd, start: META_SIZE });
		let stream = new Readable.from(
			(async function* () {
				yield metaBuffers; // return the meta area that was frozen inside the write transaction
				for await (const chunk of fileStream) {
					if (readTxn.openTimer) readTxn.openTimer = 0; // reset any timer monitoring this
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
		headers.set('content-disposition', `attachment; filename="${databaseName}"`);
		headers.set('date', backupDate);
		return headers;
	}
}
