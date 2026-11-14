'use strict';

const { parentPort } = require('node:worker_threads');
parentPort.postMessage({
	type: 'analytics-report',
	report: { time: Date.now(), period: 1000, metrics: [{ metric: 'worker-commit-probe', count: 1 }] },
});
