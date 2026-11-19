'use strict';

const assert = require('node:assert');
const env = require('#src/utility/environment/environmentManager');
env.initSync();
const { table } = require('#src/resources/databases');
const analytics = require('#src/resources/analytics/write');
const { runStartup } = require('#src/utility/lifecycle');

runStartup()
	.then(async () => {
		if (process.argv[2] === 'write') {
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
				if (value.metrics.some((metric) => metric.metric === 'final-commit-probe' && metric.count === 1)) found = true;
			assert.ok(found, 'final analytics report must survive exit after flush completion');
		}
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
