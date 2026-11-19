import { randomBytes } from 'node:crypto';

const DATABASE = 'backup_flush';
const BLOB_BYTES = 64 * 1024; // over the file-storage threshold, so the blob is a file of its own

export class BackupFlushOps extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		// Looked up per request: a table reference kept across requests would hold the database open
		// through an online restore_backup.
		const table = databases[DATABASE][body.table];
		switch (body?.action) {
			case 'putBlob':
				await table.put({ id: body.id, data: createBlob(randomBytes(BLOB_BYTES)) });
				return { ok: true };
			case 'evict': {
				const entry = table.primaryStore.getEntry(body.id);
				await table.evict(body.id, entry.value, entry.version);
				return { evicted: table.primaryStore.getEntry(body.id) === undefined };
			}
			case 'blobSize': {
				const record = await table.get(body.id);
				return { size: record?.data ? (await record.data.bytes()).length : null };
			}
			default:
				throw new Error(`unknown action ${body?.action}`);
		}
	}
}
