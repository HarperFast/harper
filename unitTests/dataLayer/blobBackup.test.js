'use strict';

const assert = require('node:assert');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
	blobSnapshotDir,
	blobsReadmeContent,
	copyBlobRootsByIndex,
	snapshotBlobs,
	restoreBlobSnapshot,
	deleteBlobSnapshot,
	purgeBlobSnapshots,
} = require('#src/dataLayer/blobBackup');
const { classifyBlobFileForCapture, isSystemicIoError } = require('#src/resources/blob');

// Lay out a blob root the way resources/blob.ts does: files nested a few directories deep by id,
// each an 8-byte header (type in the top 16 bits, body length in the low 48) followed by the body.
function blobFile(contents) {
	const body = Buffer.from(contents);
	const header = Buffer.alloc(8);
	header.writeUInt16BE(0, 0); // UNCOMPRESSED
	header.writeUIntBE(body.length, 2, 6);
	return Buffer.concat([header, body]);
}

function writeBlob(root, relPath, contents) {
	return writeRawBlob(root, relPath, blobFile(contents));
}

// A file placed in a blob root verbatim — used for the shapes a snapshot must refuse.
function writeRawBlob(root, relPath, bytes) {
	const full = join(root, relPath);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, bytes);
	return full;
}

function blobBody(path) {
	return readFileSync(path).subarray(8).toString('utf8');
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
			assert.strictEqual(blobBody(join(snap, '0', '001/002/003')), 'alpha');
			assert.strictEqual(blobBody(join(snap, '0', '001/002/004')), 'beta');
			assert.strictEqual(blobBody(join(snap, '1', '005/006/007')), 'gamma');
		});

		it('substitutes a PENDING marker for a blob still being written, keeping its file id reserved', async function () {
			writeBlob(rootA, '001/002/003', 'complete');
			// What a write in progress looks like on disk: the real header is only stamped when the
			// stream ends, so until then the file carries the unknown-size placeholder and a short body.
			const placeholder = Buffer.alloc(8);
			placeholder.writeUInt16BE(0, 0);
			placeholder.writeUIntBE(0xffffffffffff, 2, 6);
			const inFlight = writeRawBlob(rootA, '001/002/004', Buffer.concat([placeholder, Buffer.from('partial')]));

			await snapshotBlobs(backupDir, 1, [rootA]);

			const snap = blobSnapshotDir(backupDir, 1);
			const captured = join(snap, '0', '001/002/004');
			assert.strictEqual(blobBody(join(snap, '0', '001/002/003')), 'complete');
			assert.ok(existsSync(captured), 'the file id must stay reserved so it cannot be reissued after a restore');
			assert.notStrictEqual(
				statSync(captured).ino,
				statSync(inFlight).ino,
				'a blob still being written must not share its inode with the snapshot'
			);
			assert.strictEqual(readFileSync(captured).readUInt16BE(0), 0xfe, 'expected a PENDING marker (retryable)');
			assert.ok(existsSync(inFlight), 'the live in-flight blob itself must be left alone');
		});

		it('preserves an existing PENDING marker rather than downgrading it to an absent blob', async function () {
			const marker = Buffer.alloc(8);
			marker.writeUInt16BE(0xfe, 0);
			marker.writeUIntBE(4, 2, 6);
			const src = writeRawBlob(rootA, '001/002/003', Buffer.concat([marker, Buffer.from('gone')]));

			await snapshotBlobs(backupDir, 1, [rootA]);

			const captured = join(blobSnapshotDir(backupDir, 1), '0', '001/002/003');
			assert.ok(existsSync(captured));
			assert.strictEqual(statSync(captured).ino, statSync(src).ino, 'a stable marker should be hard-linked as-is');
		});

		it('substitutes a marker for a truncated blob whose body is shorter than its header claims', async function () {
			const header = Buffer.alloc(8);
			header.writeUInt16BE(0, 0);
			header.writeUIntBE(500, 2, 6); // claims 500 bytes, only 4 present
			writeRawBlob(rootA, '001/002/003', Buffer.concat([header, Buffer.from('shrt')]));

			await snapshotBlobs(backupDir, 1, [rootA]);

			const captured = join(blobSnapshotDir(backupDir, 1), '0', '001/002/003');
			assert.strictEqual(readFileSync(captured).readUInt16BE(0), 0xfe);
		});

		it('captures a complete compressed blob rather than substituting for it', async function () {
			// A deflate body cannot be checked by length (its header records the *uncompressed* size), so
			// this is the branch that reads the body to decide.
			const { deflateSync } = require('node:zlib');
			const payload = Buffer.from('compressible '.repeat(64));
			const body = deflateSync(payload);
			const header = Buffer.alloc(8);
			header.writeUInt16BE(1, 0); // DEFLATE
			header.writeUIntBE(payload.length, 2, 6);
			const src = writeRawBlob(rootA, '001/002/003', Buffer.concat([header, body]));

			await snapshotBlobs(backupDir, 1, [rootA]);

			const captured = join(blobSnapshotDir(backupDir, 1), '0', '001/002/003');
			assert.strictEqual(statSync(captured).ino, statSync(src).ino, 'a whole compressed blob should link');
		});

		it('substitutes for a compressed blob whose body is truncated', async function () {
			const { deflateSync } = require('node:zlib');
			const payload = Buffer.from('compressible '.repeat(64));
			const body = deflateSync(payload);
			const header = Buffer.alloc(8);
			header.writeUInt16BE(1, 0);
			header.writeUIntBE(payload.length, 2, 6);
			writeRawBlob(rootA, '001/002/003', Buffer.concat([header, body.subarray(0, body.length - 8)]));

			await snapshotBlobs(backupDir, 1, [rootA]);

			const captured = join(blobSnapshotDir(backupDir, 1), '0', '001/002/003');
			assert.strictEqual(readFileSync(captured).readUInt16BE(0), 0xfe);
		});

		it('restores a substituted marker so the record reads as retryable rather than absent', async function () {
			const placeholder = Buffer.alloc(8);
			placeholder.writeUInt16BE(0, 0);
			placeholder.writeUIntBE(0xffffffffffff, 2, 6);
			writeRawBlob(rootA, '001/002/003', Buffer.concat([placeholder, Buffer.from('partial')]));

			await snapshotBlobs(backupDir, 1, [rootA]);
			rmSync(rootA, { recursive: true, force: true });
			await restoreBlobSnapshot(backupDir, 1, 'test', [rootA]);

			const restored = join(rootA, '001/002/003');
			assert.ok(existsSync(restored), 'the id must come back so it cannot be reissued');
			assert.strictEqual(readFileSync(restored).readUInt16BE(0), 0xfe, 'restored as PENDING (retryable), not absent');
		});

		it('skips .repair temporaries rather than linking them into the snapshot', async function () {
			writeBlob(rootA, '001/002/003', 'complete');
			writeBlob(rootA, '001/002/003.repair', 'half-repaired');

			await snapshotBlobs(backupDir, 1, [rootA]);

			const snap = blobSnapshotDir(backupDir, 1);
			assert.strictEqual(blobBody(join(snap, '0', '001/002/003')), 'complete');
			assert.strictEqual(existsSync(join(snap, '0', '001/002/003.repair')), false);
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
			assert.ok(!existsSync(blobSnapshotDir(backupDir, 7) + '.tmp'));
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
			assert.match(readme, /0xfe.*PENDING/);
			assert.match(readme, /0xff.*ERROR/);
		});
	});

	describe('blob capture classification', function () {
		it('classifies a blob reclaimed before it can be opened as gone', async function () {
			assert.strictEqual(await classifyBlobFileForCapture(join(rootA, '001/002/003')), 'gone');
		});

		it('recognizes only host-level I/O errors as systemic', function () {
			for (const code of ['EMFILE', 'ENFILE', 'ENOSPC', 'EIO', 'EROFS']) {
				assert.strictEqual(isSystemicIoError(Object.assign(new Error(code), { code })), true);
			}
			assert.strictEqual(isSystemicIoError(Object.assign(new Error('permission denied'), { code: 'EACCES' })), false);
		});
	});

	// copy-db copies blob roots through the same primitive, into a standalone directory beside the
	// database copy rather than a backup repository (harper#2048).
	describe('copyBlobRootsByIndex', function () {
		it('copies every root into its index directory and replaces a previous copy', async function () {
			writeBlob(rootA, '001/002/003', 'alpha');
			writeBlob(rootB, '005/006/007', 'gamma');
			const destination = join(tempDir, 'copy.mdb-blobs');

			await copyBlobRootsByIndex(destination, [rootA, rootB]);
			assert.strictEqual(blobBody(join(destination, '0', '001/002/003')), 'alpha');
			assert.strictEqual(blobBody(join(destination, '1', '005/006/007')), 'gamma');
			assert.ok(!existsSync(destination + '.tmp'), 'the staging directory is renamed into place, not left behind');

			rmSync(join(rootA, '001/002/003'));
			writeBlob(rootA, '001/002/009', 'delta');
			await copyBlobRootsByIndex(destination, [rootA, rootB]);
			assert.ok(!existsSync(join(destination, '0', '001/002/003')), 'a stale file from the previous copy is gone');
			assert.strictEqual(blobBody(join(destination, '0', '001/002/009')), 'delta');
		});
	});

	describe('blobsReadmeContent', function () {
		it('documents the copy layout without a backup-id level and maps every root index', function () {
			const readme = blobsReadmeContent([rootA, rootB], { variant: 'copy' });
			assert.match(readme, /<rootIndex>\/<shard1>\/<shard2>\/<fileId>/);
			assert.doesNotMatch(readme, /<backupId>/, 'a copy has no backup id');
			assert.match(readme, /copy-db/);
			assert.ok(readme.includes(`0 -> ${rootA}`));
			assert.ok(readme.includes(`1 -> ${rootB}`));
		});

		it('keeps the managed and archive variants distinguishable', function () {
			assert.match(blobsReadmeContent([rootA]), /<backupId>\/<rootIndex>/);
			assert.match(blobsReadmeContent([rootA], { variant: 'archive' }), /get_backup/);
			assert.doesNotMatch(blobsReadmeContent([rootA], { variant: 'archive' }), /<backupId>/);
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
				blobBody(join(rootA, '001/002/003')),
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

			assert.strictEqual(blobBody(join(rootA, 'a/a/a')), 'from-a');
			assert.strictEqual(blobBody(join(rootB, 'b/b/b')), 'from-b');
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
				blobBody(join(rootA, 'existing/1/2')),
				'preexisting',
				'a rejected restore must not purge the blob root'
			);
		});

		it('leaves live blobs untouched when the backup has no blob snapshot (engine-only backup)', async function () {
			writeBlob(rootA, '001/002/003', 'live');
			// no snapshotBlobs call for backup 2
			await restoreBlobSnapshot(backupDir, 2, 'testdb', [rootA]);
			assert.strictEqual(blobBody(join(rootA, '001/002/003')), 'live', 'existing blobs must be preserved');
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
