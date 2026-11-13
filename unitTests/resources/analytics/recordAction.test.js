'use strict';

require('../../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor.js');
const analytics = require('#src/resources/analytics/write');

const METRIC_PREFIX = 'record-action-';

// actionKey turns the path into a string, so `conversions` counts the keys recordAction built for it.
class CountedPath {
	constructor(name) {
		this.name = name;
		this.conversions = 0;
	}
	toString() {
		this.conversions++;
		return this.name;
	}
}

function summary(entry) {
	return { path: String(entry.path), method: entry.method, count: entry.count, mean: entry.mean };
}

describe('recordAction', () => {
	const reports = [];
	let removeListener;
	let wasEnabled;

	before(() => {
		setupTestDBPath();
		wasEnabled = analytics.checkAnalyticsEnabled(false);
		removeListener = analytics.addAnalyticsListener((metrics) => {
			if (metrics.some((entry) => entry.metric.startsWith(METRIC_PREFIX))) reports.push(metrics);
		});
	});

	after(() => {
		removeListener();
		analytics.setAnalyticsEnabled(wasEnabled);
	});

	// Each test records under its own metric, so the next report carrying it is that test's window.
	function nextReport(metric) {
		return waitFor(
			() => {
				const index = reports.findIndex((metrics) => metrics.some((entry) => entry.metric === metric));
				if (index < 0) return;
				const [metrics] = reports.splice(index, 1);
				return metrics.filter((entry) => entry.metric === metric).map(summary);
			},
			{ timeout: 10000, message: `a report carried ${metric}` }
		);
	}

	it('aggregates calls that spell the same action differently into one action', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'spelling';
		analytics.setAnalyticsEnabled(true);
		// An empty, absent or null path and a number or its string each build the same key. Three rounds put
		// every spelling in the index, so its last call reaches the action through its own index entry.
		for (let round = 0; round < 3; round++) {
			analytics.recordAction(1, metric, '', 'GET');
			analytics.recordAction(2, metric, undefined, 'GET');
			analytics.recordAction(3, metric, null, 'GET');
			analytics.recordAction(4, metric, 9926);
			analytics.recordAction(6, metric, '9926');
		}
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: '', method: 'GET', count: 9, mean: 2 },
			{ path: '9926', method: undefined, count: 6, mean: 5 },
		]);
	});

	it('indexes a tuple from its second call in a window and keeps recording into its action', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'second-call';
		const repeated = new CountedPath('Repeated');
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(5, metric, 'Once', 'GET');
		analytics.recordAction(1, metric, repeated, 'GET');
		assert.strictEqual(repeated.conversions, 1);
		analytics.recordAction(2, metric, repeated, 'GET');
		assert.strictEqual(repeated.conversions, 2, 'the first call left the tuple out of the index');
		analytics.recordAction(3, metric, repeated, 'GET');
		analytics.recordAction(6, metric, repeated, 'GET');
		assert.strictEqual(repeated.conversions, 2, 'the second call indexed the tuple');
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: 'Once', method: 'GET', count: 1, mean: 5 },
			{ path: 'Repeated', method: 'GET', count: 4, mean: 3 },
		]);
	});

	it('starts fresh actions in the window after a report and after a reset', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'window';
		analytics.setAnalyticsEnabled(true);
		for (const value of [1, 2, 3]) analytics.recordAction(value, metric, 'Window');
		assert.deepStrictEqual(await nextReport(metric), [{ path: 'Window', method: undefined, count: 3, mean: 2 }]);
		// The reported window indexed this tuple; its next calls must reach the new window's action.
		for (const value of [10, 20]) analytics.recordAction(value, metric, 'Window');
		assert.deepStrictEqual(await nextReport(metric), [{ path: 'Window', method: undefined, count: 2, mean: 15 }]);
		for (const value of [1, 2, 3]) analytics.recordAction(value, metric, 'Window');
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(100, metric, 'Window');
		assert.deepStrictEqual(await nextReport(metric), [{ path: 'Window', method: undefined, count: 1, mean: 100 }]);
	});
});
