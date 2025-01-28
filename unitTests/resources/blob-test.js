require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Readable } = require('node:stream');
const { setAuditRetention } = require('../../resources/auditStore');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
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
	it('create a blob and save it', async () => {
		let testString = 'this is a test string'.repeat(256);
		let blob = await server.createBlob(Readable.from(testString));
		await BlobTest.put({ id: 1, blob });
		let record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		let retrievedText = await record.blob.text();
		assert.equal(retrievedText, testString);
		testString += testString; // modify the string
		assert.throws(() => BlobTest.put({ id: 2, blob }));
		blob = await server.createBlob(Readable.from(testString));
		await BlobTest.put({ id: 1, blob });
		record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		retrievedText = await record.blob.text();
		assert.equal(retrievedText, testString);
	});
});
