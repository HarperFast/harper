'use strict';
const { existsSync } = require('node:fs');
const { table, database, closeLoadedDatabases } = require('#src/resources/databases');
const { createBlob, getFilePathForBlob, isSaving } = require('#src/resources/blob');
const { readBackupPins, unpinBackup } = require('#src/dataLayer/backupRepository');
const { beginRestore, completeRestore, restoringMarkerPath } = require('#src/dataLayer/restoreMarker');
const {
	readRestoreReceipt,
	removeRestoreReceipt,
	removeUnreadableRestoreReceipt,
	restoreReceiptPath,
} = require('#src/dataLayer/restoreReceipt');
const { restorePinId } = require('#src/dataLayer/rocksdbBackup');

// A restore proves what it publishes is a Harper database — table catalogue, the table's column
// families, an audit log a strict replay accepts — so its fixtures are written through the Table API.
const RECORDS_TABLE = 'Records';
// over the file-storage threshold, so the blob is a file a backup snapshots rather than inline bytes
const BLOB_BYTES = 128 * 1024;

function recordsTable(databaseName) {
	return table({
		table: RECORDS_TABLE,
		database: databaseName,
		audit: true,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'blob', type: 'Blob' },
		],
	});
}

/**
 * Writes the records, then closes every database in this process, as a stopped server leaves them: the
 * restore child probes RocksDB's LOCK from another process and refuses a database still open here, and
 * the first declaration's scan opens every database under the storage path, not only this one.
 * `flush` moves the rows into table files, for a test that damages one in the backup.
 */
async function writeRecords(databaseName, records, { flush = false } = {}) {
	const Records = recordsTable(databaseName);
	// a copy: put stamps the primary key onto the object it is given
	for (const [id, value] of records) await Records.put(id, { ...value });
	if (flush) await Records.primaryStore.flush();
	await closeLoadedDatabases();
}

/** Writes a record holding a file-backed blob; resolves to the blob's file path once it is saved. */
async function writeBlobRecord(databaseName, id, text) {
	const Records = recordsTable(databaseName);
	const blob = createBlob(Buffer.from(text.padEnd(BLOB_BYTES, '.')));
	await Records.put(id, { blob });
	await isSaving(blob);
	const path = getFilePathForBlob(blob);
	await closeLoadedDatabases();
	return path;
}

/** The record as the database a restore published loads it, without its primary key; undefined when absent. */
async function readRecord(databaseName, id) {
	const Records = recordsTable(databaseName);
	try {
		const record = await Records.get(id);
		if (record == null) return undefined;
		const { id: _id, ...value } = record;
		return value;
	} finally {
		await closeLoadedDatabases();
	}
}

/**
 * Declares an index in the table catalogue whose column family the database does not have — what a
 * catalogue that outlived its family looks like. A backup taken now verifies (every file it holds is
 * readable), but the restore's proof refuses it after the purge, which makes it a real fault in the
 * destructive phase.
 */
async function declareIndexWithoutFamily(databaseName) {
	recordsTable(databaseName);
	database({ database: databaseName, table: RECORDS_TABLE }).dbisDb.putSync(`${RECORDS_TABLE}/unbacked`, {
		name: 'unbacked',
		indexed: true,
	});
	await closeLoadedDatabases();
}

/** What a restore left on a target and its repository: the marker, the receipt, and the target's pin. */
function restoreDebris(databaseDir, backupDir) {
	const debris = [];
	if (existsSync(restoringMarkerPath(databaseDir))) debris.push('marker');
	const receipt = readRestoreReceipt(databaseDir);
	if (receipt.kind !== 'absent') debris.push(`receipt (${receipt.receipt?.state ?? receipt.reason})`);
	if (backupDir && readBackupPins(backupDir).some((pin) => pin.pin_id === restorePinId(databaseDir)))
		debris.push('pin');
	return debris;
}

/** Removes whatever `restoreDebris` reports, so a test that fails part-way cannot block the next one. */
function clearRestoreDebris(databaseDir, backupDir) {
	if (existsSync(restoringMarkerPath(databaseDir)) || existsSync(restoreReceiptPath(databaseDir))) {
		const lock = beginRestore(databaseDir);
		try {
			const read = readRestoreReceipt(databaseDir);
			if (read.kind === 'valid') removeRestoreReceipt(lock, read.receipt.operation_id);
			else if (read.kind === 'unreadable') removeUnreadableRestoreReceipt(lock);
		} finally {
			completeRestore(lock);
		}
	}
	if (backupDir && readBackupPins(backupDir).some((pin) => pin.pin_id === restorePinId(databaseDir)))
		unpinBackup(backupDir, restorePinId(databaseDir));
}

module.exports = {
	RECORDS_TABLE,
	clearRestoreDebris,
	declareIndexWithoutFamily,
	readRecord,
	restoreDebris,
	writeBlobRecord,
	writeRecords,
};
