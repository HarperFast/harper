require('../unitTests/testUtils');
const assert = require('node:assert');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { setupTestDBPath, ensureSystemTables } = require('../unitTests/testUtils');
const { setRootConfigEntry, readRootConfig } = require('../unitTests/rootConfigFixture');
const { getConfigFilePath } = require('#src/config/configUtils');
const { table, getDatabases } = require('#src/resources/databases');
const { fullTextDerivedIndexReadiness } = require('#src/resources/derivedIndexes');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const {
	fullTextTelemetryCollector,
	initializeFullTextTelemetry,
} = require('#src/resources/analytics/fullTextTelemetryRuntime');
const analytics = require('#src/resources/analytics/write');
const { waitFor } = require('../unitTests/waitFor');

const configuration = JSON.parse(process.env.FULLTEXT_ANALYTICS_BENCHMARK ?? 'null');
if (!configuration) throw new Error('Run benchmarks/fulltext-analytics.mjs to create an isolated benchmark child');

it(`qualifies actual Harper fulltext analytics (${configuration.profile})`, async function () {
	this.timeout(configuration.duration + 120_000);
	setupTestDBPath();
	setMainIsWorker(true);
	await ensureSystemTables();
	const binding = await loadFullTextNativeBinding();
	const runtime = await binding.runtimeInfo();
	assert.strictEqual(runtime.packageVersion, require('../package.json').optionalDependencies['@harperfast/fulltext']);
	const path = getConfigFilePath();
	const savedConfig = readFileSync(path, 'utf8');
	const products = [];
	let removeListener, rssTimer, eventLoop;
	let measuring = false;
	let exportedRows = 0;
	const observedSamples = new Map();
	let distinctObservedSamples = 0;
	let result;
	try {
		initializeFullTextTelemetry();
		analytics.setAnalyticsEnabled(true);
		setRootConfigEntry('analytics', {
			...readRootConfig().analytics,
			fullText: {
				enabled: false,
				intervalMilliseconds: configuration.interval,
				histograms: false,
				snapshotBytes: false,
			},
		});
		await waitFor(() => !fullTextTelemetryCollector.collecting);
		for (let index = 0; index < configuration.indexes; index++) {
			const Product = table({
				database: `analytics-benchmark-${process.pid}-${index}`,
				table: 'Product',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
				],
				fullTextIndexes: [
					{
						name: 'catalogSearch',
						fields: [{ name: 'title', weight: 1 }],
						analyzer: 'english@2',
						stopWords: true,
						positions: true,
						surfaceTerms: true,
						synonyms: [],
					},
				],
			});
			products.push(Product);
			await Product.put(Array.from({ length: 32 }, (_, id) => ({ id: String(id), title: 'stable catalog widget' })));
			await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30_000);
		}
		const query = {
			conditions: [
				{
					attribute: 'catalogSearch',
					comparator: 'matches',
					value: 'widget',
					maxIndexLagMilliseconds: configuration.maxIndexLag,
					...(configuration.maxIndexLag === 0 ? { waitForIndexMilliseconds: 5000 } : null),
				},
			],
			limit: 4,
		};
		const recordDuration = analytics.actionRecorder('duration', undefined, 'fulltext-benchmark', 'operation');
		async function search(Product) {
			const start = performance.now();
			const rows = [];
			for await (const row of await Product.search(query)) rows.push(await row);
			const duration = performance.now() - start;
			recordDuration(duration);
			assert.strictEqual(rows.length, 4);
			assert.strictEqual(new Set(rows.map((row) => row.id)).size, 4);
			for (const row of rows) assert.ok(row.title.includes('widget'));
			return duration;
		}
		async function load(duration, latencies) {
			const deadline = performance.now() + duration;
			let correctQueries = 0,
				mutations = 0;
			let failed = false;
			const queries = Array.from({ length: 4 }, async (_, worker) => {
				let sequence = worker;
				while (!failed && performance.now() < deadline) {
					const latency = await search(products[sequence++ % products.length]);
					if (latencies) latencies[correctQueries % latencies.length] = latency;
					correctQueries++;
				}
			});
			const writer = (async () => {
				while (!failed && performance.now() < deadline) {
					await products[mutations % products.length].put({
						id: '0',
						title: `stable catalog widget revision ${mutations}`,
					});
					mutations++;
					await delay(50);
				}
			})();
			const settlements = await Promise.allSettled(
				[...queries, writer].map((operation) =>
					operation.catch((error) => {
						failed = true;
						throw error;
					})
				)
			);
			const failures = settlements.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
			if (failures.length) throw new AggregateError(failures, 'Fulltext benchmark workload failed');
			return { correctQueries, mutations };
		}
		await load(2000);
		setRootConfigEntry('analytics', {
			...readRootConfig().analytics,
			fullText: {
				enabled: configuration.profile === 'enabled',
				intervalMilliseconds: configuration.interval,
				histograms: false,
				snapshotBytes: false,
			},
		});
		await waitFor(() => fullTextTelemetryCollector.collecting === (configuration.profile === 'enabled'));
		removeListener = analytics.addAnalyticsListener((metrics) => {
			if (!measuring) return;
			for (const row of metrics)
				if (row.metric === 'fulltext') {
					exportedRows++;
					const key = `${row.path}/${row.method}`;
					const identity = `${row.series}/${row.sampledAt}`;
					if (observedSamples.get(key) !== identity) {
						distinctObservedSamples++;
						observedSamples.set(key, identity);
					}
				}
		});
		const latencies = new Float64Array(100_000);
		const rssStart = process.memoryUsage().rss;
		let rssPeak = rssStart;
		rssTimer = setInterval(() => {
			rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
		}, 100).unref();
		eventLoop = monitorEventLoopDelay({ resolution: 20 });
		eventLoop.enable();
		const utilizationStart = performance.eventLoopUtilization();
		const cpuStart = process.cpuUsage();
		const started = performance.now();
		const startedWall = Date.now();
		measuring = true;
		const counts = await load(configuration.duration, latencies);
		measuring = false;
		const elapsedMilliseconds = performance.now() - started;
		const endedWall = Date.now();
		const cpu = process.cpuUsage(cpuStart);
		const utilization = performance.eventLoopUtilization(utilizationStart);
		const rssEnd = process.memoryUsage().rss;
		rssPeak = Math.max(rssPeak, rssEnd);
		clearInterval(rssTimer);
		eventLoop.disable();
		const sorted = latencies.subarray(0, Math.min(counts.correctQueries, latencies.length)).slice().sort();
		const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
		assert.ok(counts.correctQueries > 0 && counts.mutations > 0);
		if (configuration.profile === 'disabled') assert.strictEqual(exportedRows, 0);
		const sufficient = configuration.duration >= Math.max(60_000, configuration.interval + 1000);
		if (configuration.profile === 'enabled' && sufficient)
			assert.ok(exportedRows > 0, 'enabled profile must traverse existing analytics flush/export');
		const persistedRows = () => {
			let count = 0;
			const store = getDatabases().system?.hdb_raw_analytics?.primaryStore;
			if (store)
				for (const { value } of store.getRange({ start: false, end: Infinity }))
					if (value.time >= startedWall && value.time <= endedWall)
						count += value.metrics.filter((row) => row.metric === 'fulltext').length;
			return count;
		};
		if (configuration.profile === 'enabled' && sufficient) await waitFor(() => persistedRows() > 0, 5000);
		const persistedFullTextRawRows = persistedRows();
		if (configuration.profile === 'disabled') assert.strictEqual(persistedFullTextRawRows, 0);
		result = {
			profile: configuration.profile,
			pair: configuration.pair,
			source: configuration.source,
			node: process.version,
			platform: process.platform,
			architecture: process.arch,
			fulltext: runtime.packageVersion,
			indexes: products.length,
			queryConcurrency: 4,
			writerDelayMilliseconds: 50,
			configuredDurationMilliseconds: configuration.duration,
			configuredIntervalMilliseconds: configuration.interval,
			maxIndexLagMilliseconds: configuration.maxIndexLag,
			waitForIndexMilliseconds: configuration.maxIndexLag === 0 ? 5000 : null,
			histograms: false,
			snapshotBytes: false,
			startupWarmupMilliseconds: 2000,
			...counts,
			elapsedMilliseconds,
			queriesPerSecond: counts.correctQueries / (elapsedMilliseconds / 1000),
			throughputIncludesOracleAndCommonRequestAnalytics: true,
			latencyIncludesOracle: false,
			latencyRingCapacity: latencies.length,
			latencySampleCount: sorted.length,
			latencyCoverage: counts.correctQueries > latencies.length ? 'last-100000-completions' : 'all-completions',
			latencyMilliseconds: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
			cpu,
			eventLoop: {
				utilization: utilization.utilization,
				samples: eventLoop.count,
				meanDelayMilliseconds: eventLoop.mean / 1e6,
				maxDelayMilliseconds: eventLoop.max / 1e6,
				p99DelayMilliseconds: eventLoop.percentile(99) / 1e6,
			},
			rssBytes: { start: rssStart, end: rssEnd, peak: rssPeak },
			fullTextRowsExported: exportedRows,
			distinctObservedSamples,
			persistedFullTextRawRows,
			rssSamplingIntervalMilliseconds: 100,
			qualificationSufficient: sufficient,
			scope: sufficient
				? 'finite local paired integration workload; not sustained production qualification'
				: 'short smoke; insufficient full-cadence qualification',
		};
	} catch (error) {
		writeFileSync(
			join(configuration.output, 'failure.json'),
			JSON.stringify(
				{
					name: error.name,
					message: error.message,
					stack: error.stack,
					causes:
						error instanceof AggregateError
							? error.errors
									.slice(0, 8)
									.map((cause) => ({ name: cause.name, message: cause.message, stack: cause.stack }))
							: undefined,
				},
				null,
				2
			)
		);
		throw error;
	} finally {
		measuring = false;
		clearInterval(rssTimer);
		eventLoop?.disable();
		removeListener?.();
		const settlements = await Promise.allSettled(
			products.map(async (Product) => {
				const runtime = Product.derivedIndexRuntime;
				if (runtime) await runtime.close();
				Product.derivedIndexRuntime = undefined;
			})
		);
		writeFileSync(path, savedConfig);
		const failures = settlements.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
		if (failures.length) {
			writeFileSync(
				join(configuration.output, 'cleanup-failure.json'),
				JSON.stringify(
					failures.map((error) => ({ name: error.name, message: error.message })),
					null,
					2
				)
			);
			throw new AggregateError(failures, 'Fulltext qualification handles did not close cleanly');
		}
	}
	writeFileSync(join(configuration.output, 'result.json'), JSON.stringify({ ...result, cleanClose: true }, null, 2));
});
