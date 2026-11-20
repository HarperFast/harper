'use strict';

const assert = require('node:assert');
const env = require('#src/utility/environment/environmentManager');
env.initSync();
const { table } = require('#src/resources/databases');
const analytics = require('#src/resources/analytics/write');
const { runStartup } = require('#src/utility/lifecycle');

runStartup()
	.then(async () => {
		if (process.argv[2] === 'worker-write') {
			const { startWorker } = require('#src/server/threads/manageThreads');
			analytics.setAnalyticsEnabled(false);
			const worker = startWorker(require.resolve('./analyticsWorkerReport.cjs'), { name: 'http', autoRestart: false });
			await new Promise((resolve, reject) => {
				worker.on('error', reject);
				worker.on('message', (message) => {
					if (message.type === 'analytics-report') resolve();
				});
			});
			await analytics.flushAnalyticsForExit();
		} else if (process.argv[2] === 'write') {
			analytics.setAnalyticsEnabled(true);
			analytics.recordAction(true, 'final-commit-probe');
			await analytics.flushAnalyticsForExit();
		} else {
			const raw = table({
				table: 'hdb_raw_analytics',
				database: 'system',
				audit: false,
				trackDeletes: false,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'action' }, { name: 'metrics' }],
			});
			let found = false;
			for (const { value } of raw.primaryStore.getRange({ start: false, end: Infinity }))
				if (
					value.metrics.some(
						(metric) =>
							metric.metric === (process.argv[2] === 'worker-read' ? 'worker-commit-probe' : 'final-commit-probe') &&
							metric.count === 1
					)
				)
					found = true;
			assert.ok(found, 'final analytics report must survive exit after flush completion');
		}
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
