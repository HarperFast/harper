require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases } = require('#src/resources/databases');
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
} = require('#src/resources/blob');
const { existsSync } = require('fs');
const { pack } = require('msgpackr');
const { randomBytes } = require('crypto');

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
		await delay(20); // wait for the file to be deleted
		assert(!existsSync(filePath));
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
		await delay(50);
		assert(!existsSync(filePath)); // should immediately be deleted
		BlobTest.auditStore.scheduleAuditCleanup(1); // prune audit log, so the blob is actually deleted
		let retries = 0;
		while (existsSync(filePath) && retries++ < 10) await delay(40); // wait for audit log removal and deletion
		assert(!existsSync(filePath));

		blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 4, blob });
		assert.notEqual(filePath, getFilePathForBlob(blob)); // it should be a new file path
		filePath = getFilePathForBlob(blob);
		BlobTest.auditStore.scheduleAuditCleanup(1); // prune audit log, so the blob is actually deleted
		await delay(50); // wait for audit log removal and deletion
		assert(existsSync(filePath)); // should still exist because it isn't deleted yet
		await BlobTest.delete(4);
		await delay(50); // wait for deletion
		assert(!existsSync(filePath));

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
		await delay(50); // wait for deletion
		assert(!existsSync(filePath));
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
		await delay(100); // wait for cleanup setTimeout
		assert(!existsSync(goodPath), `good blob ${goodPath} should be cleaned up by abort`);
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
		await delay(100); // wait for cleanup setTimeout
		assert(!existsSync(blobPath), `superseded blob ${blobPath} should be cleaned up`);
		// the original record value is preserved
		const existing = await BlobTest.get(250);
		assert.equal(await existing.blob.text(), 'first');
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
	afterEach(function () {
		setAuditRetention(60000);
		setDeletionDelay(50); // restore shorter, but need to have it happen for the last test
	});
	after(function () {
		setDeletionDelay(500); // restore original
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
