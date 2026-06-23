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
	getFilePathForBlob,
	setDeletionDelay,
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
} = require('#src/resources/blob');
const { existsSync, unlinkSync, openSync, writeSync, ftruncateSync, closeSync } = require('fs');
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
		assert.notEqual(filePath, getFilePathForBlob(blob)); // it should be a new file path
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
		assert.notEqual(filePath, getFilePathForBlob(blob)); // it should be a new file path
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
		assert(packResult.then); // shouldn't be resolved yet
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
	it('Abort reading a blob', async () => {
		let testString = 'this is a test string for deletion'.repeat(800);
		let blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 3, blob });
		for await (let _entry of blob.stream()) {
			break;
		}
		// just make sure there is no error
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
		await BlobTest.put({ id: 5, blob });
		let eventError, thrownError;
		blob.on('error', (err) => {
			console.log('received error event');
			eventError = err;
		});
		try {
			await blob.written;
		} catch {}
		try {
			for await (let _entry of blob.stream()) {
				console.log('got entry');
			}
		} catch (err) {
			thrownError = err;
		}
		assert(thrownError);
		assert(eventError);
		thrownError = null;
		eventError = null;
		let record = await BlobTest.get(5);
		record.blob.on('error', (err) => {
			eventError = err;
		});
		try {
			for await (let _entry of record.blob.stream()) {
			}
		} catch (err) {
			thrownError = err;
		}
		assert(thrownError);
		assert(eventError);
	});
	it('Error before streaming', async () => {
		let pt = new PassThrough();
		pt.on('error', () => {}); // ignore the uncaught error
		pt.destroy(new Error('test error'));
		let blob = createBlob(pt);
		await BlobTest.put({ id: 6, blob });
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
		thrownError = null;
		eventError = null;

		let record = await BlobTest.get(6);
		record.blob.on('error', (err) => {
			eventError = err;
		});
		try {
			for await (let _entry of record.blob.stream()) {
			}
		} catch (err) {
			thrownError = err;
		}
		assert(thrownError);
		assert(eventError);
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
		const rejectPc = startPreCommitBlobsForRecord({ id: 1, blob: failBlob }, store, false, true);
		failStream.destroy(new Error('disk full')); // no sourceBlobUnavailable marker
		await assert.rejects(
			rejectPc.complete(),
			'a local/transient save fault on a needs-saving blob must still abort the commit'
		);

		// source-unavailable → the replication marker is tolerated even on the awaited needs-saving path,
		// so the record still commits with a diverged reference.
		const goneStream = new PassThrough();
		const goneBlob = await createBlob(goneStream, { saveBeforeCommit: true });
		const toleratePc = startPreCommitBlobsForRecord({ id: 2, blob: goneBlob }, store, false, true);
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
	it('cleanupUnusedBlobs is a no-op for unsaved blobs and clears the list', () => {
		const unsavedBlob = createBlob(Buffer.from('not yet saved'));
		const list = [unsavedBlob];
		cleanupUnusedBlobs(list);
		assert.equal(list.length, 0); // list cleared so subsequent abort/skip calls are no-ops
		cleanupUnusedBlobs(list); // does not throw on empty list
		cleanupUnusedBlobs(undefined); // does not throw when never tracked
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
