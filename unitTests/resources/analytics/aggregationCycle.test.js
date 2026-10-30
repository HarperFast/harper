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

// One raw report per thread sample. The probe's `maxCount` and `maximum` carry `maxDepth`'s values,
// so the probe's two measures show the prefix rule and the mean rule on identical inputs.
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
			{ metric: 'contract-probe', threadId, byThread: true, maxCount: maxDepth, maximum: maxDepth },
		],
	};
}

function aggregatedMetric(metric, time) {
	for (const { value } of databases.system.hdb_analytics.primaryStore.getRange({ start: false, end: Infinity })) {
		if (value?.metric === metric && value.time === time) return value;
	}
}

function waitForAggregatedMetric(metric, time) {
	return waitFor(() => aggregatedMetric(metric, time), {
		timeout: 10000,
		message: `${metric} at ${time} was aggregated`,
	});
}

// Stop new live reports, then let an in-flight flush finish and consume what it left above the cursor.
async function drainLiveReports() {
	analytics.setAnalyticsEnabled(false);
	await nextPeriod();
	await runCycle();
}

function sampleReport(id, threadId, entry) {
	return { id, time: id, period: PERIOD, threadId, metrics: [entry] };
}

function assertNoNaN(row) {
	for (const name in row) assert.ok(!Number.isNaN(row[name]), `${row.metric} ${name} is not NaN`);
}

function aggregatedMetrics(metric, time) {
	const rows = [];
	for (const { value } of databases.system.hdb_analytics.primaryStore.getRange({ start: false, end: Infinity })) {
		if (value?.metric === metric && value.time === time) rows.push(value);
	}
	return rows;
}

function pick(row, fields) {
	return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

function delayReport(id, threadId, sample) {
	return {
		id,
		time: id,
		period: PERIOD,
		threadId,
		metrics: [{ metric: 'event-loop-delay', threadId, perThread: true, ...sample }],
	};
}

function durationReport(id, threadId, path, count, mean) {
	return {
		id,
		time: id,
		period: PERIOD,
		threadId,
		metrics: [
			{
				metric: 'duration',
				path,
				method: 'GET',
				type: 'cache-hit',
				count,
				mean,
				distribution: [{ value: mean, count }],
			},
			{ metric: 'db-write', path, count, mean: 10 },
		],
	};
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
		await drainLiveReports();
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
			{ time: first + 3, depth: 5, maxDepth: 18, maximum: 12.5, maxCount: 18 },
			{ time: second + 3, depth: 0.5, maxDepth: 1, maximum: 1, maxCount: 1 },
		];
		for (const period of periods) {
			for (const metric of ['write-transaction-queue-depth', 'read-transaction-queue-depth', 'contract-probe']) {
				await waitForAggregatedMetric(metric, period.time);
			}
			for (const metric of ['write-transaction-queue-depth', 'read-transaction-queue-depth']) {
				const row = aggregatedMetric(metric, period.time);
				assert.strictEqual(row.depth, period.depth, `${metric} depth is the mean of samples per thread, summed`);
				assert.strictEqual(row.maxDepth, period.maxDepth, `${metric} maxDepth is the sum of per-thread peaks`);
				assert.strictEqual(row.period, PERIOD, `${metric} keeps the aggregation window`);
				assert.strictEqual(row.threadId, undefined, `${metric} carries no summed thread id`);
				assert.strictEqual(row.count, 2);
			}
			const probe = aggregatedMetric('contract-probe', period.time);
			assert.strictEqual(probe.maximum, period.maximum);
			assert.strictEqual(probe.maxCount, period.maxCount);
		}
	});

	it('averages a measure over only the samples that carry it, and peaks it from its first sample', async function () {
		this.timeout(30000);
		await drainLiveReports();
		const first = lastRawKey() + 1;
		const probe = (id, count, measures) => sampleReport(id, 1, { metric: 'sparse-probe', count, ...measures });
		await seedRawReports([
			probe(first, 2, { mean: 0.7, rare: 6 }),
			probe(first + 1, 1, { mean: 0.2, maxLatency: 5, late: 0 }),
			probe(first + 2, 1, { mean: 0.1 }),
			probe(first + 3, 2, { mean: 0.1, maxLatency: 9, late: 9, rare: 12 }),
			probe(first + 4, 1, { mean: 0.1 }),
		]);
		await nextPeriod();
		await runCycle();

		const row = await waitForAggregatedMetric('sparse-probe', first + 4);
		assertNoNaN(row);
		assert.strictEqual(row.count, 7);
		// Summing then dividing would give 0.2857142857142857.
		assert.strictEqual(row.mean, 0.28571428571428575, 'a measure in every sample folds as a running mean, as before');
		assert.strictEqual(row.maxLatency, 9, 'a peak first seen mid-period is the largest of its samples');
		assert.strictEqual(row.late, (9 * 2) / (1 + 2), 'a mean first seen mid-period weighs only its own samples');
		assert.strictEqual(row.rare, (6 * 2 + 12 * 2) / 4, 'samples lacking a measure do not weigh into its mean');
	});

	it('combines a measure absent from the first sample or present on only some threads', async function () {
		this.timeout(30000);
		await drainLiveReports();
		const first = lastRawKey() + 1;
		const gauge = (id, threadId, measures) =>
			sampleReport(id, threadId, { metric: 'sparse-thread-probe', byThread: true, ...measures });
		await seedRawReports([
			gauge(first, 0, { depth: 2 }),
			gauge(first + 1, 0, { depth: 4, maxDepth: 6, queued: 1 }),
			gauge(first + 2, 7, { depth: 1, maxDepth: 3, queued: 5, stalled: 2, total: 10, ratio: 0.5 }),
			gauge(first + 3, 7, { depth: 3, maxDepth: 8, queued: 7, stalled: 4, total: 10, ratio: 0.5 }),
		]);
		await nextPeriod();
		await runCycle();

		const row = await waitForAggregatedMetric('sparse-thread-probe', first + 3);
		assertNoNaN(row);
		assert.strictEqual(row.count, 2, 'one per thread');
		assert.strictEqual(row.depth, 3 + 2);
		assert.strictEqual(row.maxDepth, 6 + 8, 'per-thread peaks, summed');
		assert.strictEqual(row.queued, 1 + 6, 'per-thread means, summed');
		assert.strictEqual(row.stalled, 3, 'only the thread that carries it contributes');
		assert.strictEqual(row.ratio, 0.5, 'a measure named ratio is summed like any other');
	});

	it('folds a metric that reports its own field named threads', async function () {
		this.timeout(30000);
		await drainLiveReports();
		const first = lastRawKey() + 1;
		await seedRawReports([
			sampleReport(first, 1, { metric: 'threads-field-probe', count: 1, mean: 2, threads: 4 }),
			sampleReport(first + 1, 1, { metric: 'threads-field-probe', count: 1, mean: 4, threads: 4 }),
		]);
		await nextPeriod();
		await runCycle();

		const row = await waitForAggregatedMetric('threads-field-probe', first + 1);
		assert.strictEqual(row.mean, 3);
		assert.strictEqual(row.count, 2);
	});

	it('stores a per-thread gauge as one row per thread', async function () {
		this.timeout(30000);
		await nextPeriod();
		await runCycle();
		const first = lastRawKey() + 1;
		await seedRawReports([
			delayReport(first, 0, { mean: 1, maxDelay: 4, count: 50 }),
			delayReport(first + 1, 0, { mean: 3, maxDelay: 12, count: 50 }),
			delayReport(first + 2, 7, { mean: 0.5, maxDelay: 2, count: 25 }),
		]);
		await nextPeriod();
		await runCycle();

		const rows = await waitFor(
			() => {
				const found = aggregatedMetrics('event-loop-delay', first + 2);
				return found.length === 2 ? found : undefined;
			},
			{ timeout: 10000, message: 'one event-loop-delay row per thread was aggregated' }
		);
		const byThread = Object.fromEntries(rows.map((row) => [row.thread, row]));
		assert.deepStrictEqual(pick(byThread[0], ['metric', 'thread', 'mean', 'maxDelay', 'count', 'period']), {
			metric: 'event-loop-delay',
			thread: 0,
			mean: 2,
			maxDelay: 12,
			count: 100,
			period: PERIOD,
		});
		assert.deepStrictEqual(pick(byThread[7], ['metric', 'thread', 'mean', 'maxDelay', 'count', 'period']), {
			metric: 'event-loop-delay',
			thread: 7,
			mean: 0.5,
			maxDelay: 2,
			count: 25,
			period: PERIOD,
		});
		assert.strictEqual(byThread[0].threadId, undefined);
		assert.strictEqual(byThread[0].perThread, undefined);
	});

	it('rolls duration up once per thread, across its paths, without changing its aggregate rows', async function () {
		this.timeout(30000);
		await nextPeriod();
		await runCycle();
		const first = lastRawKey() + 1;
		const threadSeven = durationReport(first + 1, 7, 'ThreadPath', 30, 6);
		threadSeven.metrics.push({
			metric: 'duration',
			path: 'OtherPath',
			method: 'POST',
			count: 10,
			mean: 2,
			distribution: [{ value: 2, count: 10 }],
		});
		await seedRawReports([
			durationReport(first, 0, 'ThreadPath', 10, 2),
			threadSeven,
			durationReport(first + 2, 0, 'ThreadPath', 10, 4),
		]);
		await nextPeriod();
		await runCycle();

		const aggregate = await waitFor(
			() => aggregatedMetrics('duration', first + 2).find((row) => row.path === 'ThreadPath'),
			{ timeout: 10000, message: 'the duration row was aggregated' }
		);
		assert.strictEqual(aggregate.count, 50);
		assert.strictEqual(aggregate.mean, 4.8);
		assert.strictEqual(typeof aggregate.p95, 'number');
		assert.strictEqual(aggregate.thread, undefined);

		// The cycle writes its rows one by one, so each read waits for the rows it checks.
		const perThread = await waitFor(
			() => {
				const rows = aggregatedMetrics('duration-by-thread', first + 2);
				return rows.length === 2 && rows;
			},
			{ timeout: 10000, message: 'both per-thread rows were aggregated' }
		);
		const byThread = Object.fromEntries(perThread.map((row) => [row.thread, row]));
		const fields = ['metric', 'path', 'method', 'type', 'thread', 'count', 'mean', 'period'];
		assert.deepStrictEqual(pick(byThread[0], fields), {
			metric: 'duration-by-thread',
			path: undefined,
			method: undefined,
			type: undefined,
			thread: 0,
			count: 20,
			mean: 3,
			period: PERIOD,
		});
		assert.deepStrictEqual(pick(byThread[7], fields), {
			metric: 'duration-by-thread',
			path: undefined,
			method: undefined,
			type: undefined,
			thread: 7,
			count: 40,
			mean: 5,
			period: PERIOD,
		});
		assert.strictEqual(byThread[0].p95, undefined);
		const writes = await waitFor(
			() => {
				const rows = aggregatedMetrics('db-write', first + 2).filter((row) => row.path === 'ThreadPath');
				return rows.length > 0 && rows;
			},
			{ timeout: 10000, message: 'the db-write row was aggregated' }
		);
		assert.strictEqual(writes.length, 1, 'a metric outside the per-thread set keeps its single aggregate row');
		assert.strictEqual(writes[0].count, 50);
		assert.strictEqual(writes[0].thread, undefined);
		assert.strictEqual(aggregatedMetrics('db-write-by-thread', first + 2).length, 0);
	});

	it('keeps a per-thread row apart from an ordinary entry whose method spells its old key', async function () {
		this.timeout(30000);
		await drainLiveReports();
		const first = lastRawKey() + 1;
		await seedRawReports([
			sampleReport(first, 1, {
				metric: 'duration',
				path: 'ThreadPath',
				method: 'GET',
				type: 'cache-hit',
				count: 10,
				mean: 2,
				distribution: [{ value: 2, count: 10 }],
			}),
			sampleReport(first + 1, 1, {
				metric: 'duration',
				method: 'by-thread-ThreadPath-GET-cache-hit-thread-1',
				count: 7,
				mean: 1,
				distribution: [{ value: 1, count: 7 }],
			}),
		]);
		await nextPeriod();
		await runCycle();

		const perThread = await waitFor(
			() => aggregatedMetrics('duration-by-thread', first + 1).find((row) => row.thread === 1),
			{ timeout: 10000, message: 'the per-thread row was aggregated' }
		);
		assert.strictEqual(perThread.count, 17);
		assert.strictEqual(perThread.mean, 27 / 17);
		const ordinary = await waitFor(
			() =>
				aggregatedMetrics('duration', first + 1).find(
					(row) => row.method === 'by-thread-ThreadPath-GET-cache-hit-thread-1'
				),
			{ timeout: 10000, message: 'the ordinary duration row was aggregated' }
		);
		assert.strictEqual(ordinary.count, 7);
		assert.strictEqual(ordinary.mean, 1);
	});

	it('reports the event loop delay of the reporting thread with every flush', async function () {
		this.timeout(30000);
		const seen = [];
		analytics.addAnalyticsListener((metrics) => {
			for (const entry of metrics) if (entry.metric === 'event-loop-delay') seen.push(entry);
		});
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(1, 'db-write', 'DelayProbe');
		await waitFor(() => seen.length > 0, { timeout: 10000, message: 'the flush carried an event-loop-delay entry' });
		const [entry] = seen;
		assert.strictEqual(entry.perThread, true);
		assert.strictEqual(typeof entry.threadId, 'number');
		assert.ok(entry.count >= 1, JSON.stringify(entry));
		assert.ok(entry.mean >= 0 && entry.maxDelay >= entry.mean, JSON.stringify(entry));
	});

	it('keeps a stall that comes right after a flush, before the next window opens', async function () {
		this.timeout(30000);
		const flushes = [];
		analytics.addAnalyticsListener((metrics) => {
			if (metrics.some((entry) => entry.metric === 'db-write' && entry.path === 'GapFirst')) {
				// Past the sampler's first firings after the flush's own reset, well inside one interval.
				setTimeout(() => {
					const end = performance.now() + 300;
					while (performance.now() < end);
					analytics.recordAction(1, 'db-write', 'GapProbe');
				}, 60);
			}
			if (metrics.some((entry) => entry.metric === 'db-write' && entry.path === 'GapProbe')) flushes.push(metrics);
		});
		analytics.setAnalyticsEnabled(false);
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(1, 'db-write', 'GapFirst');
		await waitFor(() => flushes.length > 0, { timeout: 10000, message: 'the probe after the stall was flushed' });
		const delay = flushes[0].find((entry) => entry.metric === 'event-loop-delay');
		assert.ok(delay && delay.maxDelay >= 200, JSON.stringify(delay));
	});

	it('reports a stall that ran past the flush deadline in that flush', async function () {
		this.timeout(30000);
		const flushes = [];
		analytics.addAnalyticsListener((metrics) => {
			if (metrics.some((entry) => entry.metric === 'db-write' && entry.path === 'StallProbe')) flushes.push(metrics);
		});
		analytics.setAnalyticsEnabled(false);
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(1, 'db-write', 'StallProbe');
		setTimeout(
			() =>
				setImmediate(() => {
					const start = performance.now();
					while (performance.now() - start < 300) {}
				}),
			analytics.analyticsDelay - 5
		);
		await waitFor(() => flushes.length > 0, { timeout: 10000, message: 'the flush carried the probe' });
		const delay = flushes[0].find((entry) => entry.metric === 'event-loop-delay');
		assert.ok(delay?.maxDelay >= 200, `the 300 ms stall is in the flush: ${JSON.stringify(delay)}`);
	});

	it('drops actions recorded before a disable instead of reporting them after re-enable', async function () {
		this.timeout(30000);
		const flushedPaths = [];
		analytics.addAnalyticsListener((metrics) => {
			for (const entry of metrics) if (entry.metric === 'db-write') flushedPaths.push(entry.path);
		});
		analytics.setAnalyticsEnabled(true);
		analytics.recordAction(1, 'db-write', 'ReenableStale');
		await delay(400);
		analytics.setAnalyticsEnabled(false);
		analytics.setAnalyticsEnabled(true);
		const enabledAt = performance.now();
		analytics.recordAction(1, 'db-write', 'ReenableFresh');
		const report = await waitFor(
			() => {
				for (const { value } of databases.system.hdb_raw_analytics.primaryStore.getRange({
					start: false,
					end: Infinity,
				})) {
					if (value?.metrics?.some((entry) => entry.path === 'ReenableFresh')) return value;
				}
			},
			{ timeout: 10000, message: 'the flush after re-enable was recorded' }
		);
		const paths = report.metrics.filter((entry) => entry.metric === 'db-write').map((entry) => entry.path);
		assert.deepStrictEqual(paths, ['ReenableFresh']);
		assert.ok(!flushedPaths.includes('ReenableStale'), 'no flush reported the pre-disable action');
		assert.ok(report.period <= performance.now() - enabledAt, `period ${report.period} covers only the new window`);
	});
});
