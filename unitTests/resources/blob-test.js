require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Readable } = require('node:stream');
const { setAuditRetention } = require('../../resources/auditStore');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { getFilePathForBlob, setDeletionDelay } = require('../../resources/blob');
const { existsSync } = require('fs');

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
		blob = await createBlob(Readable.from(testString));
		await BlobTest.put({ id: 1, blob });
		record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		retrievedText = await record.blob.text();
		assert.equal(retrievedText, testString);
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
		let blob = await createBlob(
			Readable.from(
				(async function* () {
					for (let i = 0; i < 5; i++) {
						yield testString;
						await delay(50);
					}
				})()
			)
		);
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedText = await record.blob.text();
		assert.equal(retrievedText, testString.repeat(5));
	});
	it('invalid blob attempts', async () => {
		assert.throws(() => {
			createBlob(undefined);
		});
	});
	afterEach(function () {
		setAuditRetention(60000);
		setDeletionDelay(500);
	});
});
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms)); // wait for audit log removal and deletion
}
