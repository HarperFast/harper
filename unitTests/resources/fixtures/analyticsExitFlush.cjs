'use strict';

const assert = require('node:assert');
const { parentPort } = require('node:worker_threads');
const env = require('#src/utility/environment/environmentManager');
env.initSync();
const analytics = require('#src/resources/analytics/write');
parentPort.ref();
const order = [];
analytics.setAnalyticsEnabled(true);
analytics.addAnalyticsListener((_metrics, final) => order.push(final ? 'final-delivered' : 'ordinary-delivered'));
analytics.recordAction(() => {
	order.push('ordinary-started');
	queueMicrotask(() => {
		order.push('exit-requested');
		const completed = analytics.flushAnalyticsForExit();
		assert.strictEqual(analytics.flushAnalyticsForExit(), completed);
		completed.then(
			() => {
				parentPort.postMessage({ type: 'flush-completed', order });
				parentPort.close();
			},
			(error) => {
				throw error;
			}
		);
	});
	return { count: 1 };
}, 'shutdown-overlap');
