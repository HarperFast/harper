'use strict';

// Runs a replicated restart_service the way its job worker does — off the main thread, waiting for the
// main thread's restart-complete — against peers whose answers come from workerData.
const { workerData, parentPort } = require('node:worker_threads');
require('../../testUtils.js').preTestPrep();
const { getThisNodeName } = require('#src/server/nodeName');

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason?.message ?? reason)));
const { dispatchFailures = {}, pollFailures = {} } = workerData;
global.server = {
	nodes: [{ name: getThisNodeName() }, { name: 'peer-a' }, { name: 'peer-b' }],
	replication: {
		monitorNodeCAs() {},
		async sendOperationToNode(node, operation) {
			const failures = operation.operation === 'get_job' ? pollFailures : dispatchFailures;
			if (failures[node.name]?.length) throw new Error(failures[node.name].shift());
			if (operation.operation === 'get_job')
				return { results: [{ status: 'COMPLETE', message: `restarted ${node.name}` }] };
			return { job_id: `job-${node.name}` };
		},
	},
};
const { restartService } = require('#src/bin/restart');
const settle = (outcome) => setImmediate(() => parentPort.postMessage({ ...outcome, unhandled }));
restartService({ operation: 'restart_service', service: 'http', replicated: true }).then(
	(value) => settle({ completed: value }),
	(error) => settle({ failed: { message: error.message, result: error.result } })
);
