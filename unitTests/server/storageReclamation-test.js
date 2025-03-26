require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { runReclamationHandlers, setAvailableSpaceRatioGetter } = require('../../server/storageReclamation');
const { setAuditRetention } = require('../../resources/auditStore');

describe('Storage reclamation test', () => {
	let TableToReclaimFrom;
	let simulatedFreeSpace = 0.2;
	before(async function () {
		setMainIsWorker(true);
		getMockLMDBPath();
		TableToReclaimFrom = table({
			table: 'TableToReclaimFrom',
			database: 'test',
			expiration: 2000,
			eviction: 1000,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'blob', type: 'Blob' },
			],
		});
		TableToReclaimFrom.sourcedFrom({ get() {} }); // define as a caching table so it can be removed for reclamation
		let last;
		for (let i = 1; i < 100; i++) {
			let testString = 'this is a test string'.repeat(i * 4 + 200);
			// create a blob, verify reclamation works with them
			let blob = await createBlob(Buffer.from(testString), { type: 'text/plain' });
			last = TableToReclaimFrom.put(
				{ id: i, blob },
				{
					expiresAt: Date.now() + i,
				}
			);
		}
		await last;
		setAvailableSpaceRatioGetter(() => simulatedFreeSpace);
	});
	it('Run reclamation and verify things are removed', async () => {
		await runReclamationHandlers();
		const recordCount = await TableToReclaimFrom.getRecordCount();
		console.log('recordCount.recordCount', recordCount.recordCount);
		assert(recordCount.recordCount < 40);
		setAuditRetention(0.1);
		// wait for audit log removal and deletion, but less than the retention time as the reclamation should accelerate it
		await delay(40);
		await runReclamationHandlers();
		assert(TableToReclaimFrom.getAuditSize() < 40000);
	});
	after(function () {
		setAvailableSpaceRatioGetter(); // restore default
		setAuditRetention(60000);
	});
});
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms)); // wait for audit log removal and deletion
}
