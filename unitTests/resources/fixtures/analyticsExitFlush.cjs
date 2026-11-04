'use strict';

const assert = require('node:assert');
const { parentPort, workerData } = require('node:worker_threads');
const env = require('#src/utility/environment/environmentManager');
env.initSync();
const analytics = require('#src/resources/analytics/write');
parentPort.ref();
if (workerData.failPeriodic) {
	const { pinLogConfig } = require('../../logConfigFixture');
	const { readFileSync } = require('node:fs');
	const { getLogFilePath } = require('#src/utility/logging/harper_logger');
	const { waitFor } = require('../../waitFor');
	const restore = pinLogConfig();
	analytics.setAnalyticsEnabled(true);
	analytics.recordAction(() => {
		throw new Error('periodic-metric-regression');
	}, 'failing-periodic-metric');
	waitFor(() => {
		try {
			const log = readFileSync(getLogFilePath(), 'utf8');
			return log.includes('Analytics flush failed') && log.includes('periodic-metric-regression');
		} catch {
			return false;
		}
	}, 10_000).then(async () => {
		await analytics.flushAnalyticsForExit();
		restore();
		parentPort.postMessage({ type: 'periodic-error-logged' });
		parentPort.close();
	});
	return;
}
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
