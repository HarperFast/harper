'use strict';

require('../../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor.js');
const { setProperty } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { databases } = require('#src/resources/databases');
const { server } = require('#src/server/Server');
const analytics = require('#src/resources/analytics/write');

const PERIOD = 300;

function runCycle() {
	return analytics.runAggregationCycle(PERIOD, PERIOD);
}

// A cycle that consumed its whole backlog leaves the cadence guard closed for a period.
function nextPeriod() {
	return delay(PERIOD + 50);
}

function rawReport(id, path) {
	return {
		id,
		time: id,
		period: PERIOD,
		threadId: 1,
		metrics: [{ metric: 'db-write', path, count: 1, mean: 10 }],
	};
}

function seedRawReports(reports) {
	const rawAnalytics = databases.system.hdb_raw_analytics;
	return Promise.all(reports.map((report) => rawAnalytics.primaryStore.put(report.id, report)));
}

function lastRawKey() {
	let last;
	for (const key of databases.system.hdb_raw_analytics.primaryStore.getKeys({ start: false, end: Infinity }))
		last = key;
	return last;
}

function aggregatedWritePaths() {
	const paths = [];
	for (const { value } of databases.system.hdb_analytics.primaryStore.getRange({ start: false, end: Infinity })) {
		if (value?.metric === 'db-write' && value.path?.startsWith('AggWindow')) paths.push(value.path);
	}
	return paths.sort();
}

// `storeMetric` does not await its `put`, so a rollup is readable some time after the cycle that
// wrote it resolves — immediately under RocksDB, only once the commit lands under LMDB.
function aggregatedWritePath(path, message = `${path} was aggregated`) {
	return waitFor(() => aggregatedWritePaths().includes(path), { timeout: 10000, message });
}

// One raw report per thread sample. The probe's `maxWait` and `maximum` carry the same values as
// `maxDepth`, so the test separates the max-named rule from the mean rule on one measure name each.
function gaugeReport(id, threadId, depth, maxDepth) {
	const gauge = { threadId, byThread: true, depth, maxDepth };
	return {
		id,
		time: id,
		period: PERIOD,
		threadId,
		metrics: [
			{ metric: 'write-transaction-queue-depth', ...gauge },
			{ metric: 'read-transaction-queue-depth', ...gauge },
			{ metric: 'contract-probe', threadId, byThread: true, maxWait: maxDepth, maximum: maxDepth },
		],
	};
}

function aggregatedMetric(metric, time) {
	for (const { value } of databases.system.hdb_analytics.primaryStore.getRange({ start: false, end: Infinity })) {
		if (value?.metric === metric && value.time === time) return value;
	}
}

describe('analytics aggregation cycle', () => {
	// Rollups of this path, taken from the cycle itself: no wait on storage can establish that a
	// second one will never arrive, and the listener runs synchronously inside the cycle. Held by
	// identity because `onAnalyticsAggregate` has no unregister — a listener registered twice in one
	// process reports the same rollup twice, a real second cycle reports a second object.
	const concurrentRollups = new Set();

	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		server.hostname ||= 'aggregation-cycle-test';
		// The first recorded action also starts the production scheduler, which shares the cursor and
		// the single-flight flag with the cycles driven here; an hour-long period keeps it from ticking.
		setProperty(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD, 3600);
		// Create hdb_raw_analytics through the recording path rather than a cycle, which would put the
		// cursor ahead of the backlog these tests seed.
		analytics.setAnalyticsEnabled(true);
		analytics.onAnalyticsAggregate((actions) => {
			for (const action of actions) if (action.path === 'AggWindowConcurrent') concurrentRollups.add(action);
		});
		analytics.recordAction(1, 'db-write', 'Bootstrap');
		// The table object appears when the recording path creates it, which is before its own
		// unawaited `put` is readable; these tests seed relative to that record's key.
		await waitFor(() => (databases.system?.hdb_raw_analytics ? lastRawKey() : undefined), {
			timeout: 10000,
			message: 'the bootstrap raw report is readable',
		});
	});

	after(() => {
		analytics.setAnalyticsEnabled(false);
	});

	it('keeps its place when a cycle finds nothing to aggregate', async function () {
		this.timeout(30000);
		const bootstrapKey = lastRawKey();
		await runCycle();
		await nextPeriod();
		// Nothing is left, so this cycle reads no record at all — and a raw report can be invisible to
		// it for reasons other than being late, since `recordAnalytics` does not await its `put`.
		await runCycle();

		await seedRawReports([rawReport(bootstrapKey + 1, 'AggWindowLate')]);
		await nextPeriod();
		await runCycle();

		await aggregatedWritePath('AggWindowLate', 'a report older than the empty cycle is aggregated');
	});

	it('aggregates a backlog longer than one period across cycles', async function () {
		this.timeout(30000);
		// Three reports a period apart, the shape a late tick leaves behind. A cycle rolls up one
		// window, and the two that follow it run back to back only because the first stopped with
		// records still behind it.
		const base = lastRawKey() + 1;
		await seedRawReports([
			rawReport(base, 'AggWindow1'),
			rawReport(base + PERIOD + 1, 'AggWindow2'),
			rawReport(base + 2 * PERIOD + 2, 'AggWindow3'),
		]);

		await nextPeriod();
		for (let cycle = 0; cycle < 3; cycle++) await runCycle();

		for (const path of ['AggWindow1', 'AggWindow2', 'AggWindow3']) await aggregatedWritePath(path);
	});

	it('refuses a cycle that starts while another is running', async function () {
		this.timeout(30000);
		await seedRawReports([rawReport(lastRawKey() + 1, 'AggWindowConcurrent')]);
		await nextPeriod();

		concurrentRollups.clear();
		await Promise.all([runCycle(), runCycle()]);

		assert.strictEqual(concurrentRollups.size, 1, 'the window was rolled up once');
		await aggregatedWritePath('AggWindowConcurrent');
		const aggregated = aggregatedWritePaths().filter((path) => path === 'AggWindowConcurrent');
		assert.deepStrictEqual(aggregated, ['AggWindowConcurrent']);
	});

	it('takes the peak of each thread over a period and sums those peaks across threads', async function () {
		this.timeout(30000);
		const first = lastRawKey() + 1;
		const second = first + PERIOD + 1;
		// Thread 0 and sparse thread 7, two samples each, in two periods. Period one's maxDepth is
		// 10 + 8 = 18: the per-thread peaks, not their means (7 + 5.5 = 12.5) or the largest peak (10).
		await seedRawReports([
			gaugeReport(first, 0, 2, 10),
			gaugeReport(first + 1, 0, 4, 4),
			gaugeReport(first + 2, 7, 1, 3),
			gaugeReport(first + 3, 7, 3, 8),
			gaugeReport(second, 0, 0, 0),
			gaugeReport(second + 1, 0, 0, 0),
			gaugeReport(second + 2, 7, 0, 1),
			gaugeReport(second + 3, 7, 1, 1),
		]);
		await nextPeriod();
		await runCycle();
		await runCycle();

		const periods = [
			{ time: first + 3, depth: 5, maxDepth: 18, maximum: 12.5, maxWait: 18 },
			{ time: second + 3, depth: 0.5, maxDepth: 1, maximum: 1, maxWait: 1 },
		];
		for (const period of periods) {
			for (const metric of ['write-transaction-queue-depth', 'read-transaction-queue-depth', 'contract-probe']) {
				await waitFor(() => aggregatedMetric(metric, period.time), {
					timeout: 10000,
					message: `${metric} at ${period.time} was aggregated`,
				});
			}
			for (const metric of ['write-transaction-queue-depth', 'read-transaction-queue-depth']) {
				const row = aggregatedMetric(metric, period.time);
				assert.strictEqual(row.depth, period.depth, `${metric} depth is the mean of samples per thread, summed`);
				assert.strictEqual(row.maxDepth, period.maxDepth, `${metric} maxDepth is the sum of per-thread peaks`);
			}
			// `maximum` is not max-named, so it keeps the mean; `maxWait` is max-named and takes the peak.
			const probe = aggregatedMetric('contract-probe', period.time);
			assert.strictEqual(probe.maximum, period.maximum);
			assert.strictEqual(probe.maxWait, period.maxWait);
		}
	});
});
