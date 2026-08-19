require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases } = require('#src/resources/databases');
const { removeEntry } = require('#src/resources/RecordEncoder');
const { Readable, PassThrough } = require('node:stream');
const { setAuditRetention } = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const {
	blobFileMissingOrIncomplete,
	repairBlobFile,
	getFilePathForBlob,
	deleteBlob,
	setDeletionDelay,
	holdBlobFile,
	getBlobHoldStateForTesting,
	encodeBlobsAsBuffers,
	findBlobsInObject,
	isSaving,
	cleanupOrphans,
	cleanupUnusedBlobs,
	collectRetainedFileIds,
	getFileId,
	saveBlob,
	decodeFromDatabase,
	startPreCommitBlobsForRecord,
	isSourceBlobUnavailable,
	isBlobComplete,
	findIncompleteBlobRefs,
	shouldDestroyIdleBlobSource,
	registerBlobReceiveInFlight,
	unregisterBlobReceiveInFlight,
	isBlobReceiveInFlight,
	createPendingMarkerBarrier,
} = require('#src/resources/blob');
const {
	existsSync,
	unlinkSync,
	openSync,
	writeSync,
	ftruncateSync,
	readFileSync,
	closeSync,
	statSync,
	truncateSync,
	writeFileSync,
	readdirSync,
	renameSync,
	rmSync,
} = require('fs');
const { dirname } = require('path');
const { pack } = require('msgpackr');
const { randomBytes } = require('crypto');
const { waitFor } = require('../waitFor.js');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const HEADER_SIZE = 8;
// Build the 8-byte blob file header: 2-byte storage type followed by a 6-byte content size.
function makeBlobHeader(size, type = 0) {
	const header = Buffer.alloc(HEADER_SIZE);
	new DataView(header.buffer).setBigInt64(0, BigInt(size) | (BigInt(type) << 48n));
	return header;
}

describe('Blob test', () => {
	let BlobTest;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		BlobTest = table({
			table: 'BlobTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});
	it('find a blob in an object', async () => {
		let blobCount = 0;
		findBlobsInObject(
			{
				blob: await createBlob(Buffer.from('test')),
				other: 'test',
				nested: {
					blob: await createBlob(Buffer.from('test')),
					other: 'test',
				},
				array: [
					{ string: 'str', hasNull: null, other: 'test' },
					{ blob: await createBlob(Buffer.from('test')), other: 'test' },
					null,
					undefined,
					3,
				],
			},
			(blob) => {
				assert(blob instanceof Blob);
				blobCount++;
			}
		);
		assert.equal(blobCount, 3);
	});
	it('create a blob and save it', async () => {
		let testString = 'this is a test string'.repeat(256);
		let blob = await createBlob(Readable.from(testString), { type: 'text/plain' });
		blob.extraProperty = 'this is an extra property';
		assert(blob instanceof Blob);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedText = await record.blob.text();
		assert.equal(retrievedText, testString);
		assert.equal(record.blob.type, 'text/plain');
		assert.equal(record.blob.extraProperty, 'this is an extra property');
		testString += testString; // modify the string
		await assert.rejects(async () => {
			// should not be able to use the blob in a different record
			await BlobTest.put({ id: 2, blob });
		});
		blob = await createBlob(Readable.from(testString), { flush: true }); // create a new blob with flush
		await BlobTest.put({ id: 1, blob });
		record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		retrievedText = await record.blob.text();
		assert.equal(retrievedText, testString);
		let slicedText = await record.blob.slice(0, 100).text();
		assert.equal(slicedText, testString.slice(0, 100));
	});
	it('create a blob from a buffer and save it', async () => {
		let random = randomBytes(25000);
		let blob = await createBlob(random);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedBytes = await record.blob.bytes();
		assert(retrievedBytes.equals(random));
		assert.equal(record.blob.size, random.length);
		let sliced = record.blob.slice(300, 400);
		assert.equal(sliced.size, 100);
		retrievedBytes = await sliced.bytes();
		assert(retrievedBytes.equals(random.slice(300, 400)));
	});
	it('round-trips a compressed blob via bytes() and stream()', async () => {
		// compressible payload, comfortably over FILE_STORAGE_THRESHOLD so it is file-backed
		let original = Buffer.from('compressible blob payload '.repeat(2000));
		assert(original.length > 8192);
		let blob = await createBlob(original, { compress: true });
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		let retrievedBytes = await record.blob.bytes();
		assert(retrievedBytes.equals(original), 'bytes() must return the decompressed original content');
		assert.equal(record.blob.size, original.length);
		// the streaming read path must also decompress
		let streamed = await streamToBuffer(record.blob.stream());
		assert.equal(streamed, original.toString(), 'stream() must return the decompressed original content');
	});
	it('reads a ranged slice of a compressed blob over uncompressed offsets', async () => {
		let original = Buffer.from('compressible blob payload '.repeat(2000));
		let blob = await createBlob(original, { compress: true });
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		let sliced = record.blob.slice(300, 400);
		assert.equal(sliced.size, 100);
		let slicedBytes = await sliced.bytes();
		assert(slicedBytes.equals(original.slice(300, 400)), 'ranged read must slice the uncompressed content');
		let slicedStream = await streamToBuffer(record.blob.slice(300, 400).stream());
		assert.equal(slicedStream, original.slice(300, 400).toString());
	});
	it('create a blob from a buffer and save it before committing', async () => {
		let random = randomBytes(5000 * Math.random() + 20000);
		let blob = createBlob(random, { saveBeforeCommit: true });
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedBytes = await record.blob.bytes();
		assert(retrievedBytes.equals(random));
		assert.equal(record.blob.size, random.length);
	});
	it('create a blob from a stream with saveBeforeCommit and abort it', async () => {
		let testString = 'this is a test string for deletion'.repeat(12);
		let blob = await createBlob(
			Readable.from(
				(async function* () {
					for (let i = 0; i < 5; i++) {
						yield testString + i;
					}
					throw new Error('test error');
				})()
			),
			{ saveBeforeCommit: true }
		);
		await assert.rejects(() => BlobTest.put({ id: 111, blob }));
		let filePath = getFilePathForBlob(blob);
		await waitFor(() => !existsSync(filePath)); // wait for the file to be deleted
	});
	it('create a blob from a buffer and call save() but then fail validation', async () => {
		let blob;
		class BlobTestFailsValidation extends BlobTest {
			validate() {
				throw new Error('test error'); // simulate when too much queue errors are thrown
			}
		}
		assert.throws(() => {
			let random = randomBytes(5000 * Math.random() + 20000);
			blob = createBlob(random);
			blob.save();
			BlobTestFailsValidation.put({ id: 1, blob });
		});
		assert(blob);
		assert(!isSaving(blob)); // ensure that it is not saving or saved
	});
	it('create a small blob from a buffer and save it', async () => {
		let random = randomBytes(250);
		let blob = await createBlob(random);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedBytes = await record.blob.bytes();
		assert(random.equals(retrievedBytes));
		assert.equal(record.blob.size, random.length);
	});
	it('create a small blob from a stream and save it', async () => {
		let random = randomBytes(250);
		let blob = await createBlob(Readable.from(random), { size: 250, type: 'application/octet-stream' });
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		assert.equal(record.blob.type, 'application/octet-stream');
		let retrievedBytes = await record.blob.bytes();
		assert(random.equals(retrievedBytes));
		assert.equal(record.blob.size, random.length);
	});
	it('create a blob from an empty buffer and save it', async () => {
		let empty = Buffer.alloc(0);
		let blob = await createBlob(empty);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let streamResults = streamToBuffer(record.blob.stream());
		let retrievedBytes = await record.blob.bytes();
		assert.equal(retrievedBytes.length, 0);
		assert.equal(record.blob.size, 0);
		assert.equal(await streamResults, '');
	});
	it('save a native Blob and retrieve the data', async () => {
		let source = Buffer.alloc(25000, 7);
		let blob = new Blob([source]);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedBytes = await record.blob.bytes();
		assert(source.equals(retrievedBytes));
		assert.equal(record.blob.size, source.length);
	});
	it('Save a blob and delete it', async () => {
		setAuditRetention(0.01); // 10 ms audit log retention
		setDeletionDelay(0);
		let testString = 'this is a test string for deletion'.repeat(256);
		let blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 3, blob });
		let filePath = getFilePathForBlob(blob);
		assert(existsSync(filePath));
		await BlobTest.delete(3);
		await waitFor(() => !existsSync(filePath)); // should be deleted
		BlobTest.auditStore.scheduleAuditCleanup(1); // prune audit log, so the blob is actually deleted
		await waitFor(() => !existsSync(filePath)); // wait for audit log removal and deletion

		blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 4, blob });
		assert.notStrictEqual(filePath, getFilePathForBlob(blob)); // it should be a new file path
		filePath = getFilePathForBlob(blob);
		BlobTest.auditStore.scheduleAuditCleanup(1); // prune audit log, so the blob is actually deleted
		await delay(50); // wait for audit log removal and deletion
		assert(existsSync(filePath)); // should still exist because it isn't deleted yet
		await BlobTest.delete(4);
		await waitFor(() => !existsSync(filePath)); // wait for deletion

		setAuditRetention(10); // give us time to check the blob file that is written
		blob = await createBlob(Buffer.from(testString));
		await BlobTest.publish(4, { id: 4, blob });
		await isSaving(blob);
		assert.equal(getFilePathForBlob(blob), null); // should be saved in the record, not in a file path

		blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 4, blob });
		assert.notStrictEqual(filePath, getFilePathForBlob(blob)); // it should be a new file path
		filePath = getFilePathForBlob(blob);
		BlobTest.auditStore.scheduleAuditCleanup(1); // prune audit log, so the blob is actually deleted
		await delay(50); // wait for audit log removal and deletion
		assert(existsSync(filePath)); // should still exist because it isn't replaced yet
		await BlobTest.put({ id: 4, blob: null });
		await waitFor(() => !existsSync(filePath)); // wait for deletion
	});
	it('updating an unrelated attribute does not unlink a still-referenced blob', async () => {
		// Regression: RecordEncoder used to call deleteBlobsInObject(existingEntry.value)
		// unconditionally on every update, scheduling unlink() on every prior blob —
		// even ones the new record still references. With the retention check, a put
		// that carries the same blob (same fileId) leaves the file intact.
		//
		// This is the pattern the deployment-tracking recorder hits: ingestPayload
		// stores payload_blob, then several subsequent puts update phase / event_log
		// while keeping payload_blob on the row. Without retention the blob is unlinked
		// mid-deploy and replication fails with ENOENT.
		setAuditRetention(10);
		setDeletionDelay(0);
		const RetentionTest = table({
			table: 'BlobRetentionTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
				{ name: 'phase', type: 'String' },
			],
		});
		const payload = randomBytes(20000); // > FILE_STORAGE_THRESHOLD so it goes file-backed
		const blob = await createBlob(payload);
		await RetentionTest.put({ id: 100, blob, phase: 'pending' });
		const filePath = getFilePathForBlob(blob);
		assert(filePath, 'expected file-backed blob');
		assert(existsSync(filePath), 'blob file should exist after initial put');

		// Update an unrelated attribute, keeping the same blob instance on the record.
		// Pre-fix: this unlinked the file ~deletionDelay ms later.
		await RetentionTest.put({ id: 100, blob, phase: 'extracting' });
		await delay(50);
		assert(existsSync(filePath), 'blob file must survive update that retains it');

		// Several more updates simulating the multi-flush pattern.
		for (const phase of ['installing', 'loading', 'replicating', 'success']) {
			await RetentionTest.put({ id: 100, blob, phase });
			await delay(20);
			assert(existsSync(filePath), `blob file must survive phase=${phase} update`);
		}

		// Also exercise the get → mutate → put path so retention is proven with a
		// freshly-decoded blob (different JS instance, same fileId), not only the
		// in-memory blob we created above.
		const fetched = await RetentionTest.get(100);
		assert(fetched.blob, 'fetched row should still carry the blob attribute');
		await RetentionTest.put({ id: 100, blob: fetched.blob, phase: 'after-roundtrip' });
		await delay(50);
		assert(existsSync(filePath), 'blob file must survive update via a freshly-decoded blob');

		// Now explicitly drop the blob — file should get cleaned up as before.
		await RetentionTest.put({ id: 100, blob: null, phase: 'gone' });
		await waitFor(() => !existsSync(filePath), {
			message: 'blob file should be unlinked when the new record no longer references it',
		});
		setDeletionDelay(500); // restore the default
	});
	it('a reader that resolved a record before it was superseded can still read the blob (#2134)', async () => {
		// The file is opened lazily, by path, when the consumer calls stream()/bytes() — not when the
		// record is decoded. A concurrent write that supersedes the record unlinks the prior blob, so
		// without a retention window the reader's late open fails with ENOENT, typically after the
		// response headers have already been committed.
		setAuditRetention(10);
		setDeletionDelay(undefined); // exercise the shipped default, not a test-compressed delay
		const ReaderTest = table({
			table: 'BlobReaderRetentionTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
		const payload = randomBytes(20000); // > FILE_STORAGE_THRESHOLD → file-backed
		await ReaderTest.put({ id: 300, blob: await createBlob(payload) });

		// A reader resolves the record and holds the decoded blob, but has not opened the file yet.
		const reader = await ReaderTest.get(300);
		const filePath = getFilePathForBlob(reader.blob);
		assert(filePath, 'expected file-backed blob');

		// A concurrent write supersedes it, which schedules the prior blob for reclamation.
		await ReaderTest.put({ id: 300, blob: await createBlob(randomBytes(20000)) });
		await delay(800); // past the old fixed 500ms unlink, inside the configured window
		assert(existsSync(filePath), 'superseded blob must be retained while a reader still references it');
		assert(payload.equals(await reader.blob.bytes()), "the reader's late read must return the original bytes");

		// The window is a deferral, not a leak: once it lapses the file goes.
		await waitFor(() => !existsSync(filePath), {
			timeout: 6000,
			message: 'superseded blob must be reclaimed once the retention window lapses',
		});

		await ReaderTest.delete(300);
		setDeletionDelay(500); // restore the default
	});
	it('an explicit retention hold defers reclamation until it is released (#2134)', async () => {
		// The hook replication needs: a peer that has not yet fetched a superseded blob otherwise gets
		// a clean 404 from the sender, classifies it as unrecoverable at source, and advances its
		// resume cursor past a record whose bytes it will never have (harper-pro#403/#388).
		setAuditRetention(10);
		setDeletionDelay(0); // isolate the hold from the time-based delay
		const payload = randomBytes(20000);
		const blob = await createBlob(payload);
		await BlobTest.put({ id: 301, blob });
		const filePath = getFilePathForBlob(blob);
		assert(filePath && existsSync(filePath), 'expected file-backed blob on disk');

		const release = holdBlobFile(blob);
		await BlobTest.put({ id: 301, blob: await createBlob(randomBytes(20000)) });
		await delay(50);
		assert(existsSync(filePath), 'a held blob must not be reclaimed');

		release();
		// Generous: a deadline queued by an earlier test clamps this entry's (see enqueue()).
		await waitFor(() => !existsSync(filePath), {
			timeout: 8000,
			message: 'blob should be reclaimed once the hold is released',
		});

		await BlobTest.delete(301);
		setDeletionDelay(500); // restore the default
	});
	it('a hold taken on another worker defers reclamation (#2134)', async () => {
		// The consumer and the write that supersedes it routinely run on different workers, so the
		// hold count lives in the store's shared buffer — a thread-local version of this passed its
		// unit test while protecting nothing in production.
		setAuditRetention(10);
		setDeletionDelay(0);
		const blob = await createBlob(randomBytes(20000));
		await BlobTest.put({ id: 302, blob });
		const filePath = getFilePathForBlob(blob);
		const fileId = getFileId(blob);
		assert(filePath && existsSync(filePath), 'expected file-backed blob on disk');

		// Increment the shared counter directly, the way another worker's holdBlobFile() would.
		const store = BlobTest.primaryStore.rootStore;
		const { table, slot } = getBlobHoldStateForTesting(store, fileId);
		assert.equal(Atomics.add(table, slot, 1), 0, 'expected no existing holders');

		await BlobTest.put({ id: 302, blob: await createBlob(randomBytes(20000)) });
		await delay(100);
		assert(existsSync(filePath), "a blob held by another worker's hold must not be reclaimed");

		Atomics.sub(table, slot, 1);
		await waitFor(() => !existsSync(filePath), {
			timeout: 5000,
			message: 'blob should be reclaimed once the cross-worker hold is released',
		});

		await BlobTest.delete(302);
		setDeletionDelay(500); // restore the default
	});
	it('two concurrent holders each keep the blob alive (#2134)', async () => {
		// The case a binary lock cannot express: with one shared lock, the first release frees it while
		// the second holder is still running.
		setAuditRetention(10);
		setDeletionDelay(0);
		const blob = await createBlob(randomBytes(20000));
		await BlobTest.put({ id: 303, blob });
		const filePath = getFilePathForBlob(blob);
		const fileId = getFileId(blob);
		const store = BlobTest.primaryStore.rootStore;
		const { table, slot } = getBlobHoldStateForTesting(store, fileId);

		const releaseA = holdBlobFile(blob); // this worker
		Atomics.add(table, slot, 1); // another worker

		await BlobTest.put({ id: 303, blob: await createBlob(randomBytes(20000)) });
		releaseA();
		await delay(100);
		assert(existsSync(filePath), 'the remaining holder must still keep the blob alive');

		Atomics.sub(table, slot, 1);
		await waitFor(() => !existsSync(filePath), {
			timeout: 5000,
			message: 'blob should be reclaimed once the last holder releases',
		});

		await BlobTest.delete(303);
		setDeletionDelay(500); // restore the default
	});
	it('a re-reference on another worker cancels a queued reclamation (#2134)', async () => {
		// The queue is per worker, so the worker that re-references a file is not necessarily the one
		// that queued its reclamation; the signal has to be shared.
		setAuditRetention(10);
		setDeletionDelay(300);
		const blob = await createBlob(randomBytes(20000));
		await BlobTest.put({ id: 304, blob });
		const filePath = getFilePathForBlob(blob);
		const fileId = getFileId(blob);
		const store = BlobTest.primaryStore.rootStore;

		await BlobTest.put({ id: 304, blob: await createBlob(randomBytes(20000)) }); // queues reclamation
		// Another worker writes a record referencing the original file again.
		const { table, slot } = getBlobHoldStateForTesting(store, fileId);
		Atomics.store(table, slot + 1, 1);

		// Wait for the reclaimer to consume the signal rather than sleeping a fixed span: an entry's
		// deadline is clamped to the queue tail, so work queued by earlier tests can push this one out.
		await waitFor(() => Atomics.load(table, slot + 1) === 0, {
			timeout: 10000,
			message: 'the re-reference signal should be consumed',
		});
		assert(existsSync(filePath), 'a re-referenced blob must not be reclaimed');

		await BlobTest.delete(304);
		// The signal was simulated, so no record actually references the retained file — it would be a
		// real orphan for the later cleanupOrphans assertion. Remove it here rather than leaving the
		// suite to find it.
		unlinkSync(filePath);
		setDeletionDelay(500); // restore the default
	});
	it('an in-progress stream keeps its blob alive past the retention window (#2134)', async () => {
		// stream() takes a hold for the life of the read, so a read that outlives the window — a slow
		// or backpressured consumer — still gets its bytes. The payload has to be large enough that the
		// stream parks on backpressure after its first chunk: a small blob is pulled into the stream's
		// internal queue immediately, completing (and correctly releasing) before anything can race it.
		setAuditRetention(10);
		setDeletionDelay(200); // shorter than the parked read below, so only the hold can save it
		const payload = randomBytes(4_000_000);
		await BlobTest.put({ id: 305, blob: await createBlob(payload) });
		const reader = await BlobTest.get(305);
		const filePath = getFilePathForBlob(reader.blob);
		const fileId = getFileId(reader.blob);
		const { table, slot } = getBlobHoldStateForTesting(BlobTest.primaryStore.rootStore, fileId);

		const streamReader = reader.blob.stream().getReader();
		await streamReader.read(); // first chunk; the rest waits on this consumer
		assert.equal(Atomics.load(table, slot), 1, 'the in-progress read should hold the file');

		await BlobTest.put({ id: 305, blob: await createBlob(randomBytes(20000)) }); // supersedes
		await delay(600); // well past the retention window
		assert(existsSync(filePath), 'an in-progress read must keep its blob alive');

		let total = (await streamReader.read()).value?.length ?? 0;
		for (let chunk = await streamReader.read(); !chunk.done; chunk = await streamReader.read()) {
			total += chunk.value.length;
		}
		assert(total > 0, 'the parked read must be able to continue');

		await waitFor(() => !existsSync(filePath), {
			timeout: 5000,
			message: 'blob should be reclaimed once the read releases its hold',
		});

		await BlobTest.delete(305);
		setDeletionDelay(500); // restore the default
	});
	it('an open read snapshot keeps a superseded blob alive (#2134)', async function () {
		// A blob reference is fixed when the reader's snapshot is taken, not when the record is
		// decoded, so a reader inside a transaction is entitled to the bytes for as long as its
		// snapshot lives — regardless of the retention window. LMDB exposes no snapshot watermark.
		const store = BlobTest.primaryStore.rootStore;
		if (typeof store.getOldestSnapshotTimestamp !== 'function') return this.skip();
		setAuditRetention(10);
		setDeletionDelay(200); // far shorter than the snapshot is held open
		const blob = await createBlob(randomBytes(20000));
		await BlobTest.put({ id: 306, blob });
		const filePath = getFilePathForBlob(blob);
		assert(filePath && existsSync(filePath), 'expected file-backed blob on disk');

		let releaseSnapshot;
		const snapshotHeld = new Promise((resolve) => (releaseSnapshot = resolve));
		const snapshotDone = store.transaction(async (txn) => {
			await txn.get(306); // transactional read → SetSnapshot()
			await snapshotHeld;
		});
		await waitFor(() => store.getOldestSnapshotTimestamp() > 0, { message: 'expected an open snapshot' });

		await BlobTest.put({ id: 306, blob: await createBlob(randomBytes(20000)) }); // supersedes
		await delay(1500); // many times the retention window
		assert(existsSync(filePath), 'a blob visible to an open snapshot must not be reclaimed');

		releaseSnapshot();
		await snapshotDone;
		await waitFor(() => !existsSync(filePath), {
			timeout: 8000,
			message: 'blob should be reclaimed once the snapshot is released',
		});

		await BlobTest.delete(306);
		setDeletionDelay(500); // restore the default
	});
	it('blob unlink is gated on the removal committing (#1364)', async () => {
		// removeEntry must only unlink the old blobs once the record removal commits. An
		// expiration scan whose transaction is force-committed without the delete (or an
		// aborted/version-conflicted removal) leaves the record in place; unlinking its blobs
		// regardless would orphan the reference and wedge replication on ENOENT.
		setDeletionDelay(0);
		const realStore = BlobTest.primaryStore;
		const blob = await createBlob(randomBytes(20000)); // > FILE_STORAGE_THRESHOLD → file-backed
		await BlobTest.put({ id: 720, blob });
		const filePath = getFilePathForBlob(blob);
		assert(filePath, 'expected file-backed blob');
		assert(existsSync(filePath), 'blob file should exist after put');

		// Fetch a real entry (value + metadataFlags) the way the eviction scan does.
		let entry;
		for (const e of realStore.getRange({ start: 720, end: 721, versions: true })) {
			if (e.key === 720) entry = e;
		}
		assert(entry && entry.value, 'expected a real entry carrying the blob');

		// Removal that never commits (rejects): the blob must be preserved.
		removeEntry({ remove: () => Promise.reject(new Error('aborted')) }, entry, undefined);
		await delay(40);
		assert(existsSync(filePath), 'blob must survive when the removal does not commit (#1364)');

		// Removal that commits: the blob is unlinked.
		removeEntry({ remove: () => Promise.resolve(true) }, entry, undefined);
		await waitFor(() => !existsSync(filePath), {
			message: 'blob should be unlinked once the removal commits',
		});

		await BlobTest.delete(720); // cleanup the real record (its blob file is already gone)
		setDeletionDelay(500); // restore the default
	});
	it('slowly create a blob and save it before it is done', async () => {
		let testString = 'this is a test string'.repeat(256);
		let expectedResults = '';
		let blob = await createBlob(
			Readable.from(
				(async function* () {
					for (let i = 0; i < 500; i++) {
						yield testString + i;
						expectedResults += testString + i;
						await delay(i % 10); // vary it to keep things exciting
					}
				})()
			)
		);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let stream = record.blob.stream(); // we are going to concurrently get the stream and the text to test both
		let streamResults = streamToBuffer(stream);
		let slicedStream = record.blob.slice(100, 200).stream(); // we are going to concurrently get the stream and the
		let slicedStreamResults = streamToBuffer(slicedStream);
		let packResult = encodeBlobsAsBuffers(() => {
			return pack(record);
		});
		assert(!packResult.then); // put gates the commit on the blob's durable save, so pack resolves synchronously
		let retrievedText = await record.blob.text();
		assert.equal(retrievedText, expectedResults);
		assert.equal(await streamResults, expectedResults);
		assert.equal(await slicedStreamResults, expectedResults.slice(100, 200));
		assert.equal(record.blob.size, expectedResults.length);
		assert((await packResult).toString().includes(testString));
		slicedStream = record.blob.slice(6000).stream(); // we are going to concurrently get the stream and the
		slicedStreamResults = streamToBuffer(slicedStream);
		assert.equal(await slicedStreamResults, expectedResults.slice(6000));
		slicedStream = record.blob.slice(1000, 11000).stream(); // we are going to concurrently get the stream and the
		slicedStreamResults = streamToBuffer(slicedStream);
		assert.equal(await slicedStreamResults, expectedResults.slice(1000, 11000));
	});
	it('slice a multi-chunk blob via stream() seeks past the read chunk size (#1457)', async () => {
		// 0x40000 is the stream() read-buffer size. The older slice tests only cover offsets within the
		// first chunk; exercise slices whose start and/or end land in later chunks so the seek and the
		// content-offset accounting are covered (previously the slice would read and discard every chunk
		// from byte 0, and the past-first-chunk trim was off by HEADER_SIZE).
		const CHUNK = 0x40000;
		const data = randomBytes(CHUNK * 2 + 5000);
		const blob = await createBlob(data); // > FILE_STORAGE_THRESHOLD → file-backed
		await BlobTest.put({ id: 50, blob });
		const record = await BlobTest.get(50);
		const cases = [
			[100, 200], // within the first chunk (regression guard)
			[0, CHUNK], // exactly the first chunk
			[CHUNK - 100, CHUNK + 100], // straddles the first/second chunk boundary
			[CHUNK + 1000, CHUNK + 2000], // start and end both in the second chunk (seek path)
			[CHUNK * 2 + 100, undefined], // start in the third chunk, run to EOF
			[5000, data.length], // start in the first chunk, run to EOF across chunks
		];
		for (const [start, end] of cases) {
			const sliced = end === undefined ? record.blob.slice(start) : record.blob.slice(start, end);
			const streamed = await streamToBytes(sliced.stream());
			const expected = data.subarray(start, end);
			assert(
				streamed.equals(expected),
				`slice(${start}, ${end}) stream mismatch: got ${streamed.length} bytes, expected ${expected.length}`
			);
		}
	});
	it('Abort reading a blob', async () => {
		let testString = 'this is a test string for deletion'.repeat(800);
		let blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 3, blob });
		for await (let _entry of blob.stream()) {
			break;
		}
		// just make sure there is no error
	});
	it('cancel a blob stream mid-read does not throw or reject (#1457)', async () => {
		// Cancelling while an fs.read may be in flight must not recurse into read(null) (sync throw) or
		// reject the cancelled pull (unhandled rejection) — the cancel-race the cross-model review caught.
		const data = randomBytes(0x40000 * 2 + 1000); // multi-chunk, file-backed
		const blob = await createBlob(data);
		await BlobTest.put({ id: 51, blob });
		const record = await BlobTest.get(51);
		const rejections = [];
		const onRej = (e) => rejections.push(e);
		process.on('unhandledRejection', onRej);
		try {
			// cancel before any chunk is pulled (start()'s open may still be in flight)
			await record.blob.stream().getReader().cancel();
			// cancel after the first chunk, with a second read likely in flight
			const reader = record.blob.stream().getReader();
			await reader.read();
			const racing = reader.read();
			await reader.cancel();
			await racing.catch(() => {});
			await new Promise((res) => setTimeout(res, 50)); // let any late fs.read callback fire
		} finally {
			process.off('unhandledRejection', onRej);
		}
		assert.deepEqual(rejections, [], 'cancel must not produce unhandled rejections');
		// the blob is still readable afterwards (no wedged state)
		assert((await (await BlobTest.get(51)).blob.bytes()).equals(data));
	});
	it('cancel before open() resolves does not leak fds (#1457)', async () => {
		const fdDir = '/proc/self/fd';
		if (!existsSync(fdDir)) return; // Linux-only fd accounting
		const data = randomBytes(20000);
		const blob = await createBlob(data);
		await BlobTest.put({ id: 52, blob });
		const record = await BlobTest.get(52);
		const countFds = () => readdirSync(fdDir).length;
		await record.blob.stream().getReader().cancel(); // warm up lazy config lookups
		await new Promise((res) => setTimeout(res, 50));
		const before = countFds();
		for (let i = 0; i < 50; i++) {
			// cancel immediately, while start()'s open() is still in flight: the descriptor it later
			// acquires must be closed by the cancelled-guard, not leaked.
			await record.blob.stream().getReader().cancel();
		}
		await new Promise((res) => setTimeout(res, 100)); // let in-flight opens resolve and self-close
		const after = countFds();
		assert(after - before < 10, `fd leak across 50 cancels: grew from ${before} to ${after}`);
	});
	it('Abort writing a blob', async () => {
		let testString = 'this is a test string'.repeat(256);
		class BadStream extends Readable {
			_read() {
				if (!this.sentAString) {
					this.push(testString);
					this.sentAString = true;
				} else {
					console.log('throwing error in read stream');
					throw new Error('test error');
				}
			}
		}
		let blob = createBlob(new BadStream());
		await assert.rejects(async () => {
			await BlobTest.put({ id: 5, blob });
		}, /test error/);
		let eventError, thrownError;
		blob.on('error', (err) => {
			console.log('received error event');
			eventError = err;
		});
		await assert.rejects(blob.written, /test error/);
		try {
			for await (let _entry of blob.stream()) {
				console.log('got entry');
			}
		} catch (err) {
			thrownError = err;
		}
		assert(thrownError);
		assert(eventError);
		assert.equal(await BlobTest.get(5), undefined);
	});
	it('Error before streaming', async () => {
		let pt = new PassThrough();
		pt.on('error', () => {}); // ignore the uncaught error
		pt.destroy(new Error('test error'));
		let blob = createBlob(pt);
		await assert.rejects(async () => {
			await BlobTest.put({ id: 6, blob });
		}, /test error/);
		let eventError, thrownError;
		blob.on('error', (err) => {
			eventError = err;
		});

		try {
			for await (let _entry of blob.stream()) {
			}
		} catch (err) {
			thrownError = err;
		}
		assert(thrownError);
		assert(eventError);
		assert.equal(await BlobTest.get(6), undefined);
	});
	it('invalid blob attempts', async () => {
		assert.throws(() => {
			createBlob(undefined);
		});
		await assert.rejects(async () => {
			await BlobTest.put({ id: 1, blob: { name: 'not actually a blob' } });
		});
	});
	it('sequential embedded blob reads', async () => {
		for (let i = 0; i < 10; i++) {
			let bytes = new Uint8Array(1000).fill(0);
			bytes[0] = i;
			const blob = createBlob(bytes);
			await BlobTest.put({ id: i, blob });
		}
		let promises = [];
		for (let i = 0; i < 10; i++) {
			promises.push(
				Promise.resolve(BlobTest.get(i)).then(async (record) => {
					let bytes = await record.blob.bytes();
					assert.equal(bytes[0], i);
				})
			);
		}
		await Promise.all(promises);
	});
	it('publishing over a record with blobs should not leave orphans', async () => {
		let testString = 'this is a test string for deletion'.repeat(256);
		let blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 20, blob });
		for (let i = 0; i < 5; i++) {
			await BlobTest.publish(20, { id: 20, noBlobs: true });
		}
		// hopefully no orphans below
	});
	it('multi-write transaction with one failing blob cleans up succeeded blobs', async () => {
		// Both blobs use saveBeforeCommit so they save in beforeIntermediate. The bad one errors mid-stream,
		// which rejects Promise.all in beforeIntermediate and aborts the whole transaction. The good blob's
		// file is already on disk at that point and would be orphaned without the abort cleanup.
		setDeletionDelay(0); // make cleanup observable without waiting; afterEach restores to 50ms
		let goodBlob = await createBlob(Buffer.alloc(20000, 'a'), { saveBeforeCommit: true });
		let badBlob = await createBlob(
			Readable.from(
				(async function* () {
					yield 'partial';
					throw new Error('induced failure');
				})()
			),
			{ saveBeforeCommit: true }
		);
		const context = {};
		await assert.rejects(async () => {
			await transaction(context, async () => {
				await BlobTest.put({ id: 200, blob: goodBlob }, context);
				await BlobTest.put({ id: 201, blob: badBlob }, context);
			});
		});
		const goodPath = getFilePathForBlob(goodBlob);
		assert(goodPath, 'good blob was assigned a file path during pre-commit');
		await waitFor(() => !existsSync(goodPath), {
			message: `good blob ${goodPath} should be cleaned up by abort`,
		});
	});
	it('superseded incremental update cleans up pre-saved blob', async () => {
		// Establish a record at the current monotonic time.
		await BlobTest.put({ id: 250, blob: await createBlob(Buffer.from('first')) });
		// A patch with an older timestamp is treated as duplicate/superseded by the commit handler;
		// without orphan cleanup the pre-saved blob would be left behind.
		const olderBlob = await createBlob(Buffer.alloc(20000, 'b'), { saveBeforeCommit: true });
		const context = { timestamp: 1 };
		await transaction(context, async () => {
			await BlobTest.put({ id: 250, blob: olderBlob }, context);
		});
		const blobPath = getFilePathForBlob(olderBlob);
		assert(blobPath, 'older blob was assigned a file path during pre-commit');
		await waitFor(() => !existsSync(blobPath), {
			message: `superseded blob ${blobPath} should be cleaned up`,
		});
		// the original record value is preserved
		const existing = await BlobTest.get(250);
		assert.equal(await existing.blob.text(), 'first');
	});
	it('gates a local write on a manually started, still-streaming blob save', async () => {
		// saveBlob assigns the fileId as soon as the save STARTS, so a fileId check alone would
		// exempt a mid-save blob from the local-write gate and reopen the orphan-reference window
		const slow = new PassThrough();
		const blob = createBlob(slow);
		saveBlob(blob);
		slow.write('partial content');
		const store = BlobTest.primaryStore.rootStore;
		const preCommit = startPreCommitBlobsForRecord({ id: 8, blob }, store, false, false);
		assert(preCommit && preCommit.blobs.includes(blob), 'mid-save blob must gate the commit');
		let completed = false;
		const completion = preCommit.complete().then(() => (completed = true));
		await delay(20);
		assert.equal(completed, false, 'commit must wait for the save to settle');
		slow.end(' done');
		await completion;
		assert.equal(completed, true);
		unlinkSync(getFilePathForBlob(blob)); // not referenced by any record; keep cleanupOrphans at zero
	});
	it('#406: startPreCommitBlobsForRecord tracks an already-saved blob only when trackPersistedBlobs is set', async () => {
		// A replication-received blob is saved out-of-band by receiveBlobs BEFORE the apply, so at pre-commit
		// it has a fileId but no saveBeforeCommit flag. It must be tracked (so a superseded apply's cleanup
		// can unlink it — #406), but ONLY on the source-apply path: a local write carrying an already-saved
		// blob references another row's blob and must not be unlinked on abort/skip.
		const receivedBlob = createBlob(Buffer.alloc(20000, 'c'));
		await decodeFromDatabase(() => saveBlob(receivedBlob).saving, BlobTest.primaryStore.rootStore);
		const record = { id: 1, blob: receivedBlob };
		const store = BlobTest.primaryStore.rootStore;
		// local write (trackPersistedBlobs falsy): an already-saved blob is NOT tracked
		assert.equal(startPreCommitBlobsForRecord(record, store, false, false), undefined);
		// source/replication apply (trackPersistedBlobs true): tracked for skip/abort cleanup
		const preCommit = startPreCommitBlobsForRecord(record, store, false, true);
		assert(preCommit && preCommit.blobs.includes(receivedBlob), 'received blob tracked on source apply');
		unlinkSync(getFilePathForBlob(receivedBlob)); // not referenced by any record; remove so it isn't counted as an orphan
	});
	it('isSourceBlobUnavailable: only the replication source-missing marker, not local/transient faults', () => {
		// The classification gate for pre-commit tolerance: the replication receiver flags an unrecoverable
		// source-missing blob with `sourceBlobUnavailable` (markSourceBlobUnavailable, harper-pro#403). A
		// local/transient save fault (disk full, a local ENOENT) is unmarked and must NOT be tolerated.
		assert.equal(
			isSourceBlobUnavailable(Object.assign(new Error('Blob error: ENOENT'), { sourceBlobUnavailable: true })),
			true
		);
		assert.equal(isSourceBlobUnavailable(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })), false);
		assert.equal(isSourceBlobUnavailable(new Error('disk full')), false);
		assert.equal(isSourceBlobUnavailable({ sourceBlobUnavailable: false }), false);
		assert.equal(isSourceBlobUnavailable(null), false);
		assert.equal(isSourceBlobUnavailable(undefined), false);
	});
	it('complete() fault contract: needs-saving aborts on a transient fault, track-only never aborts (#1353/#1376)', async () => {
		// CONTRACT HISTORY — do not "restore" the old all-blobs-abort assertion:
		//   #1353 introduced complete() awaiting EVERY pre-commit blob, so any save fault (even on an
		//     already-saving, replication-received blob) aborted the commit.
		//   #1376 then split pre-commit blobs into two sets and changed the contract:
		//     - blobsNeedingSaving (saveInRecord / saveBeforeCommit): complete() awaits these. A
		//       transient/local fault MUST still reject → the write aborts and retries (no silent loss).
		//       A replication source-missing blob (sourceBlobUnavailable marker) is tolerated so the
		//       record still commits with a diverged reference, backfilled later (harper-pro#403/#388).
		//     - blobsToTrackOnly (already-saving, replication-received): complete() deliberately does
		//       NOT await these — awaiting a paused/back-pressured copy stream's blob would deadlock the
		//       WS (commit fails → onCommit never fires → outstandingCommits never decrements →
		//       WS paused forever, harper-pro#414). Their durability is NOT enforced by commit-abort
		//       anymore; it moved to the replication resume cursor: a fault sets hasBlobGap=true and
		//       pins lastDurableSequenceId so the blob is re-streamed on reconnect
		//       (harper-pro replication/replicationConnection.ts).
		// So a transient fault aborts ONLY on the needs-saving path; on the track-only path complete()
		// must NOT reject. The pre-#1376 assertion drove the fault through the track-only path, which is
		// why it became stale: complete() no longer awaits that set.
		const store = BlobTest.primaryStore.rootStore;

		// --- needs-saving path (saveBeforeCommit) ---

		// transient/local fault → complete() awaits the save and the unmarked rejection MUST propagate so
		// the write aborts and retries.
		const failStream = new PassThrough();
		const failBlob = await createBlob(failStream, { saveBeforeCommit: true });
		const rejectPc = startPreCommitBlobsForRecord({ id: 1, blob: failBlob }, store, false, false);
		failStream.destroy(new Error('disk full')); // no sourceBlobUnavailable marker
		await assert.rejects(
			rejectPc.complete(),
			'a local/transient save fault on a needs-saving blob must still abort the commit'
		);

		// source-unavailable → the replication marker is tolerated even on the awaited needs-saving path,
		// so the record still commits with a diverged reference.
		const goneStream = new PassThrough();
		const goneBlob = await createBlob(goneStream, { saveBeforeCommit: true });
		const toleratePc = startPreCommitBlobsForRecord({ id: 2, blob: goneBlob }, store, false, false);
		goneStream.destroy(Object.assign(new Error('Blob error: ENOENT'), { sourceBlobUnavailable: true }));
		await assert.doesNotReject(toleratePc.complete(), 'a source-unavailable blob must not abort the commit');

		// --- track-only path (already-saving replication-received blob) ---

		// A replication-received blob is saved out-of-band before the apply (fileId already set, no
		// saveBeforeCommit), so startPreCommitBlobsForRecord(trackPersistedBlobs=true) puts it in
		// blobsToTrackOnly. complete() must NOT await it: a transient fault here does NOT abort the commit
		// (durability is the resume cursor's job via hasBlobGap — see comment above). Without this, a
		// paused copy stream would deadlock the WS (harper-pro#414).
		const trackOnlyStream = new PassThrough();
		const trackOnlyBlob = await createBlob(trackOnlyStream);
		decodeFromDatabase(() => saveBlob(trackOnlyBlob, true), store); // out-of-band save: assigns fileId, begins the pipeline
		isSaving(trackOnlyBlob)?.catch(() => {}); // complete() won't await this save, so absorb its rejection ourselves
		const trackOnlyPc = startPreCommitBlobsForRecord({ id: 3, blob: trackOnlyBlob }, store, false, true);
		assert(
			trackOnlyPc && trackOnlyPc.blobs.includes(trackOnlyBlob),
			'an already-saved replication blob is tracked for cleanup'
		);
		trackOnlyStream.destroy(new Error('disk full')); // unmarked transient fault on the track-only blob
		await assert.doesNotReject(
			trackOnlyPc.complete(),
			'a transient fault on a track-only blob must NOT abort the commit (durability handled by the resume cursor)'
		);
	});
	it('#406: cleanupUnusedBlobs deletes non-retained blobs but keeps retained ones', async () => {
		// The retained-fileId guard: a skipped/aborted write may carry a blob whose fileId the surviving
		// record still references; deleting it would corrupt that record.
		setDeletionDelay(0);
		const keep = createBlob(Buffer.alloc(20000, 'k'));
		const drop = createBlob(Buffer.alloc(20000, 'p'));
		await decodeFromDatabase(() => saveBlob(keep).saving, BlobTest.primaryStore.rootStore);
		await decodeFromDatabase(() => saveBlob(drop).saving, BlobTest.primaryStore.rootStore);
		const keepPath = getFilePathForBlob(keep);
		const dropPath = getFilePathForBlob(drop);
		cleanupUnusedBlobs([keep, drop], new Set([getFileId(keep)]));
		await waitFor(() => !existsSync(dropPath), { message: `non-retained blob ${dropPath} should be deleted` });
		assert(existsSync(keepPath), 'retained blob must NOT be deleted');
		unlinkSync(keepPath); // not referenced by any record; remove so it isn't counted as an orphan
	});
	it('#406: collectRetainedFileIds returns the fileIds of saved blobs in a record', async () => {
		const blob = createBlob(Buffer.from('x'));
		await decodeFromDatabase(() => saveBlob(blob).saving, BlobTest.primaryStore.rootStore);
		const ids = collectRetainedFileIds({ attr: blob, other: 5 });
		assert(ids instanceof Set);
		assert(ids.has(getFileId(blob)));
		assert.equal(collectRetainedFileIds(null), undefined); // no record
		assert.equal(collectRetainedFileIds({ no: 'blobs' }), undefined); // no blobs → no set allocated
	});
	it('#2062: a blob whose file was deleted cannot be silently re-stored', async () => {
		// A blob instance outlives its file: the fileId stays set and saveBlob short-circuits on it, so a
		// caller still holding the instance (the deploy recorder re-puts the same record object across a
		// deploy) would otherwise mint a second reference to a destroyed file — a permanently unreadable
		// record, and one replication can never satisfy on a peer. Fail where the cause is still known.
		setDeletionDelay(0);
		const blob = createBlob(Buffer.alloc(20000, 'e'));
		const record = { id: 2062, blob };
		await BlobTest.put(record);
		const filePath = getFilePathForBlob(blob);
		const slice = blob.slice(0, 1024);
		const decodedBlob = (await BlobTest.get(2062)).blob;
		assert.notStrictEqual(decodedBlob, blob, 'the stored record should decode to a distinct blob instance');
		deleteBlob(decodedBlob);
		deleteBlob(blob);
		await waitFor(() => !existsSync(filePath), { message: `discarded blob ${filePath} should be deleted` });
		// the failure surfaces synchronously from the record encode, so catch rather than assert.rejects
		let storeError;
		try {
			await BlobTest.put(record);
		} catch (error) {
			storeError = error;
		}
		assert.match(storeError?.message ?? '', /discarded/, 're-storing a discarded blob must fail loudly');
		let sliceError;
		try {
			await BlobTest.put({ id: 2062, blob: slice });
		} catch (error) {
			sliceError = error;
		}
		assert.match(sliceError?.message ?? '', /discarded/, 'a slice sharing the condemned file must also fail');
		await BlobTest.delete(2062); // leave no record referencing the destroyed file
	});
	it('#2062: cleanup tombstones a blob before its in-flight save settles', async () => {
		setDeletionDelay(0);
		const slow = new PassThrough();
		const blob = createBlob(slow, { saveBeforeCommit: true });
		const record = { id: 2063, blob };
		const preCommit = startPreCommitBlobsForRecord(record, BlobTest.primaryStore.rootStore, false, false);
		const saving = preCommit.complete();
		slow.write(Buffer.alloc(16384, 'q'));
		const filePath = await waitFor(
			() => {
				const path = getFilePathForBlob(blob);
				return path && existsSync(path) && path;
			},
			{
				message: 'the in-flight save should create its file',
			}
		);
		cleanupUnusedBlobs(preCommit.blobs);
		let storeError;
		try {
			assert(existsSync(filePath), 'the file should still be present while its source is open');
			try {
				await BlobTest.put(record);
			} catch (error) {
				storeError = error;
			}
		} finally {
			slow.end(Buffer.alloc(16384, 'r'));
		}
		assert.match(storeError?.message ?? '', /discarded/, 're-storing must fail before the condemned file is unlinked');
		await saving;
		await waitFor(() => !existsSync(filePath), { message: `discarded blob ${filePath} should be deleted` });
	});
	it('cleanupUnusedBlobs is a no-op for unsaved blobs and clears the list', () => {
		const unsavedBlob = createBlob(Buffer.from('not yet saved'));
		const list = [unsavedBlob];
		cleanupUnusedBlobs(list);
		assert.equal(list.length, 0); // list cleared so subsequent abort/skip calls are no-ops
		cleanupUnusedBlobs(list); // does not throw on empty list
		cleanupUnusedBlobs(undefined); // does not throw when never tracked
	});
	it('isBlobComplete: true for saved blob, false for unsaved/ENOENT', async () => {
		// native Blob (not FileBackedBlob) — always complete, no file backing
		assert.equal(await isBlobComplete(new Blob(['hello'])), true, 'native Blob → true');

		// unsaved FileBackedBlob (no fileId yet) — can't be complete
		const freshBlob = createBlob(Buffer.from('hello'));
		assert.equal(await isBlobComplete(freshBlob), false, 'unsaved blob (no fileId) → false');

		// fully saved blob — file present, header matches size
		const savedBlob = await createBlob(randomBytes(20000)); // > FILE_STORAGE_THRESHOLD → file-backed
		await decodeFromDatabase(() => saveBlob(savedBlob).saving, BlobTest.primaryStore.rootStore);
		assert.equal(await isBlobComplete(savedBlob), true, 'saved blob → true');

		// truncated file — header records the original size but the file body is short, so the
		// size check (header size === fileSize - HEADER_SIZE) fails
		const truncatedBlob = await createBlob(randomBytes(20000));
		await decodeFromDatabase(() => saveBlob(truncatedBlob).saving, BlobTest.primaryStore.rootStore);
		const truncatedPath = getFilePathForBlob(truncatedBlob);
		const truncatedFullSize = statSync(truncatedPath).size;
		truncateSync(truncatedPath, truncatedFullSize - 100); // drop 100 body bytes, header still claims the full size
		assert.equal(await isBlobComplete(truncatedBlob), false, 'truncated blob (size mismatch) → false');
		unlinkSync(truncatedPath);

		// error-stub file — an 8-byte header whose top 16 bits are the ERROR_TYPE marker (0xff),
		// written when a save failed; isBlobFileComplete treats it as incomplete
		const errorBlob = await createBlob(randomBytes(20000));
		await decodeFromDatabase(() => saveBlob(errorBlob).saving, BlobTest.primaryStore.rootStore);
		const errorPath = getFilePathForBlob(errorBlob);
		const errorHeader = Buffer.alloc(8);
		errorHeader.writeBigUInt64BE(0xffn << 48n); // ERROR_TYPE in the high 16 bits
		writeFileSync(errorPath, errorHeader);
		assert.equal(await isBlobComplete(errorBlob), false, 'error-stub blob (ERROR_TYPE header) → false');
		unlinkSync(errorPath);

		// delete the file to simulate ENOENT (missing blob)
		const blobPath = getFilePathForBlob(savedBlob);
		unlinkSync(blobPath);
		assert.equal(await isBlobComplete(savedBlob), false, 'missing blob file (ENOENT) → false');
	});
	it('isBlobComplete: compressed (DEFLATE) blob — complete when fully saved, false when truncated', async () => {
		// A compressed blob stores the *uncompressed* length in its header, but the on-disk body is
		// the (smaller) compressed stream. The naive `header size === fileSize - HEADER_SIZE` check
		// therefore wrongly reports a correctly-saved compressed blob as incomplete (Codex finding on
		// harper#1387). Use highly compressible content so the compressed body is clearly shorter than
		// the uncompressed size — otherwise the bug wouldn't even be observable.
		const compressiblePayload = Buffer.alloc(20000, 'a'); // > FILE_STORAGE_THRESHOLD and very compressible
		const compressedBlob = await createBlob(compressiblePayload, { compress: true });
		await decodeFromDatabase(() => saveBlob(compressedBlob).saving, BlobTest.primaryStore.rootStore);
		const compressedPath = getFilePathForBlob(compressedBlob);
		// sanity: the on-disk body really is shorter than the uncompressed payload, so a body-length
		// comparison against the header (uncompressed) size would fail
		assert(
			statSync(compressedPath).size - 8 < compressiblePayload.length,
			'compressed body should be smaller than the uncompressed payload'
		);
		assert.equal(await isBlobComplete(compressedBlob), true, 'fully-saved compressed blob → true');

		// truncating the compressed body breaks the deflate stream → inflate fails → incomplete
		const fullSize = statSync(compressedPath).size;
		truncateSync(compressedPath, fullSize - 20); // drop trailing compressed bytes
		assert.equal(await isBlobComplete(compressedBlob), false, 'truncated compressed blob → false');
		unlinkSync(compressedPath);
	});
	it('findIncompleteBlobRefs: yields records with missing blobs, skips complete ones', async () => {
		// record 901: blob saved normally — must NOT appear in the sweep
		const completeBlob = await createBlob(randomBytes(20000));
		await BlobTest.put({ id: 901, blob: completeBlob });

		// record 902: blob file deleted after save — must appear in the sweep
		const gapBlob = await createBlob(randomBytes(20000));
		await BlobTest.put({ id: 902, blob: gapBlob });
		const gapPath = getFilePathForBlob(gapBlob);
		unlinkSync(gapPath);

		// record 903: no blob at all — the HAS_BLOBS metadata flag is never set, so the per-record
		// gate (entry.metadataFlags & HAS_BLOBS) skips it and it is never yielded
		await BlobTest.put({ id: 903 });

		const foundIds = new Set();
		for await (const ref of findIncompleteBlobRefs(getDatabases().test)) {
			foundIds.add(ref.recordId);
		}

		assert(!foundIds.has(901), 'complete-blob record must not be yielded');
		assert(foundIds.has(902), 'record with deleted blob file must be yielded');
		assert(!foundIds.has(903), 'record without the HAS_BLOBS flag must not be yielded');

		// cleanup: remove the complete blob file so cleanupOrphans stays clean
		unlinkSync(getFilePathForBlob(completeBlob));
	});
	it('cleanupOrphans', async () => {
		let orphansDeleted = await cleanupOrphans(getDatabases().test);
		assert.equal(orphansDeleted, 0);
	});

	// Helper: produce a blob backed ONLY by its on-disk file (no in-memory contentBuffer), the way a
	// node reads a blob it didn't write itself — a fresh full-copy replica or a read after the record
	// fell out of the in-memory cache. We save a blob to disk, encode it to its storage reference, then
	// decode a fresh instance from that reference. The descriptor `size` rides along and is the
	// authoritative value the read/send paths cross-validate against.
	async function makeDiskBackedBlob(payloadSize = 20000) {
		// Build the blob from a stream, so it is backed only by its on-disk file (no in-memory
		// contentBuffer) — the way a node reads a blob it didn't write itself (full-copy replica, or a
		// read after the record fell out of cache). saveBlob writes the file and records the size in both
		// the header and the descriptor; the read/send paths cross-validate the two.
		const store = BlobTest.primaryStore.rootStore;
		const blob = await createBlob(Readable.from(randomBytes(payloadSize)), { size: payloadSize });
		await decodeFromDatabase(() => saveBlob(blob).saving, store);
		const filePath = getFilePathForBlob(blob);
		assert(filePath && existsSync(filePath), 'expected a file-backed blob');
		assert.equal(blob.size, payloadSize);
		return { blob, filePath, store };
	}
	// Rewrite the on-disk file to a self-consistent-but-smaller state: header says `newSize`, body is
	// `newSize` bytes. The record descriptor still says the full size, so only a descriptor cross-check
	// (not the header's internal consistency) catches it.
	function truncateBlobConsistently(filePath, newSize) {
		const fd = openSync(filePath, 'r+');
		try {
			writeSync(fd, makeBlobHeader(newSize), 0, HEADER_SIZE, 0);
			ftruncateSync(fd, HEADER_SIZE + newSize);
		} finally {
			closeSync(fd);
		}
	}

	it('#1424: bytes() rejects a blob truncated to a self-consistent smaller size (T4)', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		truncateBlobConsistently(filePath, 256);
		await assert.rejects(blob.bytes(), (error) => {
			assert.equal(error.statusCode, 500);
			assert.match(error.message, /size mismatch/);
			return true;
		});
	});
	it('#1424: stream() rejects a blob truncated to a self-consistent smaller size (T4)', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		truncateBlobConsistently(filePath, 256);
		await assert.rejects(streamToBuffer(blob.stream()), (error) => {
			assert.equal(error.statusCode, 500);
			return true;
		});
	});
	it('#1424: replication-send does not emit a truncated blob as complete (T4)', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		truncateBlobConsistently(filePath, 256);
		// encodeBlobsAsBuffers returns a promise when a blob has to be re-read; the truncated read rejects
		// rather than packing the short file as a complete blob (which would propagate via full copy).
		await assert.rejects(Promise.resolve(encodeBlobsAsBuffers(() => pack({ blob }))), (error) => {
			assert.equal(error.statusCode, 500);
			return true;
		});
	});
	it('#1424: replication-send preserves an error-state blob stub (does not reject)', async () => {
		// An error-state stub (header type 0xff, header size = error-message length) is intentionally
		// replicated as-is so the receiver keeps the error marker. The descriptor cross-check must skip it,
		// even though the descriptor size (20000) differs from the stub's header size.
		const { blob, filePath } = await makeDiskBackedBlob();
		const message = Buffer.from('disk full while writing blob');
		const fd = openSync(filePath, 'r+');
		try {
			const stub = Buffer.concat([makeBlobHeader(message.length, 0xff), message]);
			writeSync(fd, stub, 0, stub.length, 0);
			ftruncateSync(fd, stub.length);
		} finally {
			closeSync(fd);
		}
		const encoded = encodeBlobsAsBuffers(() => pack({ blob }));
		const result = Buffer.isBuffer(encoded) ? encoded : await encoded;
		assert(Buffer.isBuffer(result) && result.length > message.length, 'error stub should be packed, not rejected');
	});
	it('#1424: replication-send packs a slice against the full file (not mis-flagged as truncated)', async () => {
		// A slice carries a reduced descriptor size that legitimately differs from the full on-disk header
		// size; the descriptor cross-check must skip slices so a valid slice still replicates.
		const { blob } = await makeDiskBackedBlob();
		const sliced = blob.slice(0, 200);
		const encoded = encodeBlobsAsBuffers(() => pack({ blob: sliced }));
		const result = Buffer.isBuffer(encoded) ? encoded : await encoded;
		assert(Buffer.isBuffer(result), 'a slice should pack without being rejected as incomplete');
	});

	// harper-pro#481: a blob write fed by a re-streamable external source (replication receive / origin
	// fetch) that aborts mid-stream stamps the file with a PENDING_TYPE (0xfe) header. The bytes are
	// still expected — the receiver holds a blob gap and re-streams on reconnect — so a downstream read
	// must return 503 (retry), NOT 500 (confidently incomplete), which the peer would treat as permanent
	// and advance its resume cursor past = silent loss. Distinct from an ERROR_TYPE (0xff) stub, which is
	// a permanent error replicated as-is.
	const PENDING_TYPE = 0xfe;
	// Stamp a disk-backed blob's file with a PENDING stub the way the write-abort path does: an 8-byte
	// header (type=PENDING_TYPE, size=message length) followed by the abort message. The record descriptor
	// still records the full size, so descriptor cross-checks would mismatch — the PENDING type must be
	// what routes the read to 503.
	function writePendingStub(filePath) {
		const message = Buffer.from('Blob source stream idle for 120000ms');
		const stub = Buffer.concat([makeBlobHeader(message.length, PENDING_TYPE), message]);
		const fd = openSync(filePath, 'r+');
		try {
			writeSync(fd, stub, 0, stub.length, 0);
			ftruncateSync(fd, stub.length);
		} finally {
			closeSync(fd);
		}
	}
	it('#481: bytes() rejects a PENDING (half-replicated) blob with 503, not 500', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		writePendingStub(filePath);
		await assert.rejects(blob.bytes(), (error) => {
			assert.equal(error.statusCode, 503, 'a pending blob must read as retryable (503), not corrupt (500)');
			return true;
		});
	});
	it('#481: stream() rejects a PENDING (half-replicated) blob with 503, not 500', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		writePendingStub(filePath);
		await assert.rejects(streamToBuffer(blob.stream()), (error) => {
			assert.equal(error.statusCode, 503);
			return true;
		});
	});
	it('#481: isBlobComplete is false for a PENDING blob (repair sweep treats it as incomplete)', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		writePendingStub(filePath);
		assert.equal(await isBlobComplete(blob), false);
	});
	it('#481: replication-send does not pack a PENDING blob as complete (holds and retries)', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		writePendingStub(filePath);
		// Unlike an error stub (replicated as-is), a PENDING stub must not inline: the encode re-reads via
		// blob.bytes(), which rejects 503, so the sender holds the gap rather than propagating the stub.
		await assert.rejects(Promise.resolve(encodeBlobsAsBuffers(() => pack({ blob }))), (error) => {
			assert.equal(error.statusCode, 503);
			return true;
		});
	});
	it('#481: a source-stream write that aborts leaves a PENDING (503) blob, not a 500 incomplete', async () => {
		// Drive the real write-abort path: createBlob from a PassThrough armed with blobStreamIdleTimeoutMs
		// the way the replication receive path arms its source (this is what the abort branch gates on, so an
		// app-supplied one-shot stream is NOT mis-marked PENDING). Start the save, deliver a partial body, then
		// destroy the source with an error. writeBlobWithStream's abort branch must stamp the file PENDING
		// because the bytes are still expected.
		const store = BlobTest.primaryStore.rootStore;
		const source = new PassThrough();
		source.blobStreamIdleTimeoutMs = 60000; // arm the source-idle watchdog (won't fire during the test)
		const blob = await createBlob(source, { size: 20000 });
		const saving = decodeFromDatabase(() => saveBlob(blob).saving, store);
		const lockKey = getFileId(blob) + ':blob';
		await new Promise((resolve, reject) => {
			source.write(randomBytes(4000), (error) => (error ? reject(error) : resolve()));
		});
		const sourceError = new Error('Blob source stream idle for 120000ms');
		source.destroy(sourceError);
		await assert.rejects(Promise.resolve(saving), (error) => {
			assert.strictEqual(error, sourceError, 'the save must reject with the original source error');
			return true;
		});
		const lockReleased = store.tryLock(lockKey);
		if (lockReleased) store.unlock(lockKey);
		assert.ok(lockReleased, 'the aborted save must release its blob lock before rejection settles');
		await assert.rejects(
			blob.bytes(),
			(error) => error.statusCode === 503,
			'aborted source write should leave a PENDING (503) blob before rejection settles'
		);
		unlinkSync(getFilePathForBlob(blob));
	});
	it('#481: a synchronous PENDING marker failure releases the blob lock and preserves the source error', async () => {
		const store = BlobTest.primaryStore.rootStore;
		const source = new PassThrough();
		source.blobStreamIdleTimeoutMs = 60000;
		const blob = await createBlob(source, { size: 20000 });
		const saving = decodeFromDatabase(() => saveBlob(blob).saving, store);
		const lockKey = getFileId(blob) + ':blob';
		await new Promise((resolve, reject) => {
			source.write(randomBytes(4000), (error) => (error ? reject(error) : resolve()));
		});
		const sourceError = new Error('source failure');
		sourceError.toString = () => {
			throw new Error('synchronous marker construction failure');
		};
		source.destroy(sourceError);
		await assert.rejects(Promise.resolve(saving), (error) => {
			assert.strictEqual(error, sourceError, 'marker failure must not mask the source error');
			return true;
		});
		const lockReleased = store.tryLock(lockKey);
		if (lockReleased) store.unlock(lockKey);
		assert.ok(lockReleased, 'a synchronous marker failure must release the blob lock before rejection settles');
		const filePath = getFilePathForBlob(blob);
		if (existsSync(filePath)) unlinkSync(filePath);
	});
	// The barrier's own contract, exercised without stalling a real filesystem write. The abort
	// regressions above cover the wired-up normal path; these cover the two behaviors that did not
	// exist before the bound was added, and which no fs-backed test can reach: the fallback firing
	// when the write callback never arrives, and the once-guard that keeps a late callback from
	// releasing a lock a different writer now holds.
	describe('#2228: the PENDING-marker cleanup barrier', () => {
		it('releases before it settles, exactly once, on a normal write completion', () => {
			const order = [];
			const finish = createPendingMarkerBarrier({
				timeoutMs: 60_000,
				release: () => order.push('release'),
				settle: () => order.push('settle'),
			});
			finish();
			finish(); // a duplicate completion must be a no-op
			assert.deepStrictEqual(order, ['release', 'settle'], 'release must precede settle, and each run once');
		});

		it('reports a write error before releasing, and still releases and settles', () => {
			const order = [];
			const writeError = new Error('ENOSPC');
			let reported;
			const finish = createPendingMarkerBarrier({
				timeoutMs: 60_000,
				release: () => order.push('release'),
				settle: () => order.push('settle'),
				onWriteError: (error) => {
					reported = error;
					order.push('report');
				},
			});
			finish(writeError);
			assert.deepStrictEqual(order, ['report', 'release', 'settle']);
			assert.strictEqual(reported, writeError, 'the write error is reported verbatim');
		});

		it('settles on its own when the write callback never arrives (the bound)', async () => {
			const order = [];
			let timedOut = false;
			createPendingMarkerBarrier({
				timeoutMs: 10,
				release: () => order.push('release'),
				settle: () => order.push('settle'),
				onTimeout: () => {
					timedOut = true;
				},
			});
			// Deliberately never call finish — this is the wedged-volume shape.
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.ok(timedOut, 'the fallback must report that it fired');
			assert.deepStrictEqual(order, ['release', 'settle'], 'the fallback must release then settle');
		});

		it('never releases twice when a late write callback lands after the fallback fired', async () => {
			let releases = 0;
			let settles = 0;
			const finish = createPendingMarkerBarrier({
				timeoutMs: 10,
				release: () => releases++,
				settle: () => settles++,
			});
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.strictEqual(releases, 1, 'the fallback released once');
			finish(); // the stalled write finally calls back
			finish(new Error('late error'));
			assert.strictEqual(releases, 1, 'a late callback must NOT release a lock another writer may hold');
			assert.strictEqual(settles, 1, 'and must not settle twice');
		});
	});

	it('#481: an app-supplied (unarmed) source-stream abort is NOT marked PENDING (gate excludes one-shot streams)', async () => {
		// Same abort shape, but the source is NOT armed with blobStreamIdleTimeoutMs — an ordinary app write,
		// not a replication receive. The abort branch must NOT stamp it PENDING: nothing will ever re-stream
		// those bytes, so a 503 (retry) read would hold forever (the #429 wedge). It stays the prior behavior.
		const store = BlobTest.primaryStore.rootStore;
		const source = new PassThrough();
		const blob = await createBlob(source, { size: 20000 });
		const saving = decodeFromDatabase(() => saveBlob(blob).saving, store);
		source.write(randomBytes(4000));
		await new Promise((resolve) => setTimeout(resolve, 20));
		source.destroy(new Error('connection reset'));
		await assert.rejects(Promise.resolve(saving));
		await new Promise((resolve) => setTimeout(resolve, 50)); // let any async abort-path write land
		await assert.rejects(blob.bytes(), (error) => {
			assert.notStrictEqual(error.statusCode, 503, 'an unarmed app-stream abort must not become a retriable 503');
			return true;
		});
		const filePath = getFilePathForBlob(blob);
		if (existsSync(filePath)) unlinkSync(filePath);
	});
	it('#1424: bytes() rejects a file corrupted below the header rather than returning garbage (T3)', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		// overwrite with fewer than HEADER_SIZE bytes, with byte[1] = DEFLATE_TYPE — the case that
		// previously decompressed an empty body into ~8 garbage bytes returned as valid content.
		const fd = openSync(filePath, 'r+');
		try {
			writeSync(fd, Buffer.from([0, 1, 0]), 0, 3, 0);
			ftruncateSync(fd, 3);
		} finally {
			closeSync(fd);
		}
		await assert.rejects(blob.bytes(), (error) => {
			assert.equal(error.statusCode, 500);
			return true;
		});
	});
	it('#1423: reading a cleanly-missing blob file returns a prompt 404 (with an ENOENT code for old consumers)', async () => {
		const { blob, filePath } = await makeDiskBackedBlob();
		unlinkSync(filePath);
		// The 404 also carries `code: 'ENOENT'` so a consumer that only understands `error.code` — e.g. an
		// older replication receiver predating the statusCode taxonomy — still classifies a missing source
		// blob as a permanent absence and advances its resume cursor (harper-pro#403/#405) instead of wedging.
		await assert.rejects(blob.bytes(), (error) => {
			assert.equal(error.statusCode, 404);
			assert.equal(error.code, 'ENOENT');
			return true;
		});
		await assert.rejects(streamToBuffer(blob.stream()), (error) => {
			assert.equal(error.statusCode, 404);
			assert.equal(error.code, 'ENOENT');
			return true;
		});
	});
	it('#1423: a missing file with an in-progress writer times out as 503 instead of hanging', async () => {
		const { blob, filePath, store } = await makeDiskBackedBlob();
		const lockKey = getFileId(blob) + ':blob';
		assert(store.tryLock(lockKey), 'should be able to take the blob write lock for the test');
		try {
			unlinkSync(filePath); // file gone while a "writer" still holds the lock
			// Set as a string, the way an env-var config override arrives: getBlobReadTimeout must coerce it
			// to a number, or `Date.now() + '150'` would concatenate into a far-future deadline (the timeout
			// would never fire). Pre-coercion this assertion would hang instead of rejecting promptly.
			env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, '150');
			const started = Date.now();
			await assert.rejects(streamToBuffer(blob.stream()), (error) => {
				assert.equal(error.statusCode, 503);
				return true;
			});
			assert(Date.now() - started < 5000, 'read should fail promptly, not hang');
		} finally {
			store.unlock(lockKey);
			env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, undefined);
		}
	});
	it('#1454: a present-but-truncated blob with a writer still holding the lock fails 503 instead of spinning forever', async () => {
		// The prod-dyn/prod-gar CPU storm: a blob file is present, its header records the full descriptor
		// size (so the #1424 cross-check passes), but the body was never fully written — and the writer's
		// lock still reads as held (a live replication write stalled on a wedged source stream, so it never
		// reached unlock(); the lock is in-process and freed on unlock()/handle close, so a *dead* writer
		// can't cause this — only a stalled live one). The reader
		// catches up to the short body, sees `size > totalContentRead`, and — because the header size is
		// "known" — resumeIfWriterFinished() re-entered readMore() with no backoff and no deadline,
		// busy-spinning the worker at ~100% CPU. Pre-fix this read never resolves and this test hangs.
		const { blob, filePath, store } = await makeDiskBackedBlob();
		const lockKey = getFileId(blob) + ':blob';
		assert(store.tryLock(lockKey), 'should be able to take the blob write lock for the test');
		try {
			// Cut the body short but leave the header (full size, == descriptor) intact — the case the
			// #1424 descriptor cross-check cannot catch, distinct from truncateBlobConsistently above.
			const fd = openSync(filePath, 'r+');
			try {
				ftruncateSync(fd, HEADER_SIZE + 256);
			} finally {
				closeSync(fd);
			}
			env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, '150');
			const started = Date.now();
			await assert.rejects(streamToBuffer(blob.stream()), (error) => {
				assert.equal(error.statusCode, 503);
				return true;
			});
			assert(Date.now() - started < 5000, 'read should fail promptly, not spin');
		} finally {
			store.unlock(lockKey);
			env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, undefined);
		}
	});
	it('#481: register/unregister blob receive-in-flight is refcounted and null-safe', () => {
		const store = BlobTest.primaryStore.rootStore;
		const fileId = 'testfile-481-refcount';
		assert.equal(isBlobReceiveInFlight(fileId, store), false, 'unknown id is not in flight');
		registerBlobReceiveInFlight(fileId, store);
		registerBlobReceiveInFlight(fileId, store);
		assert.equal(isBlobReceiveInFlight(fileId, store), true, 'in flight after registration');
		unregisterBlobReceiveInFlight(fileId, store);
		assert.equal(isBlobReceiveInFlight(fileId, store), true, 'still in flight while one receive remains');
		unregisterBlobReceiveInFlight(fileId, store);
		assert.equal(isBlobReceiveInFlight(fileId, store), false, 'not in flight once all receives unregister');
		// An extra unregister on an already-clean id is a no-op, not a negative count.
		unregisterBlobReceiveInFlight(fileId, store);
		assert.equal(isBlobReceiveInFlight(fileId, store), false, 'unregister below zero is a no-op');
		// Falsy fileIds and missing store must not corrupt the registry.
		registerBlobReceiveInFlight('', store);
		registerBlobReceiveInFlight(undefined, store);
		registerBlobReceiveInFlight(fileId, undefined);
		assert.equal(isBlobReceiveInFlight('', store), false, 'empty fileId is ignored');
		assert.equal(isBlobReceiveInFlight(fileId, undefined), false, 'no store falls through to false');
	});
	it('#481: an ENOENT during an in-flight replication receive returns 503, not 404', async () => {
		// A peer asks for a blob whose receive has been announced but the file hasn't landed yet.
		// Pre-fix returned 404 (permanent); the registry flips it to 503 so the requester retries.
		const { blob, filePath, store } = await makeDiskBackedBlob();
		const fileId = getFileId(blob);
		unlinkSync(filePath);
		env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, '150');
		try {
			registerBlobReceiveInFlight(fileId, store);
			try {
				await assert.rejects(streamToBuffer(blob.stream()), (error) => {
					assert.equal(error.statusCode, 503, 'in-flight receive maps ENOENT to 503');
					return true;
				});
			} finally {
				unregisterBlobReceiveInFlight(fileId, store);
			}
			// Once the receive clears, a cleanly-missing file falls back to 404.
			await assert.rejects(streamToBuffer(blob.stream()), (error) => {
				assert.equal(error.statusCode, 404, 'cleanly-missing blob still 404 once receive clears');
				assert.equal(error.code, 'ENOENT');
				return true;
			});
		} finally {
			env.setProperty(CONFIG_PARAMS.STORAGE_BLOBREADTIMEOUT, undefined);
		}
	});
	afterEach(function () {
		setAuditRetention(60000);
		setDeletionDelay(50); // restore shorter, but need to have it happen for the last test
	});
	after(function () {
		setDeletionDelay(500); // restore original
	});
});

describe('saveBlob with idle source stream (replication wedge regression)', () => {
	let WedgeTable;
	let savedIdleTimeoutEnv;
	before(function () {
		setupTestDBPath();
		// Enable the source-stream idle timeout for these tests so the wedge case has a finite
		// settle deadline. The value must be short enough that the 'never-ended' test settles
		// inside its 3s wait.
		savedIdleTimeoutEnv = process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS;
		process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS = '1500';
		WedgeTable = table({
			table: 'WedgeTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});
	after(function () {
		if (savedIdleTimeoutEnv === undefined) delete process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS;
		else process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS = savedIdleTimeoutEnv;
	});

	it('settles saveBlob.saving when the source PassThrough was destroyed before save started', async () => {
		// Mirrors the replication-receive race: the BLOB_CHUNK handler creates a PassThrough in
		// blobsInFlight; a later chunk with `finished:true, error:"..."` calls stream.destroy(err).
		// When the audit entry then arrives, receiveBlobs retrieves the destroyed stream and
		// saveBlob's pipeline runs over an already-destroyed source. Without the idle watchdog,
		// pipeline() may not observe the destroy, saveBlob.saving never settles, and the per-
		// (sender, receiver, database) replication tuple wedges at status "Receiving".
		const stream = new PassThrough();
		stream.on('error', () => {}); // suppress 'unhandled error' from the manual destroy
		stream.destroy(new Error('Blob error: simulated upstream tear-down'));
		const blob = await createBlob(stream);
		const info = decodeFromDatabase(() => saveBlob(blob), WedgeTable.primaryStore.rootStore);

		let state = 'pending';
		// eslint-disable-next-line promise/catch-or-return
		(info.saving ?? Promise.resolve())
			.then(() => {
				state = 'resolved';
			})
			.catch(() => {
				state = 'rejected';
			});

		await delay(2000);
		assert.notStrictEqual(
			state,
			'pending',
			'saveBlob.saving never settled; in replication this wedges the per-database receive consumer indefinitely'
		);
	});

	it('settles saveBlob.saving when the source stream has chunks but is never ended', async () => {
		// Production scenario: a sender's BLOB_CHUNK frames arrive partial. Some content lands but
		// the closing `finished:true` (or error) frame never does. The PassThrough sits idle:
		// neither ended nor destroyed. Without the idle watchdog, pipeline waits forever and the
		// tracked saveBlob.saving promise pins outstandingBlobsToFinish, stalling the apply
		// consumer's drain await with no log signature.
		const stream = new PassThrough();
		stream.write(Buffer.from('chunk-but-no-finish'));
		// NO destroy, NO end: prod-observed state of an abandoned blob stream.

		const blob = await createBlob(stream);
		const info = decodeFromDatabase(() => saveBlob(blob), WedgeTable.primaryStore.rootStore);

		let state = 'pending';
		// eslint-disable-next-line promise/catch-or-return
		(info.saving ?? Promise.resolve())
			.then(() => {
				state = 'resolved';
			})
			.catch(() => {
				state = 'rejected';
			});

		await delay(3000);
		assert.notStrictEqual(
			state,
			'pending',
			'saveBlob.saving did not settle within 3s for an idle source stream; pipeline waits forever and wedges the per-database replication apply consumer (production: lastReceivedStatus stuck on "Receiving")'
		);
	});

	it('settles when a mid-stream chunk arrives, then a destroy, then no further chunks', async () => {
		// More faithful repro of the receive path: PassThrough is created in blobsInFlight, some
		// chunks arrive, the stream is destroyed (e.g. by a sender-side error frame), then
		// saveBlob is started by the audit-record receive. No further chunks ever land. In the
		// production receiver this leaves pipeline() waiting on a torn-down source that never
		// ends nor errors from this side, holding outstandingBlobsToFinish forever.
		const stream = new PassThrough();
		stream.on('error', () => {});

		stream.write(Buffer.from('partial-blob-payload-'));
		stream.destroy(new Error('Blob error: simulated tear-down mid-stream'));

		const blob = await createBlob(stream);
		const info = decodeFromDatabase(() => saveBlob(blob), WedgeTable.primaryStore.rootStore);

		let state = 'pending';
		// eslint-disable-next-line promise/catch-or-return
		(info.saving ?? Promise.resolve())
			.then(() => {
				state = 'resolved';
			})
			.catch(() => {
				state = 'rejected';
			});

		await delay(3000);
		assert.notStrictEqual(
			state,
			'pending',
			'saveBlob.saving never settled with a partially-written-then-destroyed source: replication wedge'
		);
	});
});

describe('saveBlob source-idle watchdog is opt-in (off by default, per-stream arm)', () => {
	let OptInTable;
	let savedIdleTimeoutEnv;
	before(function () {
		setupTestDBPath();
		// Deliberately NO HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS: the watchdog must be OFF unless the owning
		// caller arms the specific source. writeBlobWithStream is the generic primitive for every blob
		// write (HTTP upload, origin-fetch cache fill, replication receive); bounding a source is the
		// caller's job, not the primitive's. (The process-wide env override is exercised in the block above.)
		savedIdleTimeoutEnv = process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS;
		delete process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS;
		OptInTable = table({
			table: 'OptInTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});
	after(function () {
		if (savedIdleTimeoutEnv === undefined) delete process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS;
		else process.env.HARPER_BLOB_STREAM_IDLE_TIMEOUT_MS = savedIdleTimeoutEnv;
	});

	it('does NOT destroy an unarmed idle source (a slow non-replication write is left alone)', async () => {
		const stream = new PassThrough();
		stream.write(Buffer.from('slow-source-no-arm')); // chunk lands, never ended, never armed
		const blob = await createBlob(stream);
		const info = decodeFromDatabase(() => saveBlob(blob), OptInTable.primaryStore.rootStore);
		let state = 'pending';
		// eslint-disable-next-line promise/catch-or-return
		(info.saving ?? Promise.resolve()).then(() => (state = 'resolved')).catch(() => (state = 'rejected'));
		await delay(1500);
		assert.strictEqual(state, 'pending', 'an unarmed idle source must NOT be force-destroyed by the watchdog');
		stream.destroy(); // clean up the deliberately-stuck write so the blob lock is released
		await delay(50);
	});

	it('settles when the owning caller arms the source via stream.blobStreamIdleTimeoutMs', async () => {
		// How the replication receive path opts in: it sets this on its PassThrough; other callers stay off.
		const stream = new PassThrough();
		stream.blobStreamIdleTimeoutMs = 800;
		stream.on('error', () => {});
		stream.write(Buffer.from('armed-but-never-finished')); // chunk lands, then idle, never ended
		const blob = await createBlob(stream);
		const info = decodeFromDatabase(() => saveBlob(blob), OptInTable.primaryStore.rootStore);
		let state = 'pending';
		// eslint-disable-next-line promise/catch-or-return
		(info.saving ?? Promise.resolve()).then(() => (state = 'resolved')).catch(() => (state = 'rejected'));
		await delay(2500);
		assert.notStrictEqual(state, 'pending', 'an armed idle source should be destroyed within its timeout and settle');
	});
});

describe('shouldDestroyIdleBlobSource (paused-source progress gate)', () => {
	it('destroys a non-paused idle source regardless of bytes (true source idle: no data, no end)', () => {
		assert.strictEqual(shouldDestroyIdleBlobSource(false, 100, 100), true);
		assert.strictEqual(shouldDestroyIdleBlobSource(false, 200, 100), true);
		assert.strictEqual(shouldDestroyIdleBlobSource(false, 0, 0), true);
	});

	it('leaves a paused source alone while the destination is still draining (slow-but-live writeStream)', () => {
		// bytesWritten advanced since the last arm → real progress → re-arm, do not destroy.
		assert.strictEqual(shouldDestroyIdleBlobSource(true, 4096, 1024), false);
		assert.strictEqual(shouldDestroyIdleBlobSource(true, 1025, 1024), false);
	});

	it('destroys a paused source that made zero downstream progress over the interval (genuine wedge)', () => {
		// Paused on backpressure but the writeStream never advanced for the whole timeout: the disk-write
		// pipeline that never drains — the 19h prerender blob-replication wedge. Must be torn down.
		assert.strictEqual(shouldDestroyIdleBlobSource(true, 1024, 1024), true);
		assert.strictEqual(shouldDestroyIdleBlobSource(true, 0, 0), true);
	});
});

describe('blobFileMissingOrIncomplete (copy-apply duplicate-repair gate, harper-pro#699)', () => {
	let BlobRepairTest;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		BlobRepairTest = table({
			table: 'BlobRepairTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
	});
	async function savedBlob(id, source = Readable.from(randomBytes(25000))) {
		const blob = await createBlob(source);
		await BlobRepairTest.put({ id, blob });
		const record = await BlobRepairTest.get(id);
		const filePath = getFilePathForBlob(record.blob);
		assert.ok(filePath && existsSync(filePath));
		return { blob: record.blob, filePath, store: BlobRepairTest.primaryStore.rootStore };
	}
	function stampHeaderType(filePath, type) {
		const fd = openSync(filePath, 'r+');
		try {
			writeSync(fd, Buffer.from([0, type]), 0, 2, 0);
		} finally {
			closeSync(fd);
		}
	}

	it('reports an intact saved blob as complete', async () => {
		const { blob } = await savedBlob('intact');
		assert.strictEqual(blobFileMissingOrIncomplete(blob), false);
	});

	it('reports a missing backing file', async () => {
		const { blob, filePath } = await savedBlob('missing');
		unlinkSync(filePath);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports a PENDING-stamped stub (aborted re-streamable receive, harper-pro#481)', async () => {
		const { blob, filePath } = await savedBlob('pending');
		stampHeaderType(filePath, 0xfe);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports an ERROR-stamped stub (same classification as the repair sweep)', async () => {
		const { blob, filePath } = await savedBlob('errstub');
		stampHeaderType(filePath, 0xff);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports a file truncated below its header', async () => {
		const { blob, filePath } = await savedBlob('short');
		const fd = openSync(filePath, 'r+');
		try {
			ftruncateSync(fd, 4);
		} finally {
			closeSync(fd);
		}
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports an uncompressed file shorter than its header claims', async () => {
		const { blob, filePath } = await savedBlob('torn');
		const fd = openSync(filePath, 'r+');
		try {
			ftruncateSync(fd, statSync(filePath).size - 1);
		} finally {
			closeSync(fd);
		}
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports an uncompressed file longer than its header claims', async () => {
		const { blob, filePath } = await savedBlob('long');
		writeFileSync(filePath, Buffer.concat([readFileSync(filePath), Buffer.from([0])]));
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports a self-consistent file whose header disagrees with the record descriptor', async () => {
		const { blob, filePath } = await savedBlob('descriptor-size-mismatch', randomBytes(25000));
		writeFileSync(filePath, Buffer.concat([makeBlobHeader(100), randomBytes(100)]));
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports an unknown header type', async () => {
		const { blob, filePath } = await savedBlob('unknown-type');
		stampHeaderType(filePath, 2);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('reports a save that never completed (pre-completion size sentinel)', async () => {
		const { blob, filePath } = await savedBlob('sentinel');
		const fd = openSync(filePath, 'r+');
		try {
			writeSync(fd, Buffer.from([0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0, 8, 0);
		} finally {
			closeSync(fd);
		}
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('returns undefined for a blob with no repair question to answer (unsaved/inline)', async () => {
		const blob = await createBlob(Readable.from(randomBytes(64)));
		assert.strictEqual(blobFileMissingOrIncomplete(blob), undefined);
	});

	it('repairBlobFile streams replacement bytes INTO the existing fileId of a damaged blob', async () => {
		const { blob, filePath } = await savedBlob('repair-target');
		const original = readFileSync(filePath);
		stampHeaderType(filePath, 0xfe); // PENDING stub: the dangling state harper-pro#699 heals
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
		const source = new PassThrough();
		let sourceSize;
		const saving = repairBlobFile(blob, source, () => sourceSize);
		assert.ok(saving, 'repair should start on a damaged blob');
		assert.strictEqual(isSaving(blob), undefined, 'repair must not publish into the normal blob-save gate');
		sourceSize = original.length - 8;
		source.end(original.subarray(8));
		await saving;
		assert.strictEqual(getFilePathForBlob(blob), filePath); // same fileId — record needs no rewrite
		assert.strictEqual(existsSync(filePath + '.repair'), false);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), false);
		assert.deepStrictEqual(readFileSync(filePath).subarray(8), original.subarray(8));
	});

	it('repairBlobFile declines when the source reports a size unlike the stored descriptor', async () => {
		const { blob, filePath } = await savedBlob('repair-advertised-size-mismatch', randomBytes(25000));
		stampHeaderType(filePath, 0xfe);
		assert.strictEqual(repairBlobFile(blob, Readable.from(randomBytes(24999)), 24999), undefined);
		assert.strictEqual(readFileSync(filePath)[1], 0xfe);
		assert.strictEqual(existsSync(filePath + '.repair'), false);
	});

	it('repairBlobFile rejects a late source-size mismatch without replacing the file', async () => {
		const { blob, filePath } = await savedBlob('repair-late-size-mismatch', randomBytes(25000));
		stampHeaderType(filePath, 0xfe);
		const saving = repairBlobFile(blob, Readable.from(randomBytes(25000)), () => 24999);
		assert.ok(saving, 'repair should start before the stream reports its final size');
		await assert.rejects(saving, /Blob repair source size mismatch/);
		assert.strictEqual(readFileSync(filePath)[1], 0xfe);
		assert.strictEqual(existsSync(filePath + '.repair'), false);
	});

	it('repairBlobFile contains a throwing source-size getter and releases both locks', async () => {
		const { blob, filePath, store } = await savedBlob('repair-source-size-error', randomBytes(25000));
		stampHeaderType(filePath, 0xfe);
		const saving = repairBlobFile(blob, Readable.from(randomBytes(25000)), () => {
			throw new Error('source size unavailable');
		});
		assert.ok(saving, 'repair should return its rejected settle promise');
		await assert.rejects(saving, /source size unavailable/);
		for (const lockKey of [getFileId(blob) + ':blob', filePath + '.repair:blob']) {
			assert.ok(store.tryLock(lockKey), `${lockKey} should be released`);
			store.unlock(lockKey);
		}
		assert.strictEqual(readFileSync(filePath)[1], 0xfe);
		assert.strictEqual(existsSync(filePath + '.repair'), false);
	});

	it('repairBlobFile recreates a missing bucket directory', async () => {
		const { blob, filePath } = await savedBlob('repair-missing-directory');
		const original = readFileSync(filePath);
		const fileDir = dirname(filePath);
		const backupDir = fileDir + '-repair-backup';
		renameSync(fileDir, backupDir);
		try {
			const saving = repairBlobFile(blob, Readable.from(original.subarray(8)), original.length - 8);
			assert.ok(saving, 'repair should start when the bucket directory is missing');
			await saving;
			assert.deepStrictEqual(readFileSync(filePath).subarray(8), original.subarray(8));
		} finally {
			rmSync(fileDir, { recursive: true, force: true });
			renameSync(backupDir, fileDir);
		}
	});

	it('repairBlobFile rejects a wrong-size source without finalizing the file', async () => {
		const { blob, filePath } = await savedBlob('repair-size-mismatch', randomBytes(25000));
		stampHeaderType(filePath, 0xfe);
		const saving = repairBlobFile(blob, Readable.from(randomBytes(100)), 25000);
		assert.ok(saving, 'repair should start on a damaged blob');
		await assert.rejects(saving, /Blob repair size mismatch/);
		await waitFor(() => readFileSync(filePath)[1] === 0xfe, {
			message: 'failed repair should leave a PENDING marker',
		});
		assert.strictEqual(blobFileMissingOrIncomplete(blob), true);
	});

	it('repairBlobFile declines when the stored descriptor has no verification size', async () => {
		const { blob, filePath } = await savedBlob('repair-unknown-size');
		stampHeaderType(filePath, 0xfe);
		blob.size = undefined;
		assert.strictEqual(repairBlobFile(blob, Readable.from(randomBytes(100))), undefined);
	});

	it('repairBlobFile releases its lock when stream setup throws', async () => {
		const { blob, filePath, store } = await savedBlob('repair-stream-setup-error');
		const lockKey = getFileId(blob) + ':blob';
		stampHeaderType(filePath, 0xfe);
		const saving = repairBlobFile(blob, {}, statSync(filePath).size - 8);
		assert.ok(saving, 'repair should return its rejected settle promise');
		await assert.rejects(saving);
		assert.strictEqual(
			isSaving(blob),
			undefined,
			'failed repair should not poison later writes with a stale rejection'
		);
		assert.strictEqual(readFileSync(filePath)[1], 0xfe, 'failed setup must preserve the referenced PENDING file');
		assert.strictEqual(existsSync(filePath + '.repair'), false);
		await waitFor(
			() => {
				if (!store.tryLock(lockKey)) return false;
				store.unlock(lockKey);
				return true;
			},
			{ message: 'failed stream setup should release the blob lock' }
		);
	});

	it('repairBlobFile leaves the referenced file untouched while replacement bytes are still arriving', async () => {
		const { blob, filePath } = await savedBlob('repair-in-flight');
		const source = new PassThrough();
		stampHeaderType(filePath, 0xfe);
		const saving = repairBlobFile(blob, source, 25000);
		assert.ok(saving, 'repair should start on a damaged blob');
		source.write(randomBytes(100));
		await waitFor(() => existsSync(filePath + '.repair') && statSync(filePath + '.repair').size > 8, {
			message: 'replacement bytes should land in the temporary repair file',
		});
		assert.strictEqual(readFileSync(filePath)[1], 0xfe);
		await cleanupOrphans(getDatabases().test);
		assert.strictEqual(existsSync(filePath + '.repair'), true, 'orphan cleanup must preserve an active repair');
		source.destroy(new Error('stop in-flight repair'));
		await assert.rejects(saving, /stop in-flight repair/);
		assert.strictEqual(readFileSync(filePath)[1], 0xfe);
		assert.strictEqual(existsSync(filePath + '.repair'), false);
	});

	it('cleanupOrphans removes a stale repair file', async () => {
		const { filePath } = await savedBlob('stale-repair-file');
		writeFileSync(filePath + '.repair', randomBytes(16));
		await cleanupOrphans(getDatabases().test);
		assert.strictEqual(existsSync(filePath + '.repair'), false);
	});

	it('repairBlobFile accepts uncompressed replacement bytes for a compressed stored blob', async () => {
		const payload = Buffer.from('repair compressed blob '.repeat(2000));
		const created = createBlob(payload, { compress: true });
		await BlobRepairTest.put({ id: 'repair-compressed', blob: created });
		const { blob } = await BlobRepairTest.get('repair-compressed');
		const filePath = getFilePathForBlob(blob);
		stampHeaderType(filePath, 0xfe);
		const saving = repairBlobFile(blob, Readable.from(payload), payload.length);
		assert.ok(saving, 'repair should start on a damaged compressed blob');
		await saving;
		assert.strictEqual(readFileSync(filePath).readUInt16BE(0), 0);
		assert.deepStrictEqual(await blob.bytes(), payload);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), false);
	});

	it('leaves a truncated compressed body for the asynchronous repair sweep to verify', async () => {
		const payload = Buffer.from('truncated compressed blob '.repeat(2000));
		await BlobRepairTest.put({ id: 'compressed-damage-probe', blob: createBlob(payload, { compress: true }) });
		const { blob } = await BlobRepairTest.get('compressed-damage-probe');
		const filePath = getFilePathForBlob(blob);
		truncateSync(filePath, statSync(filePath).size - 1);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), false);
	});

	it('repairBlobFile preserves the referenced PENDING file before a competing writer acquires the lock', async () => {
		const { blob, filePath, store } = await savedBlob('repair-restamp-race');
		const original = readFileSync(filePath);
		const lockKey = getFileId(blob) + ':blob';
		stampHeaderType(filePath, 0xfe);
		const originalUnlock = store.unlock;
		let armCompetingWriter = false;
		let competingWriterHeld = false;
		let competingWriterAcquired = false;
		let headerTypeAtUnlock;
		store.unlock = function (key, ...args) {
			if (armCompetingWriter && key === lockKey) headerTypeAtUnlock = readFileSync(filePath)[1];
			const result = originalUnlock.call(this, key, ...args);
			if (armCompetingWriter && key === lockKey && !competingWriterHeld) {
				competingWriterAcquired = store.tryLock(lockKey);
				if (competingWriterAcquired) {
					competingWriterHeld = true;
					writeFileSync(filePath, original);
				}
			}
			return result;
		};
		try {
			const source = new PassThrough();
			const saving = repairBlobFile(blob, source, original.length - 8);
			assert.ok(saving, 'repair should start on a damaged blob');
			armCompetingWriter = true;
			source.destroy(new Error('repair failed'));
			await assert.rejects(saving, /repair failed/);
			await waitFor(() => competingWriterAcquired, {
				message: 'competing writer should acquire the released repair lock',
			});
			assert.strictEqual(headerTypeAtUnlock, 0xfe, 'repair must preserve PENDING before releasing its lock');
			assert.ok(competingWriterAcquired, 'competing writer should acquire the released repair lock');
			assert.ok(competingWriterHeld);
			assert.deepStrictEqual(readFileSync(filePath), original);
		} finally {
			store.unlock = originalUnlock;
			if (competingWriterHeld) originalUnlock.call(store, lockKey);
		}
	});

	it('repairBlobFile declines without touching the file while another writer holds the lock', async () => {
		const { blob, filePath, store } = await savedBlob('repair-lock-busy');
		const lockKey = getFileId(blob) + ':blob';
		stampHeaderType(filePath, 0xfe);
		assert.ok(store.tryLock(lockKey));
		try {
			assert.strictEqual(repairBlobFile(blob, Readable.from(randomBytes(16)), 16), undefined);
			assert.strictEqual(readFileSync(filePath)[1], 0xfe);
			assert.strictEqual(existsSync(filePath + '.repair'), false);
		} finally {
			store.unlock(lockKey);
		}
	});

	it('repairBlobFile declines on a healthy blob', async () => {
		const { blob } = await savedBlob('repair-healthy');
		assert.strictEqual(repairBlobFile(blob, Readable.from(randomBytes(16))), undefined);
	});

	it('repairBlobFile declines a slice that shares its parent backing file', async () => {
		const { blob, filePath } = await savedBlob('repair-slice', randomBytes(25000));
		const slice = blob.slice(0, 1000);
		assert.strictEqual(getFilePathForBlob(slice), filePath);
		assert.strictEqual(repairBlobFile(slice, Readable.from(randomBytes(1000)), 1000), undefined);
		assert.strictEqual(blobFileMissingOrIncomplete(blob), false);
	});

	it('repairBlobFile declines on an unsaved blob', async () => {
		const blob = await createBlob(Readable.from(randomBytes(64)));
		assert.strictEqual(repairBlobFile(blob, Readable.from(randomBytes(16))), undefined);
	});
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms)); // wait for audit log removal and deletion
}
async function streamToBuffer(stream) {
	let retrievedDataFromStream = [];
	for await (const chunk of stream) {
		retrievedDataFromStream.push(chunk);
	}
	return Buffer.concat(retrievedDataFromStream).toString();
}

async function streamToBytes(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
