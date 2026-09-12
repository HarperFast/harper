'use strict';

// Fixture for workerDataExtra.test.js: report what a per-call `extraWorkerData` spawn actually
// received, including whether the thread's own ITC bootstrap survived the merge.
const { parentPort, workerData } = require('node:worker_threads');

const port = workerData.certification?.verdictPort;
if (port) port.postMessage({ type: 'through-transferred-port', nonce: workerData.certification.nonce });

parentPort.postMessage({
	type: 'extra-report',
	candidateDirPath: workerData.certification?.candidateDirPath,
	nonce: workerData.certification?.nonce,
	sawPort: Boolean(port),
	noServerStart: workerData.noServerStart,
	// The bootstrap the merge must not displace.
	hasAddPorts: Array.isArray(workerData.addPorts),
	hasTicketKeys: Boolean(workerData.ticketKeys),
	name: workerData.name,
});
