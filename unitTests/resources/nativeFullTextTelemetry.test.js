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
	fullTextTelemetryIndexLabel,
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
		handles = [];
		collector = new FullTextTelemetryCollector();
	});
	afterEach(async () => {
		collector?.stop();
		for (const handle of handles?.reverse() ?? []) await handle.close({ mode: 'rollback' });
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
	it('keeps delimiter-bearing index identities in separate series', async () => {
		const labels = [
			fullTextTelemetryIndexLabel('a.b', 'c', 'search'),
			fullTextTelemetryIndexLabel('a', 'b.c', 'search'),
			fullTextTelemetryIndexLabel('a%2Eb', 'c', 'search'),
			fullTextTelemetryIndexLabel('a', 'b/c', 'search'),
		];
		assert.strictEqual(new Set(labels).size, labels.length);
		assert.strictEqual(fullTextTelemetryIndexLabel('catalog', 'Product', 'search'), 'catalog.Product/search');
		assert.strictEqual(fullTextTelemetryIndexLabel('catalog', 'Product', '😀'), 'catalog.Product/%F0%9F%98%80');
		const illFormed = ['\ud800', '\ud801', '\ufffd'].map((index) => fullTextTelemetryIndexLabel('a', 'b', index));
		assert.strictEqual(new Set(illFormed).size, illFormed.length);
		assert.match(illFormed[0], /^index:[a-f0-9]{64}$/);
		const { options } = await writer();
		collector.setOperatorPolicy({ enabled: true });
		for (const label of labels) {
			const handle = await reader(options);
			collector.register(handle, label, 'reader');
			await handle.search({ text: 'widget' });
			collector.collect(handle);
		}
		const rows = collector.takeRows();
		assert.strictEqual(new Set(rows.map((row) => row.series)).size, labels.length);
		assert.deepStrictEqual(
			rows.map((row) => row.path),
			labels
		);
		assert.ok(rows.every((row) => row.native_operations_search_completed === '1'));
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
		collector.setOperatorPolicy({ enabled: true, histograms: true });
		await handle.search({ text: 'widget' });
		collector.collect(handle);
		const recordingAgain = row();
		assert.strictEqual(recordingAgain.series, first.series);
		assert.strictEqual(recordingAgain.native_operations_search_completed, '4');
		assert.strictEqual(
			recordingAgain.native_operations_search_execution_histogram_count,
			(histogramCount + 1n).toString()
		);
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
		collector.setOperatorPolicy({ enabled: true });
		collector.collect(index);
		const combined = row('writer');
		assert.strictEqual(combined.native_histogramsEnabled, true);
		assert.strictEqual(combined.native_snapshotBytesEnabled, true);
		collector.setOperatorPolicy({ enabled: false });
		assert.strictEqual(collector.collecting, true);
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
		assert.deepStrictEqual(
			collector.takeRows(),
			[],
			'pausing a retiring peer must not publish a false unavailable row'
		);
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
	it('starts a usable new series after reader retirement lost terminal coverage while collection was off', async () => {
		const { options } = await writer();
		const first = await reader(options);
		const second = await reader(options);
		collector.register(first, 'catalog.Product/search', 'reader');
		collector.register(second, 'catalog.Product/search', 'reader');
		collector.setOperatorPolicy({ enabled: true });
		await first.search({ text: 'widget' });
		await second.search({ text: 'widget' });
		collector.collect(first);
		collector.collect(second);
		const before = row();
		collector.setOperatorPolicy({ enabled: false });
		collector.beforeClose(first);
		await first.close();
		collector.afterClose(first);
		collector.setOperatorPolicy({ enabled: true });
		collector.collect(second);
		const resumed = row();
		assert.strictEqual(resumed.complete, true);
		assert.notStrictEqual(resumed.series, before.series);
		await second.search({ text: 'widget' });
		collector.collect(second);
		const next = row();
		assert.strictEqual(next.series, resumed.series);
		assert.strictEqual(
			BigInt(next.native_operations_search_completed) - BigInt(resumed.native_operations_search_completed),
			1n
		);
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
	it('releases the consumer slot after a promise-like callback without catch or finally methods', async () => {
		const { index } = await writer();
		collector.register(index, 'catalog.Product/search', 'writer');
		let calls = 0;
		const remove = collector.subscribe(() => {
			calls++;
			return { then: (resolve) => queueMicrotask(resolve) };
		});
		try {
			collector.collect(index);
			await waitFor(() => {
				collector.collect(index);
				return calls === 2;
			});
		} finally {
			remove();
		}
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
		collector.collect(handles[0]);
		const recovered = collector.takeRows().find((value) => value.path === 'catalog.Product0/search');
		assert.strictEqual(recovered.complete, true, 'dropping a pending observation does not lose cumulative counters');
	});
	it('evicts the least recently refreshed pending group', async () => {
		collector.stop();
		collector = new FullTextTelemetryCollector({ maxPendingRows: 2 });
		collector.setOperatorPolicy({ enabled: true });
		const writers = [];
		for (let i = 0; i < 3; i++) {
			const { index } = await writer();
			writers.push(index);
			collector.register(index, `catalog.Recency${i}/search`, 'writer');
		}
		collector.collect(writers[0]);
		collector.collect(writers[1]);
		collector.collect(writers[0]);
		collector.collect(writers[2]);
		const rows = collector.takeRows();
		assert.deepStrictEqual(
			rows.map((entry) => entry.path),
			['catalog.Recency0/search', 'catalog.Recency2/search']
		);
		assert.strictEqual(rows.at(-1).droppedRows, '1');
	});
	it('preserves a pending final row before evicting a replaceable live row', async () => {
		collector.stop();
		collector = new FullTextTelemetryCollector({ maxPendingRows: 2 });
		collector.setOperatorPolicy({ enabled: true });
		const writers = [];
		for (let i = 0; i < 3; i++) {
			const { index } = await writer();
			writers.push(index);
			collector.register(index, `catalog.Final${i}/search`, 'writer');
		}
		collector.beforeClose(writers[0]);
		await writers[0].close({ mode: 'rollback' });
		collector.afterClose(writers[0]);
		collector.collect(writers[1]);
		collector.collect(writers[2]);
		const rows = collector.takeRows();
		assert.deepStrictEqual(
			rows.map((entry) => entry.path),
			['catalog.Final0/search', 'catalog.Final2/search']
		);
		assert.strictEqual(rows[0].native_state, 'closed');
		assert.strictEqual(rows.at(-1).droppedRows, '1');
	});
	it('samples all open handles at final flush without overflowing the pending-row budget', async () => {
		collector.stop();
		collector = new FullTextTelemetryCollector({ maxPendingRows: 2 });
		collector.setOperatorPolicy({ enabled: true });
		for (let i = 0; i < 3; i++) {
			const { index } = await writer();
			collector.register(index, `catalog.Open${i}/search`, 'writer');
			await index.search({ text: 'widget' });
		}
		const rows = collector.collectFinalRows();
		assert.deepStrictEqual(
			rows.map((entry) => entry.path),
			['catalog.Open0/search', 'catalog.Open1/search', 'catalog.Open2/search']
		);
		for (const entry of rows) {
			assert.strictEqual(entry.native_operations_search_completed, '1');
			assert.strictEqual(entry.droppedRows, '0');
		}
		assert.strictEqual(collector.hasPendingRows, false);
	});
	it('accumulates exact uint64 deltas above safe integer range and across wrap', async () => {
		const { index } = await writer();
		const snapshot = index.telemetry();
		const handle = { telemetry: () => snapshot, configureTelemetry() {} };
		collector.setOperatorPolicy({ enabled: true });
		collector.register(handle, 'catalog.Counter/search', 'writer');
		const previous = (1n << 63n) + 1n;
		snapshot.native.operations.search.completed = previous;
		collector.collect(handle);
		assert.strictEqual(row('writer').native_operations_search_completed, previous.toString());
		snapshot.native.operations.search.completed += 3n;
		collector.collect(handle);
		assert.strictEqual(row('writer').native_operations_search_completed, (previous + 3n).toString());
		snapshot.native.operations.search.completed = (1n << 64n) - 2n;
		collector.collect(handle);
		assert.strictEqual(row('writer').native_operations_search_completed, ((1n << 64n) - 2n).toString());
		snapshot.native.operations.search.completed = 2n;
		collector.collect(handle);
		assert.strictEqual(row('writer').native_operations_search_completed, ((1n << 64n) + 2n).toString());
	});
	it('preserves exact snapshot scalars and unavailable native observations without inventing zeros', async () => {
		const { index } = await writer();
		let snapshot = index.telemetry();
		const huge = (1n << 63n) + 17n;
		snapshot.native.operations.search.completed = huge;
		snapshot.native.phases.commit.sumNanoseconds = huge;
		const handle = { telemetry: () => snapshot, configureTelemetry() {} };
		collector.setOperatorPolicy({ enabled: true });
		collector.register(handle, 'catalog.Scalars/search', 'writer');
		collector.collect(handle);
		const encoded = row('writer');
		assert.strictEqual(encoded.native_operations_search_completed, huge.toString());
		assert.strictEqual(encoded.native_phases_commit_sumNanoseconds, huge.toString());
		assert.strictEqual(encoded.native_reader_documents, '1');
		assert.strictEqual(encoded.native_reader_snapshotBytes, null);
		const { native: _native, ...facade } = snapshot;
		snapshot = { ...facade, available: false, reason: 'telemetry unavailable' };
		collector.collect(handle);
		const unavailable = row('writer');
		assert.strictEqual(unavailable.available, false);
		assert.strictEqual(unavailable.native_reader_documents, undefined);
		assert.strictEqual(unavailable.logicalBatches_completed, '1');
	});
	it('preserves peer gauge sums, null ages, newest-key selection and closing exclusions', async () => {
		const { index } = await writer();
		const snapshots = [index.telemetry(), index.telemetry()];
		for (let i = 0; i < snapshots.length; i++) {
			const native = snapshots[i].native;
			native.operations.search.dispatched = BigInt(i + 2);
			native.queues.ordinarySearch.commands = BigInt(i + 3);
			native.queues.ordinarySearch.bytes = BigInt(i + 4);
			native.queues.ordinarySearch.oldestAgeNanoseconds = i === 0 ? 7_000_000n : null;
			native.reader.documents = BigInt(i + 1);
		}
		const peers = snapshots.map((snapshot) => ({ telemetry: () => snapshot, configureTelemetry() {} }));
		collector.setOperatorPolicy({ enabled: true });
		for (const peer of peers) {
			collector.register(peer, 'catalog.Product/search', 'reader');
			collector.collect(peer);
		}
		const combined = row();
		assert.strictEqual(combined.native_operations_search_dispatched, '5');
		assert.strictEqual(combined.native_queues_ordinarySearch_commands, '7');
		assert.strictEqual(combined.native_queues_ordinarySearch_bytes, '9');
		assert.strictEqual(combined.native_queues_ordinarySearch_oldestAgeNanoseconds, '7000000');
		assert.strictEqual(combined.native_reader_documents, '2');
		snapshots[1].native.queues.ordinarySearch.oldestAgeNanoseconds = 9_000_000n;
		collector.collect(peers[1]);
		assert.strictEqual(row().native_queues_ordinarySearch_oldestAgeNanoseconds, '9000000');
		delete snapshots[1].native.queues.ordinarySearch.bytes;
		collector.collect(peers[1]);
		assert.strictEqual(Object.hasOwn(row(), 'native_queues_ordinarySearch_bytes'), false);
		snapshots[1].native.queues.ordinarySearch.bytes = null;
		collector.collect(peers[1]);
		assert.strictEqual(row().native_queues_ordinarySearch_bytes, '4');
		snapshots[0].native.queues.ordinarySearch.bytes = -1n;
		collector.collect(peers[0]);
		collector.collect(peers[1]);
		assert.strictEqual(row().native_queues_ordinarySearch_bytes, null);
		collector.beforeClose(peers[0]);
		snapshots[1].native.queues.ordinarySearch.oldestAgeNanoseconds = null;
		collector.collect(peers[1]);
		const retiring = row();
		assert.strictEqual(retiring.native_operations_search_dispatched, '3');
		assert.strictEqual(retiring.native_queues_ordinarySearch_commands, '4');
		assert.strictEqual(retiring.native_queues_ordinarySearch_oldestAgeNanoseconds, null);
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
		const { setMainIsWorker, getWorkerIndex } = require('#src/server/threads/manageThreads');
		const { server } = require('#src/server/Server');
		const { getConfigFilePath } = require('#src/config/configUtils');
		const { fullTextTelemetryCollector: live } = require('#src/resources/analytics/fullTextTelemetryRuntime');
		setupTestDBPath();
		const file = getConfigFilePath();
		const original = fs.readFileSync(file, 'utf8');
		const config = YAML.parse(original);
		const wasEnabled = analytics.checkAnalyticsEnabled();
		const wasMainWorker = getWorkerIndex() !== undefined;
		const originalGlobals = ['databases', 'server'].map((name) => [
			name,
			Object.getOwnPropertyDescriptor(global, name),
		]);
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
			setMainIsWorker(true);
			global.databases = databases;
			global.server = server;
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
			await waitFor(() => live.collecting, 5000).catch((error) => {
				const watcher = require('#src/config/RootConfigWatcher').getSharedRootConfigWatcher();
				error.message += `; activation state ${JSON.stringify({
					file: YAML.parse(fs.readFileSync(file, 'utf8')).analytics?.fullText,
					watched: watcher.config?.analytics?.fullText,
					analyticsEnabled: analytics.checkAnalyticsEnabled(false),
					armed: watcher._armedForTests,
					polling: watcher._usingPollingForTests,
					reads: watcher._readCountForTests,
					listeners: watcher.listenerCount('change'),
				})}`;
				throw error;
			});
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
			const { subscribeFullTextTelemetry } = require('#src/resources/analytics/fullTextTelemetryRuntime');
			let closing = false;
			let closed;
			const removeReaderConsumer = subscribeFullTextTelemetry((sample) => {
				if (sample.index !== writer.path || sample.role !== 'reader') return;
				if (sample.stage === 'closing') closing = true;
				if (sample.snapshot?.available && sample.snapshot.native.state === 'closed') closed = sample.snapshot;
			});
			try {
				await Product.fullTextQueryIndexes.catalogSearch.customIndex.close();
				assert.strictEqual(closing, true);
				assert.strictEqual(closed?.native.operations.close.completed, 1n);
			} finally {
				removeReaderConsumer();
			}
		} finally {
			try {
				fs.writeFileSync(file, original);
				await waitFor(() => !live.collecting, 5000);
			} finally {
				try {
					if (Product) {
						await Product.fullTextQueryIndexes.catalogSearch.customIndex.close();
						await Product.derivedIndexRuntime?.close();
					}
				} finally {
					analytics.setAnalyticsEnabled(wasEnabled);
					setMainIsWorker(wasMainWorker);
					for (const [name, descriptor] of originalGlobals) {
						if (descriptor) Object.defineProperty(global, name, descriptor);
						else delete global[name];
					}
				}
			}
		}
	});
});
