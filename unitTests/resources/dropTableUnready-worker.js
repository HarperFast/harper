'use strict';

const { parentPort } = require('node:worker_threads');

// Deliberately loads no storage or ITC module until the test requests it.
parentPort?.on('message', (message) => {
	if (message.type === 'open-storage') {
		require('../testUtils');
		const { setupTestDBPath } = require('../testUtils');
		setupTestDBPath();
		const { table } = require('#src/resources/databases');
		table({
			database: 'test',
			table: message.table,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		parentPort.postMessage({ type: 'storage-opened' });
	} else if (message.type === 'close-storage') {
		require('#src/resources/databases').closeLoadedDatabases();
		parentPort.postMessage({ type: 'storage-closed' });
	}
});
