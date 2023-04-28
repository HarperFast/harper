'use strict';

const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const { Readable } = require('stream');
const { getBaseSchemaPath } = require('../lmdbUtility/initializePaths');
const path = require('path');
const { readSync, openSync, createReadStream } = require('fs');

module.exports = getBackup;
const META_SIZE = 32768;
/**
 * function execute the read_transaction_log operation
 * @param {GetBackupObject} get_backup_obj
 * @returns {Promise<[]>}
 */
async function getBackup(get_backup_obj) {
	let env_base_path = path.join(getBaseSchemaPath(), get_backup_obj.schema.toString());
	let env = await environment_utility.openEnvironment(env_base_path, get_backup_obj.table);
	let fd = openSync(env.path);
	const backup_date = new Date().toISOString();
	return env.transaction(() => {
		let metaBuffers = Buffer.alloc(META_SIZE);
		readSync(fd, metaBuffers, 0, META_SIZE); // sync, need to do this as fast as possible since we are in a write txn
		let readTxn = env.useReadTransaction(); // this guarantees the current transaction is preserved in the backup
		// create a file stream that starts after the meta area
		let fileStream = createReadStream(null, { fd, start: META_SIZE });
		let stream = new Readable.from(
			(async function* () {
				yield metaBuffers; // return the meta area that was frozen inside the write transaction
				for await (const chunk of fileStream) {
					yield chunk;
				}
				readTxn.done(); // done with the read txn
			})()
		);
		stream.headers = new Map();
		stream.headers.set('content-type', 'application/octet-stream');
		stream.headers.set('content-disposition', `attachment; filename="${get_backup_obj.table}"`);
		stream.headers.set('date', backup_date);
		return stream;
	});
}
