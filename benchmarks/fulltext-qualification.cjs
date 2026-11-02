const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { table } = require('#src/resources/databases');
const { setupTestDBPath } = require('../unitTests/testUtils');
const { fullTextDerivedIndexReadiness, setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { DEFAULT_FULL_TEXT_SEARCH_LIMITS } = require('#src/resources/indexes/fullTextSearchLimits');
const {
	getFullTextTestConfiguration,
	setFullTextTestConfiguration,
} = require('../unitTests/resources/fullTextTestConfiguration');
const { waitFor } = require('../unitTests/waitFor');
function summarize(samples) {
	const sorted = samples.slice().sort((a, b) => a - b);
	assert(sorted.length);
	return Object.fromEntries(
		[50, 95, 99, 100].map((p) => [`p${p}Milliseconds`, sorted[Math.ceil((sorted.length * p) / 100) - 1]])
	);
}
describe('isolated native full-text qualification cell', () => {
	it('completes the workload', async function () {
		assert.notStrictEqual(process.env.HARPER_STORAGE_ENGINE, 'lmdb');
		const width = Number(process.env.FULLTEXT_QUALIFICATION_WIDTH || 1);
		const concurrency = Number(process.env.FULLTEXT_QUALIFICATION_CONCURRENCY || 1);
		const writesPerSecond = Number(process.env.FULLTEXT_QUALIFICATION_WRITES || 0);
		const freshness = process.env.FULLTEXT_QUALIFICATION_FRESHNESS || 'strict';
		assert(['strict', 'bounded-lag'].includes(freshness));
		const queryFreshness =
			freshness === 'strict'
				? { maxIndexLagMilliseconds: 0, waitForIndexMilliseconds: 30000 }
				: { maxIndexLagMilliseconds: 5000 };
		const durationMilliseconds = Number(process.env.FULLTEXT_QUALIFICATION_DURATION_MS || 60000);
		assert([0, 1, 32].includes(width));
		assert([1, 4].includes(concurrency));
		assert([0, 10].includes(writesPerSecond));
		assert(Number.isFinite(durationMilliseconds) && durationMilliseconds >= 1000);
		const output = process.env.FULLTEXT_QUALIFICATION_CELL_REPORT;
		assert(output, 'An output path is required');
		setupTestDBPath();
		const previous = getFullTextTestConfiguration();
		setFullTextTestConfiguration(DEFAULT_FULL_TEXT_SEARCH_LIMITS);
		setMainIsWorker(true);
		let Product, sampleTimer;
		const loopDelay = monitorEventLoopDelay({ resolution: 10 });
		try {
			const binding = await loadFullTextNativeBinding();
			setFullTextNativeBindingForTests({ binding, closeTimeoutMilliseconds: 5000, shutdownTimeoutMilliseconds: 10000 });
			const rows = 9000;
			Product = table({
				database: `fulltext-qualification-${process.pid}`,
				table: 'Product',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					...Array.from({ length: 32 }, (_, i) => ({ name: `key${i}`, type: i === 31 ? 'Float' : 'String' })),
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
			for (let start = 0; start < rows; start += 250)
				await Product.put(
					Array.from({ length: Math.min(250, rows - start) }, (_, offset) => {
						const index = start + offset;
						return {
							id: String(index).padStart(5, '0'),
							title: 'widget',
							...Object.fromEntries(
								Array.from({ length: 32 }, (_, column) => [
									`key${column}`,
									column === 31 ? (index * 7919) % rows : 'shared',
								])
							),
						};
					})
				);
			await Product.put({ id: 'writer', title: 'unrelated publication', key31: -1 });
			await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
			let sort;
			for (const attribute of (width
				? [...Array.from({ length: width - 1 }, (_, i) => `key${i}`), 'key31']
				: []
			).reverse())
				sort = { attribute, descending: false, ...(sort ? { next: sort } : {}) };
			const target = {
				conditions: [
					{
						attribute: 'catalogSearch',
						comparator: 'matches',
						value: 'widget',
						...queryFreshness,
					},
				],
				...(sort ? { sort } : {}),
				limit: 20,
				select: ['id', 'key31'],
			};
			const query = async () => {
				const started = performance.now(),
					result = await Product.search(target),
					values = [];
				for await (const row of result) {
					assert(/^\d{5}$/.test(row.id) && Number(row.id) < rows);
					assert.strictEqual(row.key31, (Number(row.id) * 7919) % rows);
					values.push(row.key31);
				}
				assert.strictEqual(values.length, 20);
				assert.strictEqual(new Set(values).size, 20);
				if (width)
					assert.deepStrictEqual(
						values,
						Array.from({ length: 20 }, (_, i) => i)
					);
				return performance.now() - started;
			};
			if (freshness === 'bounded-lag') {
				const readinessRows = await Product.search({
					conditions: [{ ...target.conditions[0], maxIndexLagMilliseconds: 0, waitForIndexMilliseconds: 30000 }],
					limit: 1,
				});
				for await (const row of readinessRows) assert(row.id !== 'writer');
			}
			const firstQueryMilliseconds = await query();
			for (let i = 0; i < 3; i++) await query();
			const queryMilliseconds = [],
				writeMilliseconds = [],
				memory = [],
				errors = [];
			const started = performance.now(),
				deadline = started + durationMilliseconds,
				cpuStarted = process.cpuUsage(),
				utilizationStarted = performance.eventLoopUtilization();
			const sampledMemoryPeaks = {};
			const observeMemory = () => {
				const sample = { elapsedMilliseconds: performance.now() - started, ...process.memoryUsage() };
				for (const name of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'])
					sampledMemoryPeaks[name] = Math.max(sampledMemoryPeaks[name] || 0, sample[name]);
				return sample;
			};
			const sampleMemory = () => memory.push(observeMemory());
			sampleMemory();
			sampleTimer = setInterval(sampleMemory, 20);
			loopDelay.enable();
			const recordError = (kind, error) =>
				errors.push({ kind, name: error.name, code: error.code, statusCode: error.statusCode, message: error.message });
			const loops = Array.from({ length: concurrency }, async () => {
				while (performance.now() < deadline && !errors.length)
					try {
						queryMilliseconds.push(await query());
						observeMemory();
					} catch (error) {
						recordError('query', error);
					}
			});
			if (writesPerSecond)
				loops.push(
					(async () => {
						let sequence = 0;
						while (performance.now() < deadline && !errors.length) {
							const due = started + (sequence * 1000) / writesPerSecond;
							if (due > performance.now()) await new Promise((resolve) => setTimeout(resolve, due - performance.now()));
							if (performance.now() >= deadline) break;
							const writeStarted = performance.now();
							try {
								await Product.put({ id: 'writer', title: `unrelated publication ${sequence}`, key31: sequence });
								writeMilliseconds.push(performance.now() - writeStarted);
							} catch (error) {
								recordError('write', error);
							}
							sequence++;
						}
					})()
				);
			await Promise.all(loops);
			clearInterval(sampleTimer);
			sampleMemory();
			loopDelay.disable();
			const elapsedMilliseconds = performance.now() - started;
			const cpuMicroseconds = process.cpuUsage(cpuStarted);
			const eventLoopUtilization = performance.eventLoopUtilization(utilizationStarted);
			assert.deepStrictEqual(errors, [], JSON.stringify(errors));
			const report = {
				scope:
					'Fresh process/reader; setup warms OS caches. Not OS-cold, HTTP/multiworker or catalog-scale release qualification. Lifetime maxRSS includes setup; sampling may miss synchronous peaks.',
				node: process.version,
				platform: process.platform,
				architecture: process.arch,
				cpu: os.cpus()[0].model,
				memoryBytes: os.totalmem(),
				package: require('../package.json').optionalDependencies['@harperfast/fulltext'],
				runtime: await binding.runtimeInfo(),
				policy: DEFAULT_FULL_TEXT_SEARCH_LIMITS,
				rows,
				seed: 7919,
				clauses: width,
				concurrency,
				writesPerSecond,
				durationMilliseconds,
				measurementWindowMilliseconds: durationMilliseconds,
				drainMilliseconds: Math.max(0, elapsedMilliseconds - durationMilliseconds),
				freshness,
				queryFreshness,
				elapsedMilliseconds,
				firstQueryMilliseconds,
				query: {
					samples: queryMilliseconds,
					...summarize(queryMilliseconds),
					operationsPerSecond: (queryMilliseconds.length / elapsedMilliseconds) * 1000,
				},
				writes: {
					samples: writeMilliseconds,
					...(writeMilliseconds.length ? summarize(writeMilliseconds) : {}),
					operationsPerSecond: (writeMilliseconds.length / elapsedMilliseconds) * 1000,
				},
				cpuMicroseconds,
				eventLoopUtilization,
				eventLoopDelayMilliseconds: {
					p50: loopDelay.percentile(50) / 1e6,
					p95: loopDelay.percentile(95) / 1e6,
					p99: loopDelay.percentile(99) / 1e6,
					max: loopDelay.max / 1e6,
				},
				memory,
				memorySampleMode: '20ms time series plus rolling query-boundary peaks; no per-query sample retention',
				sampledMemoryPeaks,
				lifetimeMaxRssBytesIncludingSetup: process.resourceUsage().maxRSS * 1024,
				errors,
			};
			const runtime = Product.derivedIndexRuntime;
			Product.derivedIndexRuntime = undefined;
			await runtime.close();
			fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
		} finally {
			clearInterval(sampleTimer);
			loopDelay.disable();
			const runtime = Product?.derivedIndexRuntime;
			if (Product) Product.derivedIndexRuntime = undefined;
			try {
				if (runtime) await runtime.close();
			} finally {
				setFullTextNativeBindingForTests(undefined);
				setFullTextTestConfiguration(previous);
			}
		}
	});
});
