// Regression test for HarperFast/harper#857.
//
// copyDbToRocks (the v4 LMDB -> v5 RocksDB migration) opens the source LMDB primary dbi with a
// RecordEncoder but never assigns `rootStore` to that encoder. Decoding a source record that holds a
// file-backed blob reference therefore runs with no store context, the Blob msgpackr extension throws
// "No store specified, cannot load blob from storage", RecordEncoder.decode swallows the error and
// yields null, and the record is silently skipped during migration -- so every record with a
// file-backed blob is lost on upgrade.
const fs = require('fs-extra');
const assert = require('assert');
const path = require('path');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { getFilePathForBlob } = require('#src/resources/blob');
const { randomBytes } = require('crypto');

// Migration only applies to LMDB sources, so this only runs under the lmdb engine.
describe('Blob migration LMDB -> RocksDB (#857)', function () {
	// Match the engine resolution in resources/databases.ts (env var wins over config).
	if ((process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb') return;
	const { setupTestDBPath } = require('../testUtils');
	const copyDB = require('#src/bin/copyDb');
	const { RocksDatabase } = require('@harperfast/rocksdb-js');

	let BlobMig;
	let rootPath;
	let targetPath;
	let fileBackedBlobPath;
	const blobBytes = randomBytes(25000); // > FILE_STORAGE_THRESHOLD so the blob is stored as a file reference
	const plainBytes = randomBytes(100); // < threshold so it is inlined in the record (control)

	before(async function () {
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		BlobMig = table({
			table: 'BlobMig',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
		const fileBackedBlob = await createBlob(blobBytes);
		await BlobMig.put({ id: 1, blob: fileBackedBlob }); // file-backed blob (stored as a separate file)
		await BlobMig.put({ id: 2, blob: await createBlob(plainBytes) }); // inlined blob
		await BlobMig.put({ id: 3, blob: null }); // no blob (control)
		await fileBackedBlob.written; // the blob file is written asynchronously; wait so the on-disk content assertion is deterministic
		// Blob file paths are derived from <hdbBasePath>/blobs/<databaseName>, independent of the storage
		// engine, so the migrated RocksDB record reuses this exact file and reads the same content.
		fileBackedBlobPath = getFilePathForBlob(fileBackedBlob);

		targetPath = path.join(rootPath, 'rocks-migrated', 'test');
		await fs.remove(targetPath);
		await copyDB.copyDbToRocks(BlobMig.primaryStore.rootStore, 'test', targetPath);
	});

	after(async function () {
		await fs.remove(path.join(rootPath, 'rocks-migrated'));
	});

	it('migrates records that contain a file-backed blob instead of dropping them', function () {
		const primaryCF = RocksDatabase.open(targetPath, {
			name: 'BlobMig/',
			sharedStructuresKey: Symbol.for('structures'),
		});
		try {
			const keys = [...primaryCF.getKeys()].filter((k) => typeof k !== 'symbol');
			assert(keys.includes(1), `record 1 (file-backed blob) must survive migration; migrated keys: ${keys}`);
			assert(keys.includes(2), `record 2 (inlined blob) must survive migration; migrated keys: ${keys}`);
			assert(keys.includes(3), `record 3 (no blob) must survive migration; migrated keys: ${keys}`);
		} finally {
			primaryCF.close();
		}
	});

	it('preserves the file-backed blob content the migrated record points at', function () {
		assert(fs.existsSync(fileBackedBlobPath), `blob file ${fileBackedBlobPath} must still exist after migration`);
		const HEADER_SIZE = 8; // blob files are prefixed with an 8-byte size/type header
		const stored = fs.readFileSync(fileBackedBlobPath).subarray(HEADER_SIZE);
		assert(stored.equals(blobBytes), 'migrated blob content must match the original bytes');
	});
});
