require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Readable, PassThrough } = require('node:stream');
const { setAuditRetention } = require('../../resources/auditStore');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const {
	getFilePathForBlob,
	setDeletionDelay,
	encodeBlobsAsBuffers,
	findBlobsInObject,
	isSaving,
	cleanupOrphans,
} = require('../../resources/blob');
const { existsSync } = require('fs');
const { pack } = require('msgpackr');
const { randomBytes } = require('crypto');
const { transaction } = require('../../resources/transaction');

// might want to enable an iteration with NATS being assigned as a source
//const { setNATSReplicator } = require('../../server/nats/natsReplicator');
describe('Blob test', () => {
	let BlobTest;
	before(async function () {
		getMockLMDBPath();
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
		assert.throws(() => {
			// should not be able to use the blob in a different record
			BlobTest.put({ id: 2, blob });
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
	it('create a blob from a buffer and save it before committing it using save() method', async () => {
		let random = randomBytes(5000 * Math.random() + 20000);
		let blob = createBlob(random);
		await blob.save(BlobTest);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedBytes = await record.blob.bytes();
		assert(retrievedBytes.equals(random));
		assert.equal(record.blob.size, random.length);
	});
	it('create a blob from a buffer and call save() but then abort', async () => {
		let blob;
		try {
			await transaction({}, async () => {
				let random = randomBytes(5000 * Math.random() + 20000);
				blob = createBlob(random);
				blob.save(BlobTest);
				throw new Error('test error'); // abort the transaction
			});
		} catch (error) {}
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
		assert(existsSync(filePath)); // should not immediately be deleted
		BlobTest.auditStore.scheduleAuditCleanup(1); // prune audit log, so the blob is actually deleted
		await delay(60); // wait for audit log removal and deletion
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
					for (let i = 0; i < 5; i++) {
						yield testString + i;
						expectedResults += testString + i;
						await delay(50);
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
		for await (let entry of blob.stream()) {
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
		let blob = await createBlob(new BadStream());
		await BlobTest.put({ id: 5, blob });
		let eventError, thrownError;
		blob.on('error', (err) => {
			console.log('received error event');
			eventError = err;
		});
		console.log('testing stream of aborted blob');
		try {
			for await (let entry of blob.stream()) {
				console.log('got entry');
			}
		} catch (err) {
			thrownError = err;
		}
		assert(thrownError);
		assert(eventError);
		thrownError = null;
		eventError = null;
		console.log('testing retrieval of aborted blob');
		let record = await BlobTest.get(5);
		record.blob.on('error', (err) => {
			eventError = err;
		});
		try {
			for await (let entry of record.blob.stream()) {
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
			for await (let entry of blob.stream()) {
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
			for await (let entry of record.blob.stream()) {
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
		assert.throws(() => {
			BlobTest.put({ id: 1, blob: { name: 'not actually a blob' } });
		});
		let record = await BlobTest.get(1);
		if (record) {
			assert.throws(() => {
				record.blob = 'not a blob either';
			});
		}
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
	it('cleanupOrphans', async () => {
		let orphansDeleted = await cleanupOrphans(databases.test);
		assert(orphansDeleted < 2);
	});
	afterEach(function () {
		setAuditRetention(60000);
		setDeletionDelay(500);
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
