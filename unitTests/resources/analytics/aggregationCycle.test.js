'use strict';

require('../../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor.js');
const { databases } = require('#src/resources/databases');
const { server } = require('#src/server/Server');
const analytics = require('#src/resources/analytics/write');

const PERIOD = 300;

// A cycle refuses to run again until a whole period has elapsed since the last one, so a test
// driving consecutive cycles has to let that cadence guard open between them.
async function nextCycle() {
	await delay(PERIOD + 50);
	await analytics.runAggregationCycle(PERIOD, PERIOD);
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

function aggregatedWritePaths() {
	const paths = [];
	for (const { value } of databases.system.hdb_analytics.primaryStore.getRange({ start: false, end: Infinity })) {
		if (value?.metric === 'db-write' && value.path?.startsWith('AggWindow')) paths.push(value.path);
	}
	return paths.sort();
}

describe('analytics aggregation cycle', () => {
	// The first raw key the backlog test leaves unaggregated. The concurrency test seeds there so
	// its record is the first one the next cycle reads, whatever else is in the table.
	let nextRawKey;

	before(async function () {
		this.timeout(30000);
		setupTestDBPath();
		server.hostname ||= 'aggregation-cycle-test';
		// Create hdb_raw_analytics through the recording path rather than a cycle: a cycle would
		// also set the resume marker to its own start time, putting the backlog these tests seed
		// behind it before they begin.
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(1, 'db-write', 'Bootstrap');
		await waitFor(() => databases.system?.hdb_raw_analytics ?? undefined, {
			timeout: 10000,
			message: 'hdb_raw_analytics was created',
		});
	});

	after(() => {
		analytics.setAnalyticsEnabled(false);
	});

	it('aggregates a backlog longer than one period across cycles', async function () {
		this.timeout(30000);
		// Three reports a period apart, all older than the cycle that first reads them — the shape a
		// late tick leaves behind. One cycle can only roll up the first window, so the other two are
		// aggregated only if the marker resumes from the last record the cycle consumed.
		const base = Date.now() - 6 * PERIOD;
		await seedRawReports([
			rawReport(base, 'AggWindow1'),
			rawReport(base + PERIOD + 1, 'AggWindow2'),
			rawReport(base + 2 * PERIOD + 2, 'AggWindow3'),
		]);
		nextRawKey = base + 2 * PERIOD + 3;

		for (let cycle = 0; cycle < 3; cycle++) await nextCycle();

		assert.deepStrictEqual(aggregatedWritePaths(), ['AggWindow1', 'AggWindow2', 'AggWindow3']);
	});

	it('refuses a cycle that starts while another is running', async function () {
		this.timeout(30000);
		await seedRawReports([rawReport(nextRawKey, 'AggWindowConcurrent')]);

		await Promise.all([analytics.runAggregationCycle(PERIOD, PERIOD), analytics.runAggregationCycle(PERIOD, PERIOD)]);

		const aggregated = aggregatedWritePaths().filter((path) => path === 'AggWindowConcurrent');
		assert.deepStrictEqual(aggregated, ['AggWindowConcurrent']);
	});
});
