'use strict';

require('../../testUtils');
const assert = require('node:assert');
const { once } = require('node:events');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor.js');
const analytics = require('#src/resources/analytics/write');
const { startWorker } = require('#src/server/threads/manageThreads');
const { getDatabases } = require('#src/resources/databases');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');
const { getConfigFilePath } = require('#src/config/configUtils');
const { forComponent } = require('#src/utility/logging/harper_logger');
const { getTransactionQueueDepths } = require('#src/resources/DatabaseTransaction');

const PERCENTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 1];
const METRIC_PREFIX = 'sample-runs-';

/** The distribution as the recorder computed it before it kept runs: every sample in a Float32Array, sorted. */
function sortedDistribution(samples) {
	const values = Float32Array.from(samples);
	values.sort();
	const count = values.length;
	let lastUpperBound = 0;
	const distribution = [];
	let lastValue;
	for (const percentile of PERCENTILES) {
		const upperBound = Math.floor(count * percentile);
		const value = values[upperBound - 1];
		if (upperBound > lastUpperBound) {
			const bucket = upperBound - lastUpperBound;
			if (value === lastValue) {
				const entry = distribution[distribution.length - 1];
				if (typeof entry === 'number') distribution[distribution.length - 1] = { value: entry, count: 1 + bucket };
				else entry.count += bucket;
			} else {
				distribution.push(bucket > 1 ? { value, count: bucket } : value);
				lastValue = value;
			}
			lastUpperBound = upperBound;
		}
	}
	return distribution;
}

/** What a report carries for these samples, summed in recording order as the recorder does */
function expectedEntry(samples) {
	const count = samples.length;
	return {
		mean: samples.reduce((total, value) => total + value) / count,
		distribution: sortedDistribution(samples),
		count,
	};
}

function seededRandom(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SPECIAL_VALUES = [0, -0, NaN, Infinity, -Infinity, 1e-45, -1e-45, 3.4e38, -3.4e38, 0.1, 1, -1];
const valueKinds = {
	repeating: (random) => Math.floor(random() * 5) * 100,
	special: (random) => SPECIAL_VALUES[Math.floor(random() * SPECIAL_VALUES.length)],
	uniform: (random) => random() * 1000,
	signed: (random) => (random() - 0.5) * 1e6,
	latency: (random) => Math.round(random() ** 4 * 5000) / 100,
};

describe('analytics sample runs', function () {
	this.timeout(30_000);

	describe('distributionOfRuns', () => {
		// The runs a main thread receives need not be maximal: equal values can sit in separate runs, apart or adjacent.
		it('gives the distribution sorting every sample would, for any runs', () => {
			const random = seededRandom(20261117);
			let cases = 0;
			for (const [kind, nextValue] of Object.entries(valueKinds)) {
				for (const runCount of [1, 2, 3, 31, 32, 33, 64, 500, 3000]) {
					for (const maxRun of [1, 3, 40]) {
						const values = new Float32Array(runCount);
						const runs = new Uint32Array(runCount);
						const samples = [];
						for (let i = 0; i < runCount; i++) {
							values[i] = nextValue(random);
							runs[i] = 1 + Math.floor(random() * maxRun);
							for (let j = 0; j < runs[i]; j++) samples.push(values[i]);
						}
						assert.deepStrictEqual(
							analytics.distributionOfRuns(values, runs, runCount, samples.length),
							sortedDistribution(samples),
							`${kind}: ${runCount} runs of up to ${maxRun}`
						);
						cases++;
					}
				}
			}
			assert.strictEqual(cases, 135);
		});

		it('sorts a NaN last whatever its sign bit, as the typed array sort does', () => {
			const values = new Float32Array(4);
			new Uint32Array(values.buffer).set([0xffc00000, 0x3f800000, 0xbf800000, 0x7fc00000]); // -NaN, 1, -1, NaN
			const samples = Array.from(values);
			assert.deepStrictEqual(
				analytics.distributionOfRuns(values, new Uint32Array([1, 1, 1, 1]), 4, 4),
				sortedDistribution(samples)
			);
		});

		it('reads only the runs it is given, past which a buffer may hold anything', () => {
			const values = new Float32Array([5, 1, 3, 99, -99]);
			const runs = new Uint32Array([2, 1, 4, 1000, 1000]);
			assert.deepStrictEqual(
				analytics.distributionOfRuns(values, runs, 3, 7),
				sortedDistribution([5, 5, 1, 3, 3, 3, 3])
			);
		});
	});

	describe('recording', () => {
		const reports = [];
		let removeListener;
		let wasEnabled;

		before(() => {
			setupTestDBPath();
			wasEnabled = analytics.checkAnalyticsEnabled(false);
			removeListener = analytics.addAnalyticsListener((metrics) => {
				for (const entry of metrics) if (entry.metric.startsWith(METRIC_PREFIX)) reports.push(entry);
			});
		});

		after(() => {
			removeListener?.();
			if (wasEnabled !== undefined) analytics.setAnalyticsEnabled(wasEnabled);
		});

		function nextEntry(metric) {
			return waitFor(
				() => {
					const index = reports.findIndex((entry) => entry.metric === metric);
					if (index >= 0) return reports.splice(index, 1)[0];
				},
				{ timeout: 10_000, message: `a report carried ${metric}` }
			);
		}

		it('reports runs of repeated samples as the samples themselves, in the same field order', async () => {
			const metric = METRIC_PREFIX + 'repeats';
			analytics.setAnalyticsEnabled(true);
			const record = analytics.actionRecorder(metric);
			const samples = [120, 120, 120, 7, 7, 0, -0, -0, 0, NaN, NaN, 120, 3.5, 3.5, Infinity];
			for (let round = 0; round < 40; round++) {
				for (const [i, sample] of samples.entries()) {
					if (i % 2) record(sample);
					else analytics.recordAction(sample, metric);
				}
			}
			const entry = await nextEntry(metric);
			const recorded = Array.from({ length: 40 }, () => samples).flat();
			assert.deepStrictEqual(Object.keys(entry), ['metric', 'path', 'method', 'type', 'mean', 'distribution', 'count']);
			const { mean, distribution, count } = entry;
			assert.deepStrictEqual({ mean, distribution, count }, expectedEntry(recorded));
		});

		it('counts a run longer than one run holds', async () => {
			const metric = METRIC_PREFIX + 'long-run';
			analytics.setAnalyticsEnabled(true);
			const record = analytics.actionRecorder(metric);
			const recorded = [];
			for (const [value, repeats] of [
				[3, 70_000],
				[1, 2],
				[3, 65_535],
				[9, 1],
			]) {
				for (let i = 0; i < repeats; i++) {
					record(value);
					recorded.push(value);
				}
			}
			const { mean, distribution, count } = await nextEntry(metric);
			assert.deepStrictEqual({ mean, distribution, count }, expectedEntry(recorded));
		});

		it('records a recorder into the window it is called in, across a flush', async () => {
			const metric = METRIC_PREFIX + 'windows';
			analytics.setAnalyticsEnabled(true);
			const record = analytics.actionRecorder(metric, 'path', 'method', 'type');
			record(1);
			record(2);
			assert.deepStrictEqual(pick(await nextEntry(metric)), { path: 'path', count: 2, mean: 1.5 });
			for (let i = 0; i < 3; i++) record(5);
			assert.deepStrictEqual(pick(await nextEntry(metric)), { path: 'path', count: 3, mean: 5 });
		});

		it('drops what a recorder took before a reset, and records what it takes after it', async () => {
			const metric = METRIC_PREFIX + 'reset';
			analytics.setAnalyticsEnabled(true);
			const record = analytics.actionRecorder(metric);
			record(100);
			analytics.setAnalyticsEnabled(true);
			record(7);
			assert.deepStrictEqual(pick(await nextEntry(metric)), { path: undefined, count: 1, mean: 7 });
		});

		it('records nothing while analytics is off', async () => {
			const metric = METRIC_PREFIX + 'off';
			const marker = METRIC_PREFIX + 'off-marker';
			analytics.setAnalyticsEnabled(true);
			const record = analytics.actionRecorder(metric);
			record(1);
			analytics.setAnalyticsEnabled(false);
			record(2);
			analytics.setAnalyticsEnabled(true);
			analytics.recordAction(1, marker);
			await nextEntry(marker);
			assert.ok(!reports.some((entry) => entry.metric === metric));
		});
	});

	describe('a worker', () => {
		before(() => setupTestDBPath());

		function storedEntry(threadId, metric) {
			const rawAnalytics = getDatabases().system?.hdb_raw_analytics;
			if (!rawAnalytics) return;
			for (const { value } of rawAnalytics.primaryStore.getRange({ start: false, end: Infinity })) {
				if (value.threadId !== threadId) continue;
				const entry = value.metrics.find((entry) => entry.metric === metric);
				if (entry) return entry;
			}
		}

		it('hands its samples to the main thread, which stores the distribution a local flush gives', async () => {
			const metric = METRIC_PREFIX + 'worker';
			const random = seededRandom(7);
			const samples = [];
			for (let i = 0; i < 4000; i++)
				samples.push(i % 3 ? valueKinds.latency(random) : valueKinds.special(random), i % 5 ? 120 : 64);
			const worker = startWorker(require.resolve('../fixtures/analyticsSampleRuns.cjs'), {
				name: 'http',
				autoRestart: false,
				workerData: { metric, samples },
			});
			const messages = [];
			worker.prependListener('message', (message) => {
				if (message.type === 'sample-runs-entry') messages.push(message);
			});
			const threadId = worker.threadId;
			try {
				const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(25_000) });
				assert.strictEqual(code, 0);
			} finally {
				if (worker.threadId !== -1) await worker.terminate();
			}
			const sent = messages.at(-1);
			assert.deepStrictEqual(
				sent?.entry,
				['metric', 'path', 'method', 'type', 'mean', 'count'],
				"the worker's listeners see the entry without its runs"
			);
			assert.strictEqual(sent.detached, true, 'its buffers were transferred, not copied');
			assert.strictEqual(sent.runsSent, 2, 'listed once each, though a listener put one entry in the array twice');
			assert.strictEqual(sent.tenthRuns, 1, "1,000 samples of 0.1 are one run, after float32's rounding");
			const entry = await waitFor(() => storedEntry(threadId, metric), {
				timeout: 10_000,
				message: 'the main thread stored the worker report',
			});
			assert.deepStrictEqual(Object.keys(entry), ['metric', 'path', 'method', 'type', 'mean', 'distribution', 'count']);
			const { mean, distribution, count } = entry;
			assert.deepStrictEqual({ mean, distribution, count }, expectedEntry(samples));
		});
	});
});

describe('the main thread summarizing worker reports', function () {
	this.timeout(60_000);
	before(async () => {
		setupTestDBPath();
		await analytics.recordAnalyticsReportForTests({ report: { time: Date.now(), period: 1000, metrics: [] } });
	});

	const workerReport = (metricCount, label) => ({
		report: {
			time: Date.now(),
			period: 1000,
			threadId: 98,
			metrics: Array.from({ length: metricCount }, (_, i) => ({
				metric: METRIC_PREFIX + label,
				path: 'p' + i,
				method: undefined,
				type: undefined,
				mean: 2,
				count: 4,
			})),
		},
		runs: Array.from({ length: metricCount }, (_, index) => ({
			index,
			values: new Float32Array([3, 1, 2]),
			runs: new Uint16Array([1, 2, 1]),
			length: 3,
		})),
	});
	const summarized = (messages) =>
		messages.reduce(
			(total, message) => total + message.report.metrics.filter((metric) => metric.distribution).length,
			0
		);

	it('summarizes small metrics that arrive together without a turn each', async () => {
		const messages = [workerReport(3, 'paced-a'), workerReport(3, 'paced-b')];
		const stored = messages.map((message) => analytics.recordAnalyticsReportForTests(message));
		let turns = 0;
		const deadline = performance.now() + 10_000;
		while (summarized(messages) < 6 && performance.now() < deadline) {
			await new Promise(setImmediate);
			turns++;
		}
		assert.strictEqual(summarized(messages), 6, 'all six were summarized');
		assert.ok(turns <= 2, `six small metrics took ${turns} turns`);
		await Promise.all(stored);
		const raw = getDatabases().system.hdb_raw_analytics;
		for (const { report } of messages) {
			const row = raw.primaryStore.get(report.id);
			assert.ok(row, 'the report was stored');
			for (const metric of row.metrics.filter((metric) => metric.metric.startsWith(METRIC_PREFIX + 'paced'))) {
				assert.deepStrictEqual(metric.distribution, sortedDistribution([3, 1, 1, 2]));
			}
		}
	});

	it('sorts a large metric over several turns', async () => {
		const runCount = 1_000_000;
		const random = seededRandom(31);
		const values = new Float32Array(runCount);
		const runs = new Uint16Array(runCount);
		const samples = [];
		for (let i = 0; i < runCount; i++) {
			values[i] = valueKinds.latency(random);
			runs[i] = 1;
			samples.push(values[i]);
		}
		const message = {
			report: {
				time: Date.now(),
				period: 1000,
				threadId: 97,
				metrics: [
					{
						metric: METRIC_PREFIX + 'stepped',
						path: undefined,
						method: undefined,
						type: undefined,
						mean: 0,
						count: samples.length,
					},
				],
			},
			runs: [{ index: 0, values, runs, length: runCount }],
		};
		const stored = analytics.recordAnalyticsReportForTests(message);
		let turns = 0;
		const deadline = performance.now() + 10_000;
		while (!message.report.metrics[0].distribution && performance.now() < deadline) {
			await new Promise(setImmediate);
			turns++;
		}
		assert.ok(message.report.metrics[0].distribution, 'summarized');
		assert.ok(turns >= 2, `a ${runCount}-run sort took ${turns} turns`);
		assert.deepStrictEqual(message.report.metrics[0].distribution, sortedDistribution(samples));
		await stored;
	});

	it('stores a report with nothing to summarize after the reports queued before it', async () => {
		const queued = workerReport(1, 'order-queued');
		queued.runs[0] = {
			index: 0,
			values: new Float32Array(Array.from({ length: 400_000 }, (_, i) => (i * 7919) % 400_000)),
			runs: new Uint16Array(400_000).fill(1),
			length: 400_000,
		};
		queued.report.metrics[0].count = 400_000;
		const plain = { report: { time: Date.now(), period: 1000, threadId: 96, metrics: [{ metric: 'memory', rss: 1 }] } };
		const first = analytics.recordAnalyticsReportForTests(queued);
		const second = analytics.recordAnalyticsReportForTests(plain);
		await Promise.all([first, second]);
		assert.ok(plain.report.id > queued.report.id, 'stored in the order the reports arrived');
	});

	it('logs a report the raw store refuses, rather than rejecting or throwing at its handler', async () => {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		const method = primaryStore.putOffThread ? 'putOffThread' : 'put';
		const original = primaryStore[method];
		const plain = () => ({ report: { time: Date.now(), period: 1000, threadId: 96, metrics: [{ metric: 'memory' }] } });
		try {
			primaryStore[method] = () => Promise.reject(new Error('refused by the raw store'));
			assert.strictEqual(
				await analytics.recordAnalyticsReportForTests(workerReport(2, 'refused')),
				undefined,
				'a report queued behind its summary'
			);
			assert.strictEqual(
				await analytics.recordAnalyticsReportForTests(plain()),
				undefined,
				'a report with nothing to summarize, stored on arrival'
			);
			primaryStore[method] = () => {
				throw new Error('refused before writing');
			};
			assert.strictEqual(await analytics.recordAnalyticsReportForTests(plain()), undefined);
		} finally {
			primaryStore[method] = original;
		}
	});

	const fakeWorker = {
		threadId: 95,
		performance: { eventLoopUtilization: () => ({ idle: 1, active: 0, utilization: 0 }) },
	};
	const largeReport = (label, runCount) => {
		const message = workerReport(1, label);
		message.runs[0] = {
			index: 0,
			values: new Float32Array(Array.from({ length: runCount }, (_, i) => (i * 7919) % runCount)),
			runs: new Uint16Array(runCount).fill(1),
			length: runCount,
		};
		message.report.metrics[0].count = runCount;
		return message;
	};

	it("stores a report past the queue bound with every mean and count, and no distribution, not even a listener's", async () => {
		analytics.setSummaryLimitsForTests(300_000);
		try {
			const first = largeReport('bounded-first', 200_000);
			const second = largeReport('bounded-second', 200_000);
			second.report.metrics[0].distribution = 'set by a listener';
			second.report.metrics.push({ metric: 'memory', rss: 1 });
			await Promise.all([
				analytics.recordAnalyticsReportForTests(first, fakeWorker),
				analytics.recordAnalyticsReportForTests(second, fakeWorker),
			]);
			assert.ok(Array.isArray(first.report.metrics[0].distribution), 'the first report was summarized');
			const [sampled, ...others] = second.report.metrics;
			assert.deepStrictEqual(Object.keys(sampled), ['metric', 'path', 'method', 'type', 'mean', 'count']);
			assert.strictEqual(sampled.count, 200_000);
			assert.deepStrictEqual(
				others.map((metric) => metric.metric),
				['memory', 'utilization']
			);
			assert.ok(second.report.id > first.report.id, 'both were stored, in order');
		} finally {
			analytics.setSummaryLimitsForTests();
		}
	});

	/**
	 * Holds the first raw commit open until `release()`; later writes go straight through. `restore(stored)` releases it
	 * however the test ended and waits for the writes behind it, which every later write in the file would otherwise
	 * queue behind.
	 */
	function holdFirstCommit(primaryStore) {
		const putOffThread = primaryStore.putOffThread;
		const gate = { calls: [], release: undefined, released: false };
		primaryStore.putOffThread = function (id, value) {
			gate.calls.push(id);
			const committed = putOffThread.call(this, id, value);
			if (gate.calls.length > 1) return committed;
			return committed.then(
				(result) =>
					new Promise((resolve) => {
						gate.release = () => resolve(result);
						if (gate.released) resolve(result);
					})
			);
		};
		gate.restore = async (stored) => {
			gate.released = true;
			gate.release?.();
			await Promise.allSettled(stored);
			primaryStore.putOffThread = putOffThread;
		};
		return gate;
	}

	it('writes one report at a time, so each commits in key order', async function () {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		if (!primaryStore.putOffThread) this.skip(); // an LMDB store's put already commits in call order
		const gate = holdFirstCommit(primaryStore);
		const plain = () => ({ report: { time: Date.now(), period: 1000, threadId: 92, metrics: [{ metric: 'memory' }] } });
		let stored = [];
		try {
			const first = plain();
			const second = plain();
			stored = [
				analytics.recordAnalyticsReportForTests(first, fakeWorker),
				analytics.recordAnalyticsReportForTests(second, fakeWorker),
			];
			await waitFor(() => gate.release);
			await new Promise(setImmediate);
			assert.deepStrictEqual(gate.calls, [first.report.id], 'the second waits for the first to commit');
			gate.release();
			await Promise.all(stored);
			assert.deepStrictEqual(gate.calls, [first.report.id, second.report.id]);
			assert.ok(primaryStore.getSync(second.report.id), 'committed');
		} finally {
			await gate.restore(stored);
		}
	});

	it('drops reports past the bound on raw writes still waiting, with one warning', async () => {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		const method = primaryStore.putOffThread ? 'putOffThread' : 'put';
		const original = primaryStore[method];
		const stalled = [];
		let released = false;
		primaryStore[method] = () => (released ? Promise.resolve(true) : new Promise((resolve) => stalled.push(resolve)));
		const logger = forComponent('analytics').conditional;
		const warn = logger.warn;
		const warnings = [];
		logger.warn = (message) => warnings.push(message);
		analytics.setSummaryLimitsForTests(undefined, undefined, 3);
		const plain = () => ({ report: { time: Date.now(), period: 1000, threadId: 91, metrics: [{ metric: 'memory' }] } });
		let stored = [];
		try {
			const messages = Array.from({ length: 5 }, plain);
			stored = messages.map((message) => analytics.recordAnalyticsReportForTests(message, fakeWorker));
			assert.deepStrictEqual(
				stored.map((written) => written !== undefined),
				[true, true, true, false, false]
			);
			assert.strictEqual(
				warnings.filter((message) => message.startsWith('Analytics reports are not reaching')).length,
				1
			);
			released = true;
			for (const resolve of stalled) resolve(true);
			await Promise.all(stored);
		} finally {
			// a write left pending would hold every later test's write behind it, and one chained behind the gate calls
			// the store method when it runs
			released = true;
			for (const resolve of stalled) resolve(true);
			await Promise.allSettled(stored);
			primaryStore[method] = original;
			logger.warn = warn;
			analytics.setSummaryLimitsForTests();
		}
	});

	it("does not write the main thread's report from before a reset after it, though it waited behind a write", async function () {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		if (!primaryStore.putOffThread) this.skip(); // an LMDB store's put starts at once
		const gate = holdFirstCommit(primaryStore);
		const plain = () => ({ report: { time: Date.now(), period: 1000, metrics: [{ metric: 'memory' }] } });
		let stored = [];
		try {
			const workers = plain();
			const own = plain();
			stored = [
				analytics.recordAnalyticsReportForTests(workers, fakeWorker),
				analytics.recordAnalyticsReportForTests(own),
			];
			await waitFor(() => gate.release);
			analytics.setAnalyticsEnabled(true);
			gate.release();
			await Promise.all(stored);
			assert.deepStrictEqual(gate.calls, [workers.report.id]);
			assert.strictEqual(own.report.id, undefined, 'not stamped, so not in the byte total either');
		} finally {
			await gate.restore(stored);
		}
	});

	it("aborts a raw write's transaction when its commit is refused", async function () {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		if (!primaryStore.putOffThread) this.skip(); // only a RocksDB store writes through a transaction
		// the store's own Transaction class: requiring the package here can load a second copy of it
		let prototype;
		primaryStore.transactionSync((transaction) => (prototype = Object.getPrototypeOf(transaction)));
		const { commit, abort } = prototype;
		let aborted = 0;
		prototype.commit = function () {
			return Promise.reject(new Error('refused by the commit'));
		};
		prototype.abort = function () {
			aborted++;
			return abort.call(this);
		};
		try {
			await assert.rejects(primaryStore.putOffThread(Date.now() * 1000, { id: 'refused-commit' }), /refused/);
			assert.strictEqual(aborted, 1);
		} finally {
			prototype.commit = commit;
			prototype.abort = abort;
		}
	});

	it("keeps rotating the main thread's own window while a raw commit is held", async function () {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		if (!primaryStore.putOffThread) this.skip(); // an LMDB store's put does not wait behind another write
		analytics.setAnalyticsEnabled(true);
		const gate = holdFirstCommit(primaryStore);
		const reported = [];
		const removeListener = analytics.addAnalyticsListener((metrics) => {
			if (metrics.some((entry) => entry.metric === METRIC_PREFIX + 'rotation')) reported.push(metrics);
		});
		let stored = [];
		try {
			const held = { report: { time: Date.now(), period: 1000, threadId: 90, metrics: [{ metric: 'memory' }] } };
			stored = [analytics.recordAnalyticsReportForTests(held, fakeWorker)];
			await waitFor(() => gate.release);
			analytics.recordAction(1, METRIC_PREFIX + 'rotation');
			await waitFor(() => reported.length === 1, { timeout: 5000, message: 'the first window was reported' });
			analytics.recordAction(1, METRIC_PREFIX + 'rotation');
			await waitFor(() => reported.length === 2, {
				timeout: 5000,
				message: 'the next window was reported while the commit is held',
			});
		} finally {
			removeListener();
			// a reset skips this test's main-thread reports still queued behind the held write, which would otherwise
			// call the store method after a later test replaced it
			analytics.setAnalyticsEnabled(true);
			await gate.restore(stored);
		}
	});

	it("releases a window's samples when a callback metric throws during its flush", async () => {
		analytics.setAnalyticsEnabled(true);
		const logger = forComponent('analytics').conditional;
		const logError = logger.error;
		logger.error = () => {}; // the failed flush is logged
		try {
			// first in the window, so the flush throws before it reaches the samples below
			analytics.recordAction(() => {
				throw new Error('callback refused');
			}, METRIC_PREFIX + 'throwing-callback');
			// an idle recorder keeps its action, and with it any samples the flush did not release
			const record = analytics.actionRecorder(METRIC_PREFIX + 'held-by-recorder');
			for (let i = 0; i < 1_000_000; i++) record(i); // about 6 MB of runs
			global.gc();
			const recorded = process.memoryUsage().arrayBuffers;
			await waitFor(
				() => {
					global.gc();
					return recorded - process.memoryUsage().arrayBuffers > 4_000_000;
				},
				{ timeout: 10_000, message: 'the samples were released after the failed flush' }
			);
			record(0); // the recorder stays reachable until here, as an idle one in a module would
		} finally {
			logger.error = logError;
		}
	});

	/** Holds every raw write until the returned release(), while `run` stores reports */
	async function withStalledWrites(run) {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		const method = primaryStore.putOffThread ? 'putOffThread' : 'put';
		const original = primaryStore[method];
		const stalled = [];
		let released = false;
		primaryStore[method] = () => (released ? Promise.resolve(true) : new Promise((resolve) => stalled.push(resolve)));
		let stored = [];
		try {
			stored = run();
			return stored.map((written) => written !== undefined);
		} finally {
			released = true;
			for (const resolve of stalled) resolve(true);
			await Promise.allSettled(stored);
			primaryStore[method] = original;
			analytics.setSummaryLimitsForTests();
		}
	}
	const memoryReport = (path = undefined) => ({
		report: {
			time: Date.now(),
			period: 1000,
			threadId: 89,
			metrics: [{ metric: 'memory' }, { metric: 'memory', path }],
		},
	});

	it('drops a report whose estimated size would take the waiting raw writes past their byte bound', async () => {
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 2_000);
		const written = await withStalledWrites(() =>
			[memoryReport(), memoryReport('x'.repeat(1_000)), memoryReport()].map((message) =>
				analytics.recordAnalyticsReportForTests(message, fakeWorker)
			)
		);
		assert.deepStrictEqual(written, [true, false, true]);
	});

	it("returns a report's bytes to the bound once its write completes", async () => {
		const twoShortReports = () => {
			analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 2_000);
			return withStalledWrites(() =>
				[memoryReport(), memoryReport()].map((message) => analytics.recordAnalyticsReportForTests(message, fakeWorker))
			);
		};
		assert.deepStrictEqual(await twoShortReports(), [true, true]);
		assert.deepStrictEqual(await twoShortReports(), [true, true]);
	});

	it("counts every field of an entry, a callback metric's own included, toward its report's estimated size", async () => {
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 2_000);
		const withNote = memoryReport();
		withNote.report.metrics[1].note = 'x'.repeat(1_000);
		const written = await withStalledWrites(() =>
			[memoryReport(), withNote, memoryReport()].map((message) =>
				analytics.recordAnalyticsReportForTests(message, fakeWorker)
			)
		);
		assert.deepStrictEqual(written, [true, false, true]);
	});

	it('counts a typed array field at the size of the buffer it keeps', async () => {
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 2_000);
		const withView = memoryReport();
		withView.report.metrics[1].samples = new Float64Array(new ArrayBuffer(8_000), 0, 1);
		const written = await withStalledWrites(() =>
			[memoryReport(), withView, memoryReport()].map((message) =>
				analytics.recordAnalyticsReportForTests(message, fakeWorker)
			)
		);
		assert.deepStrictEqual(written, [true, false, true]);
	});

	it('charges a queued report for the distributions it will gain', async () => {
		// two of these reports fit the bound, but not with a distribution's room each
		const estimated =
			2 * (256 + 2 * ((METRIC_PREFIX + 'reserve-a').length + 'p0'.length) + 256 + 2 * 'utilization'.length);
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, estimated + 640);
		const stored = [workerReport(1, 'reserve-a'), workerReport(1, 'reserve-b')].map((message) =>
			analytics.recordAnalyticsReportForTests(message, fakeWorker)
		);
		try {
			assert.deepStrictEqual(
				stored.map((written) => written !== undefined),
				[true, false]
			);
		} finally {
			await Promise.all(stored);
			analytics.setSummaryLimitsForTests();
		}
	});

	it('summarizes an entry a listener put in the array twice once, for both places', async () => {
		const message = workerReport(1, 'twice');
		message.report.metrics.push(message.report.metrics[0]);
		await analytics.recordAnalyticsReportForTests(message, fakeWorker);
		const [first, second] = message.report.metrics;
		assert.strictEqual(second, first);
		assert.deepStrictEqual(first.distribution, sortedDistribution([3, 1, 1, 2]));
	});

	it('charges a queued report for a distribution at each place its entry appears', async () => {
		const entryBytes = (label) => 256 + 2 * ((METRIC_PREFIX + label).length + 'p0'.length);
		const utilizationBytes = 256 + 2 * 'utilization'.length;
		const head = entryBytes('twice-hd') + utilizationBytes + 640;
		const doubled = 2 * entryBytes('twice-q2') + utilizationBytes;
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, head + doubled + 640 + 320);
		const twice = workerReport(1, 'twice-q2');
		twice.report.metrics.push(twice.report.metrics[0]);
		const stored = [workerReport(1, 'twice-hd'), twice].map((message) =>
			analytics.recordAnalyticsReportForTests(message, fakeWorker)
		);
		try {
			assert.deepStrictEqual(
				stored.map((written) => written !== undefined),
				[true, false],
				'one room for a distribution at each place, though one would have fit'
			);
		} finally {
			await Promise.all(stored);
			analytics.setSummaryLimitsForTests();
		}
	});

	it('drops a report past the bound on reports queued behind a summary', async () => {
		analytics.setSummaryLimitsForTests(undefined, undefined, 2);
		const stored = [workerReport(1, 'queued-count'), memoryReport(), memoryReport()].map((message) =>
			analytics.recordAnalyticsReportForTests(message, fakeWorker)
		);
		try {
			assert.deepStrictEqual(
				stored.map((written) => written !== undefined),
				[true, true, false]
			);
		} finally {
			await Promise.all(stored);
			analytics.setSummaryLimitsForTests();
		}
	});

	it('drops a report whose estimated size would take the queue behind a summary past the byte bound', async () => {
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 30_000);
		const longPath = () => memoryReport('x'.repeat(10_000));
		const stored = [workerReport(1, 'queued-bytes'), longPath(), longPath()].map((message) =>
			analytics.recordAnalyticsReportForTests(message, fakeWorker)
		);
		try {
			assert.deepStrictEqual(
				stored.map((written) => written !== undefined),
				[true, true, false]
			);
		} finally {
			await Promise.all(stored);
			analytics.setSummaryLimitsForTests();
		}
	});

	it("returns a queued report's bytes to the bound once it leaves the queue", async () => {
		for (let pass = 0; pass < 2; pass++) {
			analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 30_000);
			const stored = [workerReport(1, 'queued-release'), memoryReport('x'.repeat(10_000))].map((message) =>
				analytics.recordAnalyticsReportForTests(message, fakeWorker)
			);
			try {
				assert.deepStrictEqual(
					stored.map((written) => written !== undefined),
					[true, true],
					'pass ' + pass
				);
			} finally {
				await Promise.all(stored);
				analytics.setSummaryLimitsForTests();
			}
		}
	});

	it('writes a report larger than the byte bound when no other raw write is waiting', async () => {
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 100);
		const written = await withStalledWrites(() =>
			[memoryReport(), memoryReport()].map((message) => analytics.recordAnalyticsReportForTests(message, fakeWorker))
		);
		assert.deepStrictEqual(written, [true, false]);
	});

	it("counts a distribution toward a waiting report's estimated size", async () => {
		analytics.setSummaryLimitsForTests(undefined, undefined, undefined, 2_000);
		const withDistribution = memoryReport();
		withDistribution.report.metrics[1].distribution = Array.from({ length: 10 }, (_, i) => i);
		const written = await withStalledWrites(() =>
			[memoryReport(), withDistribution, memoryReport()].map((message) =>
				analytics.recordAnalyticsReportForTests(message, fakeWorker)
			)
		);
		assert.deepStrictEqual(written, [true, false, true]);
	});

	it("rejects, rather than throws, a raw write it cannot stage, and aborts that write's transaction", async function () {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		if (!primaryStore.putOffThread) this.skip(); // only a RocksDB store writes through a transaction
		let prototype;
		primaryStore.transactionSync((transaction) => (prototype = Object.getPrototypeOf(transaction)));
		const { abort } = prototype;
		let aborted = 0;
		prototype.abort = function () {
			aborted++;
			return abort.call(this);
		};
		primaryStore.putSync = () => {
			throw new Error('refused while staging');
		};
		try {
			const written = primaryStore.putOffThread(Date.now() * 1000, { id: 'unstaged' });
			await assert.rejects(written, /staging/);
			assert.strictEqual(aborted, 1);
		} finally {
			delete primaryStore.putSync;
			prototype.abort = abort;
		}
	});

	it('rejects, rather than throws, a raw write whose transaction cannot be opened', async function () {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		if (!primaryStore.putOffThread) this.skip(); // only a RocksDB store writes through a transaction
		const { store } = primaryStore;
		let written;
		primaryStore.store = undefined;
		try {
			written = primaryStore.putOffThread(Date.now() * 1000, { id: 'unopened' });
		} finally {
			primaryStore.store = store;
		}
		await assert.rejects(written);
	});

	it("leaves a raw write out of the thread's outstanding writes", async function () {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		if (!primaryStore.putOffThread) this.skip(); // only a RocksDB store writes through a transaction
		getTransactionQueueDepths();
		const before = getTransactionQueueDepths().writeDepth;
		const written = primaryStore.putOffThread(Date.now() * 1000, { id: 'untracked', metrics: [] });
		const during = getTransactionQueueDepths().writeDepth;
		await written;
		assert.strictEqual(during, before, 'a stuck commit here must not count toward the overload check');
	});

	it('stores the computed distribution though a worker listener edited the entry', async () => {
		const message = workerReport(1, 'listener-edited');
		delete message.report.metrics[0].mean;
		message.report.metrics[0].distribution = 'set by a listener';
		await analytics.recordAnalyticsReportForTests(message, fakeWorker);
		assert.deepStrictEqual(message.report.metrics[0].distribution, sortedDistribution([3, 1, 1, 2]));
	});

	it('counts the room run buffers hold toward the run bound, not just the runs in them', async () => {
		analytics.setSummaryLimitsForTests(150_000);
		const message = workerReport(1, 'roomy');
		const values = new Float32Array(200_000);
		for (let i = 0; i < 100_000; i++) values[i] = i;
		message.runs[0] = { index: 0, values, runs: new Uint16Array(200_000).fill(1), length: 100_000 };
		message.report.metrics[0].count = 100_000;
		try {
			await analytics.recordAnalyticsReportForTests(message, fakeWorker);
			assert.ok(message.report.id, 'the report was stored');
			assert.ok(!('distribution' in message.report.metrics[0]));
			assert.strictEqual(message.report.metrics[0].count, 100_000);
		} finally {
			analytics.setSummaryLimitsForTests();
		}
	});

	it('keeps every distribution of a burst the main thread clears in time', async () => {
		const burst = Array.from({ length: 12 }, (_, i) => largeReport('burst-' + i, 200_000));
		await Promise.all(burst.map((message) => analytics.recordAnalyticsReportForTests(message, fakeWorker)));
		for (const { report } of burst) assert.ok(Array.isArray(report.metrics[0].distribution), 'summarized');
	});

	it('stores a report without distributions once the oldest queued one has waited too long', async () => {
		analytics.setSummaryLimitsForTests(undefined, 1);
		try {
			const queued = largeReport('behind-queued', 200_000);
			const late = largeReport('behind-late', 200_000);
			const first = analytics.recordAnalyticsReportForTests(queued, fakeWorker);
			const start = performance.now();
			while (performance.now() - start < 3); // the queued report waits; the drain has not started
			const second = analytics.recordAnalyticsReportForTests(late, fakeWorker);
			await Promise.all([first, second]);
			assert.ok(Array.isArray(queued.report.metrics[0].distribution), 'the queued report was summarized');
			assert.ok(!('distribution' in late.report.metrics[0]), 'the late one was not');
			assert.strictEqual(late.report.metrics[0].count, 200_000);
		} finally {
			analytics.setSummaryLimitsForTests();
		}
	});

	it('warns about reports past the bound at most once a minute, with or without a queue', async () => {
		const logger = forComponent('analytics').conditional;
		const warn = logger.warn;
		const warnings = [];
		logger.warn = (message) => warnings.push(message);
		analytics.setSummaryLimitsForTests(300_000);
		const record = (message) => analytics.recordAnalyticsReportForTests(message, fakeWorker);
		const behind = () => warnings.filter((message) => message.startsWith('Analytics summaries are behind')).length;
		try {
			await Promise.all(
				[
					['a', 200_000],
					['b', 200_000],
					['c', 50_000],
					['d', 200_000],
				].map(([label, runs]) => record(largeReport('warned-' + label, runs)))
			);
			await record(largeReport('warned-e', 400_000));
			assert.strictEqual(behind(), 1, 'one warning for two queued reports and a lone one past the bound');
			const aMinuteLater = () => analytics.setSummaryLimitsForTests(300_000);
			aMinuteLater();
			await record(largeReport('warned-f', 400_000));
			assert.strictEqual(behind(), 2);
		} finally {
			logger.warn = warn;
			analytics.setSummaryLimitsForTests();
		}
	});

	it('stores queued reports with nothing to summarize within the per-turn budget', async () => {
		const primaryStore = getDatabases().system.hdb_raw_analytics.primaryStore;
		const put = primaryStore.put;
		let turn = 0;
		let ticking = true;
		void (async () => {
			while (ticking) {
				await new Promise(setImmediate);
				turn++;
			}
		})();
		const putTurns = [];
		// the synchronous write the budget bounds: a RocksDB store's own writes leave this thread
		const putOffThread = primaryStore.putOffThread;
		primaryStore.putOffThread = undefined;
		primaryStore.put = () => {
			const start = performance.now();
			while (performance.now() - start < 1); // as long as encoding a large report takes
			putTurns.push(turn);
			return Promise.resolve(true);
		};
		try {
			const plain = Array.from({ length: 8 }, () => ({
				report: { time: Date.now(), period: 1000, threadId: 93, metrics: [{ metric: 'memory' }] },
			}));
			await Promise.all(
				[largeReport('budget-queued', 400_000), ...plain].map((message) =>
					analytics.recordAnalyticsReportForTests(message, fakeWorker)
				)
			);
		} finally {
			primaryStore.put = put;
			primaryStore.putOffThread = putOffThread;
			ticking = false;
		}
		const perTurn = new Map();
		for (const at of putTurns) perTurn.set(at, (perTurn.get(at) ?? 0) + 1);
		assert.ok(Math.max(...perTurn.values()) <= 3, `stores per turn: ${[...perTurn.values()]}`);
	});

	it('stores a field a callback metric returned as it is, even in the shape of runs', async () => {
		analytics.setSummaryLimitsForTests(300_000);
		try {
			const callback = workerReport(1, 'callback-field');
			const returned = callback.runs.pop();
			callback.report.metrics[0].sampleRuns = returned;
			await analytics.recordAnalyticsReportForTests(callback, fakeWorker);
			assert.strictEqual(callback.report.metrics[0].sampleRuns, returned);
			assert.ok(!('distribution' in callback.report.metrics[0]), 'not summarized as runs');
			const first = largeReport('callback-first', 200_000);
			const second = largeReport('callback-second', 200_000);
			await Promise.all([
				analytics.recordAnalyticsReportForTests(first, fakeWorker),
				analytics.recordAnalyticsReportForTests(second, fakeWorker),
			]);
			assert.ok(!('distribution' in second.report.metrics[0]), 'the bound applied');
		} finally {
			analytics.setSummaryLimitsForTests();
		}
	});

	it('stores a report whose metric cannot be summarized, that metric without its distribution', async () => {
		const message = workerReport(2, 'unsummarizable');
		const held = message.runs[0];
		held.values = new Proxy(held.values, {
			get: (target, property) => {
				if (property === 'buffer') throw new Error('an unreadable buffer');
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		await analytics.recordAnalyticsReportForTests(message, fakeWorker);
		assert.ok(message.report.id, 'the report was stored');
		const [failed, summarized] = message.report.metrics;
		assert.deepStrictEqual(Object.keys(failed), ['metric', 'path', 'method', 'type', 'mean', 'count']);
		assert.ok(Array.isArray(summarized.distribution));
	});

	it("stores an entry whose run listing does not hold up without a listener's distribution", async () => {
		const message = workerReport(1, 'unlisted');
		message.report.metrics[0].count = 4.5;
		message.report.metrics[0].distribution = 'set by a listener';
		await analytics.recordAnalyticsReportForTests(message, fakeWorker);
		assert.ok(message.report.id, 'the report was stored');
		assert.ok(!('distribution' in message.report.metrics[0]));
	});

	it('leaves an entry whose count is not an integer without a distribution', async () => {
		const message = workerReport(1, 'bigint-count');
		message.report.metrics[0].count = 4n;
		await analytics.recordAnalyticsReportForTests(message, fakeWorker);
		assert.strictEqual(message.report.metrics[0].count, 4n);
		assert.ok(message.report.id, 'the report was stored');
		assert.ok(!('distribution' in message.report.metrics[0]));
	});

	it('summarizes the entry each run listing names, and no other', async () => {
		const message = workerReport(2, 'listed');
		message.runs = [
			{ ...message.runs[0], index: 1 },
			{ ...message.runs[1], index: 7 },
		];
		await analytics.recordAnalyticsReportForTests(message, fakeWorker);
		const [first, second] = message.report.metrics;
		assert.ok(!('distribution' in first));
		assert.deepStrictEqual(second.distribution, sortedDistribution([3, 1, 1, 2]));
	});

	it("stores runs that do not add up to their count without a distribution, not even a listener's", async () => {
		const message = workerReport(1, 'miscounted');
		message.report.metrics[0].count = 9;
		message.report.metrics[0].distribution = 'set by a listener';
		await analytics.recordAnalyticsReportForTests(message, fakeWorker);
		assert.deepStrictEqual(Object.keys(message.report.metrics[0]), [
			'metric',
			'path',
			'method',
			'type',
			'mean',
			'count',
		]);
	});

	it("does not store the main thread's own report from before a reset after it", async () => {
		const bytesSent = (bytes) => ({
			report: { time: Date.now(), period: 1000, metrics: [{ metric: 'bytes-sent', mean: bytes, count: 1 }] },
		});
		const before = bytesSent(0);
		await analytics.recordAnalyticsReportForTests(before, fakeWorker);
		const queued = largeReport('reset-queued', 400_000);
		const own = bytesSent(1_000_000);
		const stored = [
			analytics.recordAnalyticsReportForTests(queued, fakeWorker),
			analytics.recordAnalyticsReportForTests(own),
		];
		analytics.setAnalyticsEnabled(true);
		await Promise.all(stored);
		assert.ok(queued.report.id, "another thread's report is still stored");
		assert.strictEqual(own.report.id, undefined, "the main thread's report from before the reset is not");
		const next = bytesSent(6);
		await analytics.recordAnalyticsReportForTests(next, fakeWorker);
		assert.strictEqual(next.report.totalBytesProcessed - before.report.totalBytesProcessed, 6, 'not its bytes');
	});

	it('stores a report still being summarized before the main thread exits', async () => {
		const root = mkdtempSync(join(setupTestDBPath(), 'analytics-summary-exit-'));
		for (const directory of ['database', 'log', 'components', 'keys']) mkdirSync(join(root, directory));
		const config = YAML.parse(readFileSync(getConfigFilePath(), 'utf8'));
		config.rootPath = root;
		config.storage.path = join(root, 'database');
		writeFileSync(join(root, 'harper-config.yaml'), YAML.stringify(config));
		const childEnv = { ...process.env, ROOTPATH: root };
		for (const key of ['HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_SET_CONFIG']) delete childEnv[key];
		try {
			for (const mode of ['write', 'read'])
				await promisify(execFile)(process.execPath, [require.resolve('../fixtures/analyticsSummaryExit.cjs'), mode], {
					env: childEnv,
					timeout: 25_000,
				});
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 5 });
		}
	});
});

function pick({ path, count, mean }) {
	return { path, count, mean };
}
