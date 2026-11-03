require('../testUtils');
const assert = require('node:assert');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const {
	FullTextTelemetryCollector,
	resolveFullTextTelemetryPolicy,
	fullTextNativeCounterDelta,
	flattenFullTextTelemetry,
} = require('#src/resources/analytics/fullTextTelemetry');

const limits = {
	indexingThreads: 2,
	searchThreads: 2,
	writerMemoryBytes: 64 * 1024 * 1024,
	maxQueuedCommands: 16,
	maxQueuedBytes: 64 * 1024 * 1024,
	maxBatchBytes: 8 * 1024 * 1024,
};

describe('Published full-text telemetry collection', function () {
	this.timeout(30_000);
	let binding,
		root,
		sequence = 0,
		collector,
		handles;
	before(async function () {
		if (!(await supportsPublishedFullTextBinding())) this.skip();
		root = setupTestDBPath();
		binding = await loadFullTextNativeBinding();
	});
	beforeEach(() => {
		collector = new FullTextTelemetryCollector();
		handles = [];
	});
	afterEach(async () => {
		collector.stop();
		for (const handle of handles.reverse()) await handle.close({ mode: 'rollback' });
	});
	async function writer() {
		const options = {
			path: join(root, `telemetry-${++sequence}`),
			indexId: `telemetry-${sequence}`,
			generation: 'g1',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			positions: true,
			limits,
		};
		const index = await binding.openNativeFullTextIndex(options);
		handles.push(index);
		await index.applyMutationBatch({
			upserts: [{ id: 'catalog', version: '1', fields: { title: 'catalog widget' } }],
			deletes: [],
		});
		await index.publish('checkpoint');
		return { index, options };
	}
	async function reader(options) {
		const handle = await binding.openNativeFullTextReader(options);
		handles.push(handle);
		return handle;
	}
	function row(role = 'reader') {
		const rows = collector.takeRows();
		return rows.find((entry) => entry.method === role);
	}
	it('leaves collection unscheduled by default while real searches continue', async () => {
		const { index } = await writer();
		collector.register(index, 'catalog.Product/search', 'writer');
		collector.collect(index);
		assert.strictEqual(collector.collecting, false);
		assert.strictEqual(collector.scheduled, false);
		assert.deepStrictEqual(collector.takeRows(), []);
		assert.strictEqual((await index.search({ text: 'widget' })).hits.length, 1);
		assert.strictEqual(index.telemetry().native.histogramsEnabled, false);
	});
	it('enables, pauses and resumes the same reader with cumulative gap counts and independent options', async () => {
		const { options } = await writer();
		const handle = await reader(options);
		collector.register(handle, 'catalog.Product/search', 'reader');
		collector.setOperatorPolicy({ enabled: true, histograms: true });
		await handle.search({ text: 'widget' });
		collector.collect(handle);
		const first = row();
		assert.strictEqual(first.native_operations_search_completed, '1');
		assert.strictEqual(first.native_histogramsEnabled, true);
		assert.strictEqual(first.native_snapshotBytesEnabled, false);
		const histogramCount = handle.telemetry().native.operations.search.execution.histogram.count;
		collector.setOperatorPolicy({ enabled: false });
		assert.strictEqual(collector.scheduled, false);
		await handle.search({ text: 'widget' });
		assert.strictEqual(handle.telemetry().native.operations.search.execution.histogram.count, histogramCount);
		collector.collect(handle);
		assert.deepStrictEqual(collector.takeRows(), []);
		collector.setOperatorPolicy({ enabled: true, snapshotBytes: true });
		await handle.search({ text: 'widget' });
		collector.collect(handle);
		const resumed = row();
		assert.strictEqual(resumed.series, first.series);
		assert.strictEqual(resumed.native_operations_search_completed, '3');
		assert.strictEqual(resumed.native_histogramsEnabled, false);
		assert.strictEqual(resumed.native_snapshotBytesEnabled, true);
		assert.strictEqual(resumed.native_reader_snapshotBytesPending, true);
		assert.doesNotThrow(() => JSON.stringify(resumed));
	});
	it('unions removable consumer options without persisting consumer-only observations', async () => {
		const { index } = await writer();
		collector.register(index, 'catalog.Product/search', 'writer');
		const samples = [];
		const removeHistogram = collector.subscribe((sample) => samples.push(sample), {
			histograms: true,
			intervalMilliseconds: 1000,
		});
		const removeBytes = collector.subscribe(() => {}, { snapshotBytes: true });
		assert.strictEqual(index.telemetry().native.histogramsEnabled, true);
		assert.strictEqual(index.telemetry().native.snapshotBytesEnabled, true);
		collector.collect(index);
		assert.strictEqual(samples.length, 1);
		assert.deepStrictEqual(collector.takeRows(), []);
		removeHistogram();
		assert.strictEqual(index.telemetry().native.histogramsEnabled, false);
		assert.strictEqual(index.telemetry().native.snapshotBytesEnabled, true);
		removeBytes();
		assert.strictEqual(index.telemetry().native.snapshotBytesEnabled, false);
		assert.strictEqual(collector.scheduled, false);
	});
	it('stops scheduled callbacks on removal and contains a reentrant disable', async () => {
		const { index } = await writer();
		collector.register(index, 'catalog.Product/search', 'writer');
		let calls = 0;
		const remove = collector.subscribe(() => calls++, { intervalMilliseconds: 1000 });
		await waitFor(() => calls > 0, 5000);
		remove();
		const stopped = calls;
		await delay(1100);
		assert.strictEqual(calls, stopped);
		let removeSelf;
		removeSelf = collector.subscribe(() => removeSelf());
		collector.collect(index);
		assert.strictEqual(collector.collecting, false);
		assert.strictEqual(collector.scheduled, false);
	});
	it('preserves one logical series across concurrent reader churn and final close accounting', async () => {
		const { options } = await writer();
		const first = await reader(options);
		const second = await reader(options);
		collector.setOperatorPolicy({ enabled: true });
		collector.register(first, 'catalog.Product/search', 'reader');
		collector.register(second, 'catalog.Product/search', 'reader');
		await first.search({ text: 'widget' });
		await second.search({ text: 'widget' });
		collector.collect(first);
		collector.collect(second);
		const before = row();
		assert.strictEqual(before.activeHandles, 2);
		assert.strictEqual(before.native_operations_search_completed, '2');
		assert.strictEqual(before.native_reader_documents, '1');
		collector.beforeClose(first);
		collector.collect(first);
		await first.close();
		collector.afterClose(first);
		const final = row();
		assert.strictEqual(final.native_operations_close_completed, '1');
		assert.strictEqual(final.series, before.series);
		assert.strictEqual(final.native_operations_search_completed, '2');
		assert.strictEqual(final.activeHandles, 1);
		collector.register(first, 'catalog.Product/search', 'reader');
		await second.search({ text: 'widget' });
		collector.collect(second);
		assert.strictEqual(row().native_operations_search_completed, '3');
		const third = await reader(options);
		collector.register(third, 'catalog.Product/search', 'reader');
		await third.search({ text: 'widget' });
		collector.collect(third);
		const current = row();
		assert.strictEqual(current.series, before.series);
		assert.strictEqual(current.native_operations_search_completed, '4');
	});
	it('contains rejected asynchronous consumers with one callback in flight', async () => {
		const { index } = await writer();
		collector.register(index, 'catalog.Product/search', 'writer');
		let calls = 0;
		let reject;
		const remove = collector.subscribe(() => {
			calls++;
			return new Promise((_, fail) => {
				reject = fail;
			});
		});
		collector.collect(index);
		collector.collect(index);
		assert.strictEqual(calls, 1);
		reject(new Error('consumer failed'));
		await Promise.resolve();
		await Promise.resolve();
		collector.collect(index);
		assert.strictEqual(calls, 2);
		remove();
		reject(new Error('removed consumer failed'));
		await Promise.resolve();
	});
	it('contains a real closed-handle configuration failure without poisoning other handles', async () => {
		const { index } = await writer();
		await index.close();
		collector.register(index, 'catalog.Product/search', 'writer');
		const errors = [];
		const remove = collector.subscribe((sample) => errors.push(sample.error));
		assert.deepStrictEqual(errors, ['configuration-error']);
		const { index: live } = await writer();
		collector.register(live, 'catalog.Other/search', 'writer');
		assert.strictEqual((await live.search({ text: 'widget' })).hits.length, 1);
		collector.collect(live);
		assert.strictEqual(errors.at(-1), undefined);
		remove();
	});
	it('bounds pending rows and marks dropped observations explicitly', async () => {
		collector.stop();
		collector = new FullTextTelemetryCollector({ maxPendingRows: 2 });
		collector.setOperatorPolicy({ enabled: true });
		for (let i = 0; i < 3; i++) {
			const { index } = await writer();
			collector.register(index, `catalog.Product${i}/search`, 'writer');
			collector.collect(index);
		}
		const rows = collector.takeRows();
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows.at(-1).droppedRows, '1');
	});
	it('uses exact uint64 deltas above safe integer range and across wrap', () => {
		const previous = (1n << 63n) + 1n;
		assert.strictEqual(fullTextNativeCounterDelta(previous + 3n, previous), 3n);
		assert.strictEqual(fullTextNativeCounterDelta(2n, (1n << 64n) - 2n), 4n);
	});
	it('preserves exact snapshot scalars and unavailable native observations without inventing zeros', async () => {
		const { index } = await writer();
		const snapshot = index.telemetry();
		const huge = (1n << 63n) + 17n;
		snapshot.native.operations.search.completed = huge;
		snapshot.native.phases.commit.sumNanoseconds = huge;
		const encoded = flattenFullTextTelemetry(snapshot);
		assert.strictEqual(encoded.counters.get('native_operations_search_completed'), huge);
		assert.strictEqual(encoded.counters.get('native_phases_commit_sumNanoseconds'), huge);
		assert.strictEqual(encoded.gauges.native_reader_documents, '1');
		assert.strictEqual(encoded.gauges.native_reader_snapshotBytes, null);
		const { native: _native, ...facade } = snapshot;
		const unavailable = flattenFullTextTelemetry({ ...facade, available: false, reason: 'telemetry unavailable' });
		assert.strictEqual(unavailable.gauges.available, false);
		assert.strictEqual(unavailable.gauges.native_reader_documents, undefined);
		assert.strictEqual(unavailable.counters.get('logicalBatches_completed'), 1n);
	});
	it('validates optional configuration without adding an enabled default', () => {
		assert.strictEqual(resolveFullTextTelemetryPolicy(undefined).enabled, false);
		for (const value of [
			null,
			true,
			[],
			{ enabled: 'true' },
			{ intervalMilliseconds: 0 },
			{ intervalMilliseconds: 2147483648 },
			{ histograms: 1 },
			{ unexpected: true },
		])
			assert.throws(() => resolveFullTextTelemetryPolicy(value), TypeError);
	});
});

describe('Harper full-text analytics lifecycle and persistence', function () {
	this.timeout(45_000);
	it('collects existing writer/readers after live opt-in, persists exact rows, pauses and resumes without reopening', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		const fs = require('node:fs');
		const YAML = require('yaml');
		const analytics = require('#src/resources/analytics/write');
		const analyticsRead = require('#src/resources/analytics/read');
		const { table, databases } = require('#src/resources/databases');
		const { fullTextDerivedIndexReadiness } = require('#src/resources/derivedIndexes');
		const { setMainIsWorker } = require('#src/server/threads/manageThreads');
		const { getConfigFilePath } = require('#src/config/configUtils');
		const { fullTextTelemetryCollector: live } = require('#src/resources/analytics/fullTextTelemetryRuntime');
		setupTestDBPath();
		setMainIsWorker(true);
		const file = getConfigFilePath();
		const original = fs.readFileSync(file, 'utf8');
		const config = YAML.parse(original);
		const wasEnabled = analytics.checkAnalyticsEnabled();
		let Product;
		const label = `telemetry-live-${Date.now()}`;
		function change(enabled) {
			fs.writeFileSync(
				file,
				YAML.stringify({
					...config,
					analytics: { ...config.analytics, fullText: { enabled, intervalMilliseconds: 1000 } },
				})
			);
		}
		function rows() {
			const found = [];
			const raw = databases.system?.hdb_raw_analytics;
			if (raw)
				for (const { value } of raw.primaryStore.getRange({ start: false, end: Infinity }))
					for (const row of value?.metrics ?? [])
						if (row.metric === 'fulltext' && row.path.includes(label)) found.push(row);
			return found;
		}
		async function search() {
			const found = [];
			for await (const record of Product.search({
				conditions: [
					{
						attribute: 'catalogSearch',
						comparator: 'matches',
						value: 'widget',
						maxIndexLagMilliseconds: 0,
						waitForIndexMilliseconds: 5000,
					},
				],
			}))
				found.push(record.id);
			return found.sort();
		}
		try {
			analytics.setAnalyticsEnabled(true);
			Product = table({
				database: label,
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
			await Product.put('one', { title: 'catalog widget' });
			await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
			assert.deepStrictEqual(await search(), ['one']);
			assert.strictEqual(live.collecting, false);
			assert.strictEqual(live.scheduled, false);
			assert.deepStrictEqual(rows(), []);
			change(true);
			await waitFor(() => live.collecting, 5000);
			await waitFor(
				() => rows().some((row) => row.method === 'writer') && rows().some((row) => row.method === 'reader'),
				10000
			);
			const writer = rows().find((row) => row.method === 'writer');
			assert(BigInt(writer.logicalBatches_completed) >= 1n);
			assert.strictEqual(writer.native_histogramsEnabled, false);
			assert.strictEqual(writer.native_snapshotBytesEnabled, false);
			await waitFor(async () => {
				await analytics.runAggregationCycle(1000, 1);
				const found = [];
				for await (const row of await analyticsRead.getOp({
					metric: 'fulltext',
					conditions: [{ attribute: 'path', comparator: 'equals', value: writer.path }],
				}))
					found.push(row);
				return found.some(
					(row) => row.series === writer.series && row.logicalBatches_completed === writer.logicalBatches_completed
				);
			}, 10000);
			change(false);
			await waitFor(() => !live.collecting && !live.scheduled, 5000);
			const count = rows().length;
			await Product.put('two', { title: 'second widget' });
			assert.deepStrictEqual(await search(), ['one', 'two']);
			await delay(2200);
			assert.strictEqual(rows().length, count);
			change(true);
			await waitFor(() => live.collecting, 5000);
			await waitFor(
				() =>
					rows().some(
						(row) =>
							row.method === 'writer' &&
							row.series === writer.series &&
							BigInt(row.logicalBatches_completed) > BigInt(writer.logicalBatches_completed)
					),
				10000
			);
		} finally {
			fs.writeFileSync(file, original);
			await waitFor(() => !live.collecting, 5000);
			if (Product) {
				await Product.fullTextQueryIndexes.catalogSearch.customIndex.close();
				await Product.derivedIndexRuntime?.close();
			}
			analytics.setAnalyticsEnabled(wasEnabled);
		}
	});
});
