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

describe('analytics aggregation cycle', () => {
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

		assert.ok(aggregatedWritePaths().includes('AggWindowLate'), 'a report older than the empty cycle is aggregated');
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

		for (const path of ['AggWindow1', 'AggWindow2', 'AggWindow3'])
			assert.ok(aggregatedWritePaths().includes(path), `${path} was aggregated`);
	});

	it('refuses a cycle that starts while another is running', async function () {
		this.timeout(30000);
		await seedRawReports([rawReport(lastRawKey() + 1, 'AggWindowConcurrent')]);
		await nextPeriod();

		await Promise.all([runCycle(), runCycle()]);

		const aggregated = aggregatedWritePaths().filter((path) => path === 'AggWindowConcurrent');
		assert.deepStrictEqual(aggregated, ['AggWindowConcurrent']);
	});
});
