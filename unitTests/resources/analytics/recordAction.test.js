'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor.js');
const { get, setProperty } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');
const analytics = require('#src/resources/analytics/write');

const PREFIX = 'record-action-test';

describe('recordAction', function () {
	this.timeout(15000);
	// one array of this test's metrics per report; a listener cannot be removed, so it only collects
	const reports = [];
	let aggregatePeriod;

	before(() => {
		setupTestDBPath();
		server.hostname ||= 'record-action-test';
		// the first recorded action starts the aggregation scheduler, which an hour-long period keeps idle
		aggregatePeriod = get(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD);
		setProperty(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD, 3600);
		analytics.setAnalyticsEnabled(true);
		analytics.addAnalyticsListener((metrics) => {
			const ours = metrics.filter(({ metric }) => metric?.startsWith(PREFIX));
			if (ours.length > 0) reports.push(ours);
		});
	});

	after(() => {
		analytics.setAnalyticsEnabled(false);
		setProperty(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD, aggregatePeriod);
	});

	async function nextReport() {
		reports.length = 0;
		await waitFor(() => reports.length > 0, { timeout: 5000, message: 'a report with this test’s metrics' });
		return reports[0];
	}

	it('aggregates every call that names one action, however its arguments are spelled', async () => {
		analytics.recordAction(4, `${PREFIX}-bytes`, 'Topic', 'publish', 'mqtt');
		analytics.recordAction(8, `${PREFIX}-bytes`, 'Topic', 'publish', 'mqtt');
		analytics.recordAction(16, `${PREFIX}-bytes`, 'Topic', 'publish', 'mqtt-other');
		// an empty or omitted path names the same action
		analytics.recordAction(true, `${PREFIX}-flag`, '');
		analytics.recordAction(false, `${PREFIX}-flag`, undefined);
		analytics.recordAction(true, `${PREFIX}-flag`);
		const report = await nextReport();
		const bytes = report.filter(({ metric }) => metric === `${PREFIX}-bytes`);
		assert.deepStrictEqual(
			bytes.map(({ type, count, mean }) => ({ type, count, mean })).sort((a, b) => a.type.localeCompare(b.type)),
			[
				{ type: 'mqtt', count: 2, mean: 6 },
				{ type: 'mqtt-other', count: 1, mean: 16 },
			]
		);
		const flags = report.filter(({ metric }) => metric === `${PREFIX}-flag`);
		assert.strictEqual(flags.length, 1);
		assert.strictEqual(flags[0].count, 3);
		assert.strictEqual(flags[0].total, 2);
	});

	it('starts a new action after each report, rather than adding to the one reported', async () => {
		analytics.recordAction(10, `${PREFIX}-rotate`, 'Topic');
		const first = await nextReport();
		assert.strictEqual(first.find(({ metric }) => metric === `${PREFIX}-rotate`).count, 1);
		analytics.recordAction(30, `${PREFIX}-rotate`, 'Topic');
		analytics.recordAction(50, `${PREFIX}-rotate`, 'Topic');
		const second = await nextReport();
		const rotated = second.find(({ metric }) => metric === `${PREFIX}-rotate`);
		assert.strictEqual(rotated.count, 2);
		assert.strictEqual(rotated.mean, 40);
	});
});
