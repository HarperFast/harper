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
		let testString = 'this is a test string';
		for (let i = 0; i < 8; i++) {
			testString += testString;
		}
		let blob = await server.createBlob(Readable.from(testString));
		await BlobTest.put({ id: 1, blob });
		const record = await BlobTest.get(1);
		assert.equal(record.id, 1);
		assert.equal(record.blob.toString(), testString);
	});
});
