require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases } = require('#src/resources/databases');
const { Readable, PassThrough } = require('node:stream');
const { setAuditRetention } = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	getFilePathForBlob,
	setDeletionDelay,
	encodeBlobsAsBuffers,
	findBlobsInObject,
	isSaving,
	cleanupOrphans,
} = require('#src/resources/blob');
const { existsSync, writeFileSync } = require('fs');
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
	it('cleanupOrphans', async () => {
		let orphansDeleted = await cleanupOrphans(getDatabases().test);
		assert.equal(orphansDeleted, 0);
	});
	it('bytes() retries up to 3x then rejects when lock is free but file is incomplete', async () => {
		// Simulate a crashed-writer scenario: the blob file exists on disk with a
		// DEFAULT_HEADER (UNKNOWN_SIZE) + partial content, but no writer holds the lock.
		// bytes() should retry 3 times (100 ms each) before throwing.
		const content = Buffer.alloc(9001, 0x61); // >8192 so it is file-backed
		// Use a Readable stream source so storageInfo.contentBuffer is NOT set — otherwise
		// bytes() returns the in-memory buffer and never reads the corrupted disk file.
		const blob = await createBlob(Readable.from([content]));
		await BlobTest.put({ id: 901, blob });
		// Use the original blob object (not the decoded record.blob) to ensure we always
		// read from disk — the decoded blob may carry an in-memory contentBuffer in some
		// storage-engine / transaction-cache configurations.
		const filePath = getFilePathForBlob(blob);
		assert(filePath, 'blob should be file-backed for this test');
		// Await the blob file write to complete before corrupting — BlobTest.put only awaits
		// the DB write, not the blob stream pipeline, so without this the pipeline can race
		// and overwrite our corrupted file with the complete content.
		await isSaving(blob);
		assert(existsSync(filePath), 'blob file should exist after save');

		// Corrupt: DEFAULT_HEADER (UNKNOWN_SIZE) + partial content, as a crashed write leaves.
		// Byte[1] = 0 = UNCOMPRESSED_TYPE, matching the DEFAULT_HEADER constant in blob.ts.
		const DEFAULT_HEADER = Buffer.from([0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
		writeFileSync(filePath, Buffer.concat([DEFAULT_HEADER, content.subarray(0, 100)]));

		const start = Date.now();
		await assert.rejects(() => blob.bytes(), /incomplete blob/i);
		const elapsed = Date.now() - start;
		// 3 retries × 100 ms each = at least 300 ms
		assert(elapsed >= 290, `expected ≥300 ms of retry delay, got ${elapsed} ms`);
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
