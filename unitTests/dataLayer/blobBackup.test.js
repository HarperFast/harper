'use strict';

const assert = require('node:assert');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
	blobSnapshotDir,
	snapshotBlobs,
	restoreBlobSnapshot,
	deleteBlobSnapshot,
	purgeBlobSnapshots,
} = require('#src/dataLayer/blobBackup');

// Lay out a blob root the way resources/blob.ts does: files nested a few directories deep by id.
function writeBlob(root, relPath, contents) {
	const full = join(root, relPath);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, contents);
	return full;
}

describe('blobBackup', function () {
	let tempDir;
	let backupDir;
	let rootA;
	let rootB;

	beforeEach(function () {
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.blob-backup-'));
		backupDir = join(tempDir, 'backup');
		rootA = join(tempDir, 'blobs-a');
		rootB = join(tempDir, 'blobs-b');
	});

	afterEach(function () {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe('snapshotBlobs', function () {
		it('captures every blob file across multiple roots, preserving structure by root index', async function () {
			writeBlob(rootA, '001/002/003', 'alpha');
			writeBlob(rootA, '001/002/004', 'beta');
			writeBlob(rootB, '005/006/007', 'gamma');

			await snapshotBlobs(backupDir, 1, [rootA, rootB]);

			const snap = blobSnapshotDir(backupDir, 1);
			assert.strictEqual(readFileSync(join(snap, '0', '001/002/003'), 'utf8'), 'alpha');
			assert.strictEqual(readFileSync(join(snap, '0', '001/002/004'), 'utf8'), 'beta');
			assert.strictEqual(readFileSync(join(snap, '1', '005/006/007'), 'utf8'), 'gamma');
		});

		it('hard-links files when possible (same inode, no extra space) on the same filesystem', async function () {
			const src = writeBlob(rootA, '001/002/003', 'shared');
			await snapshotBlobs(backupDir, 1, [rootA]);
			const snapFile = join(blobSnapshotDir(backupDir, 1), '0', '001/002/003');
			assert.strictEqual(statSync(src).ino, statSync(snapFile).ino, 'expected a hard link (identical inode)');
		});

		it('is atomic: a snapshot dir either fully exists or not (temp dir is renamed into place)', async function () {
			writeBlob(rootA, '001/002/003', 'alpha');
			await snapshotBlobs(backupDir, 7, [rootA]);
			assert.ok(existsSync(blobSnapshotDir(backupDir, 7)));
			// no leftover temp directory
			assert.ok(!existsSync(join(backupDir, 'blobs', '.tmp-7')));
		});

		it('handles a database with no blobs yet (missing roots) without error', async function () {
			await snapshotBlobs(backupDir, 1, [rootA]);
			// an empty snapshot dir is created; restoring it just clears the target
			assert.ok(existsSync(blobSnapshotDir(backupDir, 1)));
		});

		it('writes a README documenting the layout and the root-index mapping', async function () {
			writeBlob(rootA, '001/002/003', 'alpha');
			await snapshotBlobs(backupDir, 1, [rootA, rootB]);
			const readme = readFileSync(join(backupDir, 'blobs', 'README.md'), 'utf8');
			assert.match(readme, /<backupId>\/<rootIndex>\/<shard1>\/<shard2>\/<fileId>/);
			assert.match(readme, /storage\.blobPaths/);
			assert.ok(readme.includes(`0 -> ${rootA}`), 'root index 0 must map to the first root');
			assert.ok(readme.includes(`1 -> ${rootB}`), 'root index 1 must map to the second root');
		});
	});

	describe('restoreBlobSnapshot', function () {
		it('restores blobs exactly: a blob deleted after the backup returns, one added after it is dropped', async function () {
			// Harper blobs are content-addressed: each write is a new fileId (new path) and a delete
			// unlinks the path — so mutation after a backup is add/remove of distinct paths, not an
			// in-place overwrite. Restore must bring back a deleted blob and drop a newly-added one.
			writeBlob(rootA, '001/002/003', 'original');
			await snapshotBlobs(backupDir, 1, [rootA]);

			rmSync(join(rootA, '001/002/003')); // blob deleted after the backup
			writeBlob(rootA, '009/009/009', 'added-after-backup'); // blob added after the backup

			await restoreBlobSnapshot(backupDir, 1, 'testdb', [rootA]);

			assert.strictEqual(
				readFileSync(join(rootA, '001/002/003'), 'utf8'),
				'original',
				'a blob deleted after the backup must be restored'
			);
			assert.ok(!existsSync(join(rootA, '009/009/009')), 'a blob added after the backup must not survive the restore');
		});

		it('restores each root back to its original index', async function () {
			writeBlob(rootA, 'a/a/a', 'from-a');
			writeBlob(rootB, 'b/b/b', 'from-b');
			await snapshotBlobs(backupDir, 1, [rootA, rootB]);
			rmSync(rootA, { recursive: true, force: true });
			rmSync(rootB, { recursive: true, force: true });

			await restoreBlobSnapshot(backupDir, 1, 'testdb', [rootA, rootB]);

			assert.strictEqual(readFileSync(join(rootA, 'a/a/a'), 'utf8'), 'from-a');
			assert.strictEqual(readFileSync(join(rootB, 'b/b/b'), 'utf8'), 'from-b');
		});

		it('rejects (without purging) a backup with more blob roots than the current config', async function () {
			writeBlob(rootA, 'a/a/a', 'from-a');
			writeBlob(rootB, 'b/b/b', 'from-b');
			await snapshotBlobs(backupDir, 1, [rootA, rootB]); // captured with two roots

			// restoring into a single-root configuration would mis-address root-index-1 blobs
			writeBlob(rootA, 'existing/1/2', 'preexisting');
			await assert.rejects(
				restoreBlobSnapshot(backupDir, 1, 'testdb', [rootA]),
				(error) => error.statusCode === 400 && /blob root/.test(error.message)
			);
			// the single root must not have been purged before the rejection
			assert.strictEqual(
				readFileSync(join(rootA, 'existing/1/2'), 'utf8'),
				'preexisting',
				'a rejected restore must not purge the blob root'
			);
		});

		it('leaves live blobs untouched when the backup has no blob snapshot (engine-only backup)', async function () {
			writeBlob(rootA, '001/002/003', 'live');
			// no snapshotBlobs call for backup 2
			await restoreBlobSnapshot(backupDir, 2, 'testdb', [rootA]);
			assert.strictEqual(readFileSync(join(rootA, '001/002/003'), 'utf8'), 'live', 'existing blobs must be preserved');
		});
	});

	describe('deleteBlobSnapshot', function () {
		it('removes a single backup id snapshot and is a no-op when absent', async function () {
			writeBlob(rootA, '001/002/003', 'alpha');
			await snapshotBlobs(backupDir, 1, [rootA]);
			await deleteBlobSnapshot(backupDir, 1);
			assert.ok(!existsSync(blobSnapshotDir(backupDir, 1)));
			// no throw on a missing snapshot
			await deleteBlobSnapshot(backupDir, 999);
		});
	});

	describe('purgeBlobSnapshots', function () {
		it('deletes every snapshot except the kept ids', async function () {
			writeBlob(rootA, '001/002/003', 'alpha');
			await snapshotBlobs(backupDir, 1, [rootA]);
			await snapshotBlobs(backupDir, 2, [rootA]);
			await snapshotBlobs(backupDir, 3, [rootA]);

			await purgeBlobSnapshots(backupDir, new Set([3]));

			assert.ok(!existsSync(blobSnapshotDir(backupDir, 1)));
			assert.ok(!existsSync(blobSnapshotDir(backupDir, 2)));
			assert.ok(existsSync(blobSnapshotDir(backupDir, 3)));
		});

		it('is a no-op when no blob snapshots exist', async function () {
			await purgeBlobSnapshots(backupDir, new Set([1]));
		});
	});
});
