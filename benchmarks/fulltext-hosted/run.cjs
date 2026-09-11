const assert = require('node:assert');
const { access, mkdtemp, rm } = require('node:fs/promises');
const { availableParallelism, tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');
const { setImmediate: nextTurn, setTimeout: delay } = require('node:timers/promises');
const harperPackage = require('../../package.json');

let evaluateGates;
let parsePositiveIntegerList;
let summarizeLatencies;
let closeDatabase;
let table;
let RocksDerivedIndexStorage;

(async () => {
	({ evaluateGates, parsePositiveIntegerList, summarizeLatencies } = await import('./metrics.mts'));
	const options = parseOptions();
	await verifyFulltextRoot(options.fulltextRoot);
	require('../../unitTests/testUtils');
	const { setupTestDBPath } = require('../../unitTests/testUtils');
	({ closeDatabase, table } = require('#src/resources/databases'));
	({ RocksDerivedIndexStorage } = require('#src/resources/RocksDerivedIndexStorage'));
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	const fulltextHarper = await import(pathToFileURL(join(options.fulltextRoot, 'dist', 'harper.js')).href);
	const fulltextNative = await import(pathToFileURL(join(options.fulltextRoot, 'dist', 'native.js')).href);
	const runtime = await fulltextNative.runtimeInfo();
	assert(runtime.storageBackends.includes('harper'));
	let nextStoreIdentity = 0n;

	setupTestDBPath();
	setMainIsWorker(true);

	const results = [];
	let failed = false;
	for (const tableCount of options.tableCounts) {
		for (const publicationMilliseconds of options.publicationMilliseconds) {
			let baselineForegroundP99;
			for (const arm of options.arms) {
				const result = await runArm(arm, tableCount, publicationMilliseconds);
				if (arm === 'no-index') baselineForegroundP99 = result.foreground.p99Milliseconds;
				if (baselineForegroundP99 === undefined) {
					throw new Error('the no-index arm must run before indexed arms');
				}
				result.gates = evaluateGates({
					searchP99Milliseconds: result.search?.duringIndexing.p99Milliseconds,
					eventLoopP99Milliseconds: result.eventLoop.p99Milliseconds,
					foregroundP99Milliseconds: result.foreground.p99Milliseconds,
					baselineForegroundP99Milliseconds: baselineForegroundP99,
					maxSyncMilliseconds: result.storage?.sync.maxMilliseconds ?? 0,
				});
				failed ||= !result.gates.passed;
				results.push(result);
				console.error(
					`${arm} tables=${tableCount} publish_ms=${publicationMilliseconds} ` +
						`foreground_p99=${result.foreground.p99Milliseconds.toFixed(2)} ` +
						`search_p99=${result.search?.duringIndexing.p99Milliseconds.toFixed(2) ?? 'n/a'} ` +
						`gate=${result.gates.passed ? 'pass' : 'fail'}`
				);
			}
		}
	}

	const output = {
		formatVersion: 1,
		benchmark: 'harper-fulltext-hosted',
		runtime,
		revisions: {
			harper: options.revision,
			fulltext: options.fulltextRevision,
			harperPackageVersion: harperPackage.version,
		},
		host: {
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			cpus: availableParallelism(),
		},
		options,
		results,
	};
	console.log(`FULLTEXT_HOSTED_RESULT ${JSON.stringify(output, bigintReplacer)}`);
	if (failed) process.exitCode = 1;

	async function runArm(arm, tableCount, publicationMilliseconds) {
		const database = `fulltext-bench-${process.pid}-${tableCount}-${publicationMilliseconds}-${arm}`;
		const tables = Array.from({ length: tableCount }, (_, index) =>
			table({
				database,
				table: `Noise${index}`,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
			})
		);
		const rootStore = tables[0].primaryStore.rootStore;
		const statsBefore = rocksStats(rootStore);
		let committedEvents = 0;
		const onCommitted = () => committedEvents++;
		rootStore.on('committed', onCommitted);
		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		const foregroundLatencies = [];
		const searchLatencies = [];
		const control = { stop: false, searchReady: false };
		let indexContext;
		const started = performance.now();
		try {
			indexContext = await openIndex(arm, rootStore, database, () => committedEvents);
			await warmForeground(tables[0]);
			eventLoop.enable();
			const workloadStarted = performance.now();
			const foreground = driveForeground(tables[0], control, workloadStarted, foregroundLatencies);
			const searches = driveSearch(indexContext?.index, control, searchLatencies);
			const indexing = await indexDocuments(indexContext, publicationMilliseconds, control);
			await searches;
			const remaining = options.minimumDurationMs - (performance.now() - workloadStarted);
			if (remaining > 0) await delay(remaining);
			control.stop = true;
			const foregroundCount = await foreground;
			const soakRead = await measureSoakReads(tables[0], foregroundCount);
			const reopen = await closeAndReopen(indexContext);
			const statsAfter = rocksStats(rootStore);
			const elapsedMilliseconds = performance.now() - started;
			const eventLoopSummary = {
				p50Milliseconds: eventLoop.percentile(50) / 1e6,
				p95Milliseconds: eventLoop.percentile(95) / 1e6,
				p99Milliseconds: eventLoop.percentile(99) / 1e6,
				maxMilliseconds: eventLoop.max / 1e6,
			};
			return {
				arm,
				tableCount,
				publicationMilliseconds,
				elapsedMilliseconds,
				indexing,
				foreground: summarizeLatencies(foregroundLatencies),
				soakRead,
				search: indexContext
					? {
							duringIndexing: summarizeLatencies(searchLatencies),
							reopen,
						}
					: undefined,
				eventLoop: eventLoopSummary,
				storage: indexContext?.storageMeasurements
					? storageSummary(indexContext.storageMeasurements, indexing.publications)
					: undefined,
				committedEvents,
				rocks: { before: statsBefore, after: statsAfter },
				gates: undefined,
			};
		} finally {
			control.stop = true;
			eventLoop.disable();
			rootStore.off('committed', onCommitted);
			await indexContext?.close().catch(() => undefined);
			closeDatabase(database);
		}
	}

	async function openIndex(arm, rootStore, database, committedEvents) {
		if (arm === 'no-index') return undefined;
		const common = {
			indexId: 'products-benchmark',
			generation: 'benchmark-generation-1',
			fields: [{ name: 'title', weight: 3 }, { name: 'description' }, { name: 'category', weight: 1.5 }],
			analyzer: 'english@1',
			positions: true,
			surfaceTerms: false,
			limits: {
				indexingThreads: 2,
				searchThreads: 2,
				writerMemoryBytes: 60_000_000,
				maxQueuedCommands: 128,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 16 * 1024 * 1024,
			},
		};
		if (arm === 'native') {
			const path = await mkdtemp(join(tmpdir(), 'harper-fulltext-native-control-'));
			const index = await fulltextNative.openNativeFullTextIndex({ ...common, path });
			return {
				arm,
				index,
				config: { ...common, path },
				storageMeasurements: undefined,
				disposed: false,
				async close() {
					if (this.disposed) return;
					await this.index.close({ mode: 'rollback' });
					await rm(path, { recursive: true, force: true });
					this.disposed = true;
				},
			};
		}
		const storeName = `${database}-products`;
		const rawStorage = new RocksDerivedIndexStorage(rootStore, storeName);
		const measurements = emptyStorageMeasurements();
		const storage = measuredStorage(rawStorage, arm, measurements, committedEvents);
		const config = {
			...common,
			storage,
			storeIdentity: [BigInt(process.pid), BigInt(Date.now()), ++nextStoreIdentity],
			namespace: Buffer.from('products-benchmark'),
			transport: {
				maxOperations: 64,
				maxBytes: 80 * 1024 * 1024,
				readTimeoutMs: 5_000,
				maxMutations: 4_096,
				maxReadResponseBytes: 1024 * 1024,
				maxControlResponseBytes: 1024 * 1024,
				maxErrorBytes: 64 * 1024,
			},
		};
		const index = await fulltextHarper.openHarperFullTextIndex(config);
		return {
			arm,
			index,
			config,
			rootStore,
			storeName,
			committedEvents,
			rawStorage,
			storageMeasurements: measurements,
			disposed: false,
			async close() {
				if (this.disposed) return;
				await this.index.close({ mode: 'rollback' });
				this.rawStorage.close();
				this.disposed = true;
			},
		};
	}

	async function indexDocuments(context, publicationMilliseconds, control) {
		let packedBytes = 0;
		let applyMilliseconds = 0;
		let publishMilliseconds = 0;
		let publications = 0;
		let sincePublication = performance.now();
		for (let start = 0; start < options.documents; start += options.batchSize) {
			const end = Math.min(options.documents, start + options.batchSize);
			const packed = fulltextNative.encodeMutationBatch({
				upserts: Array.from({ length: end - start }, (_, offset) => product(start + offset)),
			});
			packedBytes += packed.byteLength;
			if (context) {
				const applyStarted = performance.now();
				assert.strictEqual(await context.index.apply(packed), end - start);
				applyMilliseconds += performance.now() - applyStarted;
				if (end === options.documents || performance.now() - sincePublication >= publicationMilliseconds) {
					const publishStarted = performance.now();
					if (context.arm === 'native') {
						await context.index.commit();
						await context.index.reload();
					} else {
						context.lastPayload = JSON.stringify({ format: 1, logs: { benchmark: end } });
						await context.index.publish(context.lastPayload);
					}
					publishMilliseconds += performance.now() - publishStarted;
					publications++;
					sincePublication = performance.now();
					control.searchReady = true;
				}
			}
			await nextTurn();
		}
		return {
			documents: options.documents,
			batchSize: options.batchSize,
			packedBytes,
			applyMilliseconds,
			publishMilliseconds,
			publications,
			documentsPerSecond: (options.documents * 1_000) / Math.max(1, applyMilliseconds + publishMilliseconds),
		};
	}

	async function driveForeground(Table, control, started, latencies) {
		const interval = 1_000 / options.foregroundRate;
		let next = started;
		let sequence = 0;
		const pending = new Set();
		while (!control.stop) {
			const wait = next - performance.now();
			if (wait > 0) await delay(wait);
			const scheduled = next;
			next += interval;
			const id = sequence++;
			const request = Promise.resolve()
				.then(() => Table.put(`noise-${id}`, { value: `foreground-${id}` }))
				.then(() => {
					latencies.push(performance.now() - scheduled);
				});
			pending.add(request);
			request.then(
				() => pending.delete(request),
				() => pending.delete(request)
			);
			if (pending.size >= 256) await Promise.race(pending);
		}
		await Promise.all(pending);
		return sequence;
	}

	async function warmForeground(Table) {
		for (let sequence = 0; sequence < 32; sequence++) {
			await Table.put(`warm-${sequence}`, { value: `warm-${sequence}` });
		}
	}

	async function measureSoakReads(Table, foregroundCount) {
		const latencies = [];
		for (let sequence = 0; sequence < options.soakReads; sequence++) {
			const id = sequence % foregroundCount;
			const started = performance.now();
			assert(await Table.get(`noise-${id}`));
			latencies.push(performance.now() - started);
		}
		return summarizeLatencies(latencies);
	}

	async function driveSearch(index, control, latencies) {
		if (!index) return;
		const queries = ['waterproof trail shoes', 'wireless headphones', 'cotton blue shirt', 'outdoor product'];
		let sequence = 0;
		while (!control.stop && sequence < options.queryCount) {
			if (!control.searchReady) {
				await nextTurn();
				continue;
			}
			const started = performance.now();
			const result = await index.search({ text: queries[sequence % queries.length], limit: 10 });
			assert(result.hits.length > 0);
			latencies.push(performance.now() - started);
			sequence++;
		}
	}

	async function closeAndReopen(context) {
		if (!context) return undefined;
		const expected = await context.index.search({ text: 'waterproof trail shoes', limit: 10, exactTotal: true });
		assert(expected.hits.length > 0);
		await context.index.close();
		let reopened;
		let reopenedStorage;
		const started = performance.now();
		if (context.arm === 'native') {
			reopened = await fulltextNative.openNativeFullTextIndex(context.config);
		} else {
			context.rawStorage.close();
			reopenedStorage = new RocksDerivedIndexStorage(context.rootStore, context.storeName);
			const storage = measuredStorage(
				reopenedStorage,
				context.arm,
				context.storageMeasurements,
				context.committedEvents
			);
			reopened = await fulltextHarper.openHarperFullTextIndex({
				...context.config,
				storage,
				storeIdentity: [BigInt(process.pid), BigInt(Date.now()), ++nextStoreIdentity],
			});
			assert.strictEqual(reopened.committedPayload, context.lastPayload);
		}
		const reopenMilliseconds = performance.now() - started;
		const searchStarted = performance.now();
		const result = await reopened.search({ text: 'waterproof trail shoes', limit: 10, exactTotal: true });
		const searchMilliseconds = performance.now() - searchStarted;
		assert.deepStrictEqual(
			result.hits.map((hit) => hit.id),
			expected.hits.map((hit) => hit.id)
		);
		await reopened.close();
		reopenedStorage?.close();
		if (context.arm === 'native') await rm(context.config.path, { recursive: true, force: true });
		context.disposed = true;
		return { reopenMilliseconds, searchMilliseconds, total: result.total };
	}

	function measuredStorage(rawStorage, arm, measurements, committedEvents) {
		return {
			read(key) {
				const started = performance.now();
				const value = rawStorage.read(key);
				measurements.readLatencies.push(performance.now() - started);
				measurements.reads++;
				measurements.readBytes += value?.byteLength ?? 0;
				return value;
			},
			write(mutations, policy) {
				const eventsBefore = committedEvents();
				const started = performance.now();
				rawStorage.write(mutations, policy);
				measurements.writeLatencies.push(performance.now() - started);
				measurements.writes++;
				measurements.writeMutations += mutations.length;
				for (const mutation of mutations) {
					measurements.writeBytes += mutation.key.byteLength + (mutation.value?.byteLength ?? 0);
					measurements.maxValueBytes = Math.max(measurements.maxValueBytes, mutation.value?.byteLength ?? 0);
				}
				measurements.synchronousCommittedEvents += committedEvents() - eventsBefore;
			},
			sync() {
				measurements.syncs++;
				const started = performance.now();
				if (arm === 'root-flush') rawStorage.sync();
				measurements.syncLatencies.push(performance.now() - started);
			},
		};
	}

	function storageSummary(measurements, publications) {
		return {
			reads: measurements.reads,
			readBytes: measurements.readBytes,
			read: summarizeLatencies(measurements.readLatencies),
			writes: measurements.writes,
			writeMutations: measurements.writeMutations,
			writeBytes: measurements.writeBytes,
			maxValueBytes: measurements.maxValueBytes,
			write: summarizeLatencies(measurements.writeLatencies),
			syncs: measurements.syncs,
			syncsPerPublication: publications === 0 ? 0 : measurements.syncs / publications,
			sync: summarizeLatencies(measurements.syncLatencies),
			synchronousCommittedEvents: measurements.synchronousCommittedEvents,
		};
	}

	function emptyStorageMeasurements() {
		return {
			reads: 0,
			readBytes: 0,
			readLatencies: [],
			writes: 0,
			writeMutations: 0,
			writeBytes: 0,
			maxValueBytes: 0,
			writeLatencies: [],
			syncs: 0,
			syncLatencies: [],
			synchronousCommittedEvents: 0,
		};
	}

	function rocksStats(rootStore) {
		const names = [
			'rocksdb.num-files-at-level0',
			'rocksdb.estimate-pending-compaction-bytes',
			'rocksdb.live-sst-files-size',
			'rocksdb.total-sst-files-size',
			'rocksdb.stall.micros',
			'rocksdb.compact.read.bytes',
			'rocksdb.compact.write.bytes',
		];
		return Object.fromEntries(
			names.map((name) => [name, rootStore.getStat(name) ?? rootStore.getDBIntProperty(name) ?? 0])
		);
	}

	function product(id) {
		const variants = [
			['Waterproof Trail Running Shoes', 'Lightweight outdoor footwear with durable grip', 'shoes'],
			['Wireless Noise Cancelling Headphones', 'Portable audio product with long battery life', 'electronics'],
			['Organic Cotton Blue Shirt', 'Comfortable everyday apparel in multiple sizes', 'clothing'],
			['Stainless Steel Water Bottle', 'Insulated outdoor product for hiking and travel', 'outdoors'],
		];
		const [title, description, category] = variants[id % variants.length];
		return { id: `product-${id}`, fields: { title: `${title} ${id}`, description, category } };
	}

	function parseOptions() {
		const { values } = parseArgs({
			options: {
				'fulltext-root': { type: 'string' },
				'revision': { type: 'string', default: process.env.GITHUB_SHA ?? 'working-tree' },
				'fulltext-revision': { type: 'string', default: 'working-tree' },
				'documents': { type: 'string', default: '5000' },
				'batch-size': { type: 'string', default: '500' },
				'queries': { type: 'string', default: '100' },
				'soak-reads': { type: 'string', default: '1000' },
				'foreground-rate': { type: 'string', default: '100' },
				'minimum-duration-ms': { type: 'string', default: '3000' },
				'publication-ms': { type: 'string', default: '1000' },
				'table-counts': { type: 'string', default: '1' },
				'arms': { type: 'string', default: 'no-index,native,wal-replay,root-flush' },
				'help': { type: 'boolean', default: false },
			},
		});
		if (values.help) {
			console.log(
				'node benchmarks/fulltext-hosted/run.cjs --fulltext-root /path/to/fulltext ' +
					'[--revision harper-sha] [--fulltext-revision fulltext-sha] ' +
					'[--documents 5000] [--batch-size 500] [--queries 100] [--foreground-rate 100] ' +
					'[--soak-reads 1000] [--publication-ms 1000,5000,30000] [--table-counts 1,16,128]'
			);
			process.exit(0);
		}
		const fulltextRoot = values['fulltext-root'] ?? process.env.HARPER_FULLTEXT_ROOT;
		if (!fulltextRoot) throw new Error('--fulltext-root or HARPER_FULLTEXT_ROOT is required');
		const arms = values.arms.split(',');
		const allowed = new Set(['no-index', 'native', 'wal-replay', 'root-flush']);
		if (arms.length === 0 || arms.some((arm) => !allowed.has(arm)) || arms[0] !== 'no-index') {
			throw new Error('arms must start with no-index and contain only no-index,native,wal-replay,root-flush');
		}
		return {
			fulltextRoot: resolve(fulltextRoot),
			revision: values.revision,
			fulltextRevision: values['fulltext-revision'],
			documents: positiveInteger(values.documents, 'documents'),
			batchSize: positiveInteger(values['batch-size'], 'batch-size'),
			queryCount: positiveInteger(values.queries, 'queries'),
			soakReads: positiveInteger(values['soak-reads'], 'soak-reads'),
			foregroundRate: positiveInteger(values['foreground-rate'], 'foreground-rate'),
			minimumDurationMs: positiveInteger(values['minimum-duration-ms'], 'minimum-duration-ms'),
			publicationMilliseconds: parsePositiveIntegerList(values['publication-ms'], 'publication-ms'),
			tableCounts: parsePositiveIntegerList(values['table-counts'], 'table-counts'),
			arms,
		};
	}

	function positiveInteger(value, name) {
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
		return parsed;
	}

	async function verifyFulltextRoot(root) {
		for (const path of ['dist/harper.js', 'dist/native.js']) await access(join(root, path));
	}

	function bigintReplacer(_key, value) {
		return typeof value === 'bigint' ? value.toString() : value;
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
