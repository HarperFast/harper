require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, flushDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('flushDatabases', () => {
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'FlushTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});

	it('flushes all databases without error', async function () {
		await assert.doesNotReject(() => flushDatabases());
	});
});
