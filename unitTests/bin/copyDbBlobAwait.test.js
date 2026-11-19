const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

require('../testUtils');

const {
	beginPendingMigrationBlobSaves,
	endPendingMigrationBlobSaves,
	encodeBlobsWithFilePath,
	saveBlob,
} = require('#src/resources/blob');

// Regression for harper#1337 — the v4→v5 migration was fire-and-forget on blob file writes.
// `encodeBlobsWithFilePath` triggers `saveBlob → writeBlobWithStream`, which sets up a
// `pipeline()` whose promise lives on `storageInfo.saving` and was never collected. The
// migration loop awaited only `targetDbi.put`, so it could close the target DB while blob
// pipelines were still flushing. Failures silently dropped on the floor — producing records
// in the target DB referencing fileIds whose blob files were never durably written.
//
// The fix exposes a per-migration tracking window: `beginPendingMigrationBlobSaves()` returns
// an array that `saveBlob` pushes every `storageInfo.saving` promise into. The migration
// awaits them before closing the target store, and fails the migration loudly on any
// rejection.

describe('encodeBlobsWithFilePath blob-save tracking (harper#1337)', () => {
	let tmpRoot;
	let store;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-blob-await-'));
		const { open } = require('lmdb');
		const { databasePaths } = require('#src/resources/blob');
		store = open({ path: path.join(tmpRoot, 'db') });
		databasePaths.set(store, [path.join(tmpRoot, 'blobs')]);
	});

	afterEach(() => {
		try {
			store?.close();
		} catch {}
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
		endPendingMigrationBlobSaves();
	});

	it('collects in-flight blob save promises into the begin/end window', async () => {
		const tracked = beginPendingMigrationBlobSaves();
		assert.deepStrictEqual(tracked, [], 'window starts empty');

		// Drive a tiny saveBlob through encodeBlobsWithFilePath. Use a file-backed blob whose
		// stream is short enough that the pipeline can complete in-test.
		const { createBlob } = require('#src/resources/blob');
		const blob = await createBlob(Buffer.from('a'.repeat(20000))); // > FILE_STORAGE_THRESHOLD (8192)

		encodeBlobsWithFilePath(
			() => {
				saveBlob(blob);
			},
			1,
			store
		);

		assert.strictEqual(tracked.length, 1, 'one save promise tracked');
		await assert.doesNotReject(tracked[0], 'the tracked save resolves');

		endPendingMigrationBlobSaves();
	});

	it('a failed blob save (source stream errors) shows up as a rejection in the tracked list', async () => {
		const { Readable } = require('node:stream');

		const tracked = beginPendingMigrationBlobSaves();

		const { createBlob } = require('#src/resources/blob');
		// Construct a blob whose source stream emits an error on first read — simulates v4 having
		// an unreadable source file (the production scenario the migration could not previously
		// detect).
		const broken = Readable.from(
			(function* () {
				throw new Error('synthetic ENOENT during migration read');
				yield Buffer.from('unused');
			})()
		);
		const blob = await createBlob(broken);

		encodeBlobsWithFilePath(
			() => {
				saveBlob(blob);
			},
			2,
			store
		);

		assert.strictEqual(tracked.length, 1, 'one save promise tracked');
		// Use allSettled so we observe the rejection without failing the test on the throw.
		const [result] = await Promise.allSettled(tracked);
		assert.strictEqual(result.status, 'rejected', `expected the broken-source save to reject; got ${result.status}`);

		endPendingMigrationBlobSaves();
	});

	it('a mid-loop rejection does NOT fire unhandledRejection before the migration awaits the list', async () => {
		// Production concern: in a long migration with thousands of records and multiple `await
		// written` checkpoints between record encodes, a blob save can reject well before the
		// migration loop reaches its Promise.allSettled(pendingBlobSaves) gate. Without a
		// suppression handler on the tracked chain, Node fires unhandledRejection at that point
		// and the process aborts — short-circuiting the structured `Migration of … failed: …`
		// throw the migration relies on for retryability.
		const { Readable } = require('node:stream');
		const { createBlob } = require('#src/resources/blob');

		const tracked = beginPendingMigrationBlobSaves();

		const broken = Readable.from(
			(function* () {
				throw new Error('synthetic ENOENT during migration read');
				yield Buffer.from('unused');
			})()
		);
		const blob = await createBlob(broken);

		// Capture unhandledRejection events for the duration of the test.
		const unhandled = [];
		const listener = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', listener);

		encodeBlobsWithFilePath(() => saveBlob(blob), 5, store);
		assert.strictEqual(tracked.length, 1, 'one save promise tracked');

		// Yield to the event loop long enough for the rejection to propagate and any
		// unhandledRejection to fire. Two macrotasks plus a microtask drain is typically enough.
		await new Promise((resolve) => setTimeout(resolve, 50));
		await new Promise((resolve) => setImmediate(resolve));

		process.off('unhandledRejection', listener);

		assert.deepStrictEqual(
			unhandled,
			[],
			`expected NO unhandledRejection during the migration loop; got: ${unhandled.map(String).join('; ')}`
		);

		// The migration's later Promise.allSettled MUST still observe the rejection so the
		// structured `Migration failed` throw can fire.
		const [result] = await Promise.allSettled(tracked);
		assert.strictEqual(result.status, 'rejected', 'allSettled still detects the rejection');

		endPendingMigrationBlobSaves();
	});

	it('endPendingMigrationBlobSaves stops collecting; new saveBlob calls do NOT land in the prior list', async () => {
		const { createBlob, isSaving } = require('#src/resources/blob');
		const tracked = beginPendingMigrationBlobSaves();
		const firstBlob = await createBlob(Buffer.from('x'.repeat(20000)));
		encodeBlobsWithFilePath(() => saveBlob(firstBlob), 3, store);
		assert.strictEqual(tracked.length, 1);

		endPendingMigrationBlobSaves();

		// After the window closes, a subsequent encode should not append to `tracked`.
		const secondBlob = await createBlob(Buffer.from('y'.repeat(20000)));
		encodeBlobsWithFilePath(() => saveBlob(secondBlob), 4, store);
		assert.strictEqual(tracked.length, 1, 'tracked list is not appended to after end');

		// Await both blobs' pipelines to drain so the afterEach can close the store cleanly
		// without orphaning their write streams (would otherwise show up as uncaughtException).
		await Promise.allSettled([tracked[0], isSaving(secondBlob)].filter(Boolean));
	});
});
