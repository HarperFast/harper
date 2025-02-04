require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Readable } = require('node:stream');
const { setAuditRetention } = require('../../resources/auditStore');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { getFilePathForBlob, setDeletionDelay } = require('../../resources/blob');
const { existsSync } = require('fs');
const { randomBytes } = require('crypto');

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
	it('create a blob and save it', async () => {
		let testString = 'this is a test string'.repeat(256);
		let blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedText = await record.blob.text();
		assert.equal(retrievedText, testString);
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
		let blob = await createBlob(Readable.from(random), { size: 250 });
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
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
		let retrievedText = await record.blob.text();
		assert.equal(retrievedText, expectedResults);
		assert.equal(await streamResults, expectedResults);
		assert.equal(record.blob.size, expectedResults.length);
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
					throw new Error('test error');
				}
			}
		}
		let blob = await createBlob(new BadStream());
		await BlobTest.put({ id: 5, blob });
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
	it('invalid blob attempts', async () => {
		assert.throws(() => {
			createBlob(undefined);
		});
		assert.throws(() => {
			BlobTest.put({ id: 1, blob: 'not actually a blob' });
		});
		let record = await BlobTest.get(1);
		if (record) {
			assert.throws(() => {
				record.blob = 'not a blob either';
			});
		}
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
