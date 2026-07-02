'use strict';

// Minimal worker fixture for workerDataProviders.test.js: report the provider-supplied
// workerData properties back to the test, without loading any server infrastructure.
const { parentPort, workerData } = require('node:worker_threads');

parentPort.postMessage({
	type: 'workerData-report',
	testProvided: workerData.testProvided,
	testSkipped: workerData.testSkipped,
	testThrows: workerData.testThrows,
	testNonCloneable: workerData.testNonCloneable,
	name: workerData.name,
	hasTicketKeys: Boolean(workerData.ticketKeys),
});
