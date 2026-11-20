'use strict';

require('../../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor.js');
const analytics = require('#src/resources/analytics/write');
const { isActionIndexedForTests: isIndexed } = analytics;

const METRIC_PREFIX = 'record-action-';

// A report carries each action's first spelling, which these tests keep a string: aggregationCycle.test.js
// leaves listeners registered that call startsWith on a reported path.
function summary({ path, method, type, count, mean }) {
	return { path, method, type, count, mean };
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
		for (let round = 0; round < 3; round++) {
			analytics.recordAction(1, metric, '', 'GET');
			analytics.recordAction(2, metric, undefined, 'GET');
			analytics.recordAction(3, metric, null, 'GET');
			analytics.recordAction(4, metric, '9926');
			analytics.recordAction(6, metric, 9926);
		}
		for (const [path, method] of [['', 'GET'], [undefined, 'GET'], [null, 'GET'], ['9926'], [9926]])
			assert.ok(isIndexed(metric, path, method), `${typeof path} ${String(path)} is indexed`);
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: '', method: 'GET', type: undefined, count: 9, mean: 2 },
			{ path: '9926', method: undefined, type: undefined, count: 6, mean: 5 },
		]);
	});

	it('keeps arguments whose keys collide across fields in one action', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'collide-x';
		const other = METRIC_PREFIX + 'collide';
		analytics.setAnalyticsEnabled(true);
		// (metric, 'y') and (other, 'x-y') build the same key, so actionKey has always merged them
		for (let round = 0; round < 3; round++) {
			analytics.recordAction(1, metric, 'y');
			analytics.recordAction(3, other, 'x-y');
		}
		assert.ok(isIndexed(metric, 'y') && isIndexed(other, 'x-y'), 'both spellings are indexed');
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: 'y', method: undefined, type: undefined, count: 6, mean: 2 },
		]);
	});

	it('indexes a tuple from its second call in a window and keeps recording into its action', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'second-call';
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(5, metric, 'Once', 'GET', 'mqtt');
		analytics.recordAction(1, metric, 'Repeated', 'GET', 'mqtt');
		assert.ok(!isIndexed(metric, 'Once', 'GET', 'mqtt'), 'a tuple recorded once is not indexed');
		assert.ok(!isIndexed(metric, 'Repeated', 'GET', 'mqtt'), 'a tuple recorded once is not indexed');
		analytics.recordAction(2, metric, 'Repeated', 'GET', 'mqtt');
		assert.ok(isIndexed(metric, 'Repeated', 'GET', 'mqtt'), 'the second call indexed the tuple');
		analytics.recordAction(3, metric, 'Repeated', 'GET', 'mqtt');
		analytics.recordAction(6, metric, 'Repeated', 'GET', 'mqtt');
		assert.ok(!isIndexed(metric, 'Once', 'GET', 'mqtt'), 'a tuple recorded once is not indexed');
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: 'Once', method: 'GET', type: 'mqtt', count: 1, mean: 5 },
			{ path: 'Repeated', method: 'GET', type: 'mqtt', count: 4, mean: 3 },
		]);
	});

	it('keeps every path on its own action once a level holds more keys than an array does', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'many-paths';
		const paths = Array.from({ length: 12 }, (_, i) => 'path' + i);
		analytics.setAnalyticsEnabled(true);
		const round = (n) => {
			for (let i = 0; i < paths.length; i++) analytics.recordAction(i * 10 + n, metric, paths[i], 'GET');
		};
		round(0);
		round(1);
		for (const path of paths) assert.ok(isIndexed(metric, path, 'GET'), `${path} is indexed`);
		round(2);
		assert.deepStrictEqual(
			await nextReport(metric),
			paths.map((path, i) => ({ path, method: 'GET', type: undefined, count: 3, mean: i * 10 + 1 }))
		);
	});

	it('records a repeated tuple and the tuples beside it into their own actions', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'repeats';
		analytics.setAnalyticsEnabled(true);
		const calls = [
			[1, 'Topic', 'publish', 'mqtt'],
			[1, 'Topic', 'publish', 'mqtt'],
			[2, 'Other', 'publish', 'mqtt'],
			[1, 'Topic', 'publish', 'mqtt'],
			[3, 'Topic', 'puback', 'mqtt'],
			[1, 'Topic', 'publish', 'mqtt'],
			[4, 'Topic', 'publish', 'ws'],
			[1, 'Topic', 'publish', 'mqtt'],
			[5, 'Topic', 'publish', undefined],
			[1, 'Topic', 'publish', 'mqtt'],
			[6, 'Topic', undefined, 'mqtt'],
			[1, 'Topic', 'publish', 'mqtt'],
			[7, undefined, 'publish', 'mqtt'],
		];
		for (let round = 0; round < 2; round++)
			for (const [value, path, method, type] of calls) analytics.recordAction(value, metric, path, method, type);
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: 'Topic', method: 'publish', type: 'mqtt', count: 14, mean: 1 },
			{ path: 'Other', method: 'publish', type: 'mqtt', count: 2, mean: 2 },
			{ path: 'Topic', method: 'puback', type: 'mqtt', count: 2, mean: 3 },
			{ path: 'Topic', method: 'publish', type: 'ws', count: 2, mean: 4 },
			{ path: 'Topic', method: 'publish', type: undefined, count: 2, mean: 5 },
			{ path: 'Topic', method: undefined, type: 'mqtt', count: 2, mean: 6 },
			{ path: undefined, method: 'publish', type: 'mqtt', count: 2, mean: 7 },
		]);
	});

	it('indexes a NaN argument as a Map would', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'nan';
		analytics.setAnalyticsEnabled(true);
		// NaN goes in the type: listeners other suites leave registered call startsWith on a reported path
		for (const value of [1, 2, 3]) analytics.recordAction(value, metric, 'Nan', 'GET', NaN);
		assert.ok(isIndexed(metric, 'Nan', 'GET', NaN), 'NaN finds its own key');
		assert.deepStrictEqual(await nextReport(metric), [{ path: 'Nan', method: 'GET', type: NaN, count: 3, mean: 2 }]);
	});

	it('records an object argument into the action its key names without indexing it', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'object';
		const operations = [{ operation: 'a' }, { operation: 'b' }];
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(1, metric, String(operations[0]), undefined, 'operation');
		for (let round = 0; round < 2; round++)
			for (const operation of operations) analytics.recordAction(3, metric, operation, undefined, 'operation');
		for (const operation of operations)
			assert.ok(!isIndexed(metric, operation, undefined, 'operation'), 'an object is never indexed');
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: '[object Object]', method: undefined, type: 'operation', count: 5, mean: 2.6 },
		]);
	});

	it('starts fresh actions in the window after a report and after a reset', async function () {
		this.timeout(30000);
		const metric = METRIC_PREFIX + 'window';
		analytics.setAnalyticsEnabled(true);
		for (const value of [1, 2, 3]) analytics.recordAction(value, metric, 'Window');
		assert.ok(isIndexed(metric, 'Window'), 'the second call indexed the tuple');
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: 'Window', method: undefined, type: undefined, count: 3, mean: 2 },
		]);
		assert.ok(!isIndexed(metric, 'Window'), 'the report replaced the index');
		for (const value of [10, 20]) analytics.recordAction(value, metric, 'Window');
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: 'Window', method: undefined, type: undefined, count: 2, mean: 15 },
		]);
		for (const value of [1, 2, 3]) analytics.recordAction(value, metric, 'Window');
		analytics.setAnalyticsEnabled(true);
		assert.ok(!isIndexed(metric, 'Window'), 'the reset replaced the index');
		analytics.recordAction(100, metric, 'Window');
		assert.deepStrictEqual(await nextReport(metric), [
			{ path: 'Window', method: undefined, type: undefined, count: 1, mean: 100 },
		]);
	});
});
