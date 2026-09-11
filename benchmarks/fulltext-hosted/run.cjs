const assert = require('node:assert');
const { access, mkdtemp, rm } = require('node:fs/promises');
const { availableParallelism } = require('node:os');
const { join, resolve } = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');
const { setImmediate: nextTurn, setTimeout: delay } = require('node:timers/promises');
const harperPackage = require('../../package.json');

let evaluateGates;
let PendingRequests;
let parsePositiveIntegerList;
let summarizeLatencies;
let closeDatabase;
let table;
let RocksDerivedIndexStorage;

(async () => {
	({ evaluateGates, parsePositiveIntegerList, summarizeLatencies } = await import('./metrics.mts'));
	({ PendingRequests } = await import('./PendingRequests.mts'));
	const options = parseOptions();
	await verifyFulltextRoot(options.fulltextRoot);
	require('../../unitTests/testUtils');
	const { setupTestDBPath } = require('../../unitTests/testUtils');
	const { removePerPidRoot } = require('../../unitTests/perPidRoot');
	({ closeDatabase, table } = require('#src/resources/databases'));
	({ RocksDerivedIndexStorage } = require('#src/resources/RocksDerivedIndexStorage'));
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	const fulltextHarper = await import(pathToFileURL(join(options.fulltextRoot, 'dist', 'harper.js')).href);
	const fulltextNative = await import(pathToFileURL(join(options.fulltextRoot, 'dist', 'native.js')).href);
	const runtime = await fulltextNative.runtimeInfo();
	assert(runtime.storageBackends.includes('harper'));
	let nextStoreIdentity = 0n;

	const testRoot = setupTestDBPath();
	process.once('exit', removePerPidRoot);
	setMainIsWorker(true);

	const results = [];
	let failed = false;
	let runError;
	let activeCase;
	try {
		for (const tableCount of options.tableCounts) {
			for (const publicationMilliseconds of options.publicationMilliseconds) {
				let baselineForegroundP99;
				let baselineForegroundWindowMilliseconds;
				for (const arm of options.arms) {
					activeCase = { arm, tableCount, publicationMilliseconds };
					const result = await runArm(arm, tableCount, publicationMilliseconds);
					if (arm === 'no-index') {
						baselineForegroundP99 = result.foreground.p99Milliseconds;
						baselineForegroundWindowMilliseconds = result.foregroundWindowMilliseconds;
					}
					if (baselineForegroundP99 === undefined || baselineForegroundWindowMilliseconds === undefined) {
						throw new Error('the no-index arm must run before indexed arms');
					}
					result.gates = evaluateGates({
						searchP99Milliseconds: result.search?.duringIndexing.p99Milliseconds,
						searchSampleCount: result.search?.duringIndexing.count,
						eventLoopP99Milliseconds: result.eventLoop.p99Milliseconds,
						eventLoopSampleCount: result.eventLoop.count,
						foregroundP99Milliseconds: result.foreground.p99Milliseconds,
						foregroundSampleCount: result.foreground.count,
						foregroundWindowMilliseconds: result.foregroundWindowMilliseconds,
						baselineForegroundP99Milliseconds: baselineForegroundP99,
						baselineForegroundWindowMilliseconds,
						maxSyncMilliseconds: result.storage?.sync.maxMilliseconds,
						syncSampleCount: result.storage?.sync.count,
						synchronousCommittedEvents: result.storage?.synchronousCommittedEvents,
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
	} catch (error) {
		failed = true;
		runError = error;
		console.error(error);
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
		failure: runError ? { ...activeCase, error: errorSummary(runError) } : undefined,
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
		const statsBefore = rocksStats(rootStore, tables);
		let committedEvents = 0;
		const onCommitted = () => committedEvents++;
		rootStore.on('committed', onCommitted);
		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		const foregroundLatencies = [];
		const searchLatencies = { duringIndexing: [], afterIndexing: [] };
		const searchReady = Promise.withResolvers();
		const control = { stop: false, indexing: true, searchReady };
		let indexContext;
		let foreground;
		let searches;
		const started = performance.now();
		try {
			indexContext = await openIndex(arm, rootStore, database, () => committedEvents);
			await warmForeground(tables);
			if (indexContext?.storageMeasurements) resetStorageMeasurements(indexContext.storageMeasurements);
			eventLoop.enable();
			const workloadStarted = performance.now();
			foreground = driveForeground(tables, control, workloadStarted, foregroundLatencies);
			searches = driveSearch(indexContext?.index, control, searchLatencies);
			foreground.catch(() => undefined);
			searches.catch(() => undefined);
			const indexing = await indexDocuments(indexContext, publicationMilliseconds, control);
			control.indexing = false;
			await searches;
			const remaining = options.minimumDurationMs - (performance.now() - workloadStarted);
			if (remaining > 0) await delay(remaining);
			control.stop = true;
			const foregroundCount = await foreground;
			const foregroundWindowMilliseconds = options.minimumDurationMs;
			const workloadMilliseconds = performance.now() - workloadStarted;
			const eventLoopSummary = {
				count: eventLoop.count,
				p50Milliseconds: eventLoop.percentile(50) / 1e6,
				p95Milliseconds: eventLoop.percentile(95) / 1e6,
				p99Milliseconds: eventLoop.percentile(99) / 1e6,
				maxMilliseconds: eventLoop.max / 1e6,
			};
			eventLoop.disable();
			const storage = indexContext?.storageMeasurements
				? storageSummary(indexContext.storageMeasurements, indexing.publications)
				: undefined;
			if (storage) assert.ok(storage.maxValueBytes <= 256 * 1024, 'stored value exceeded the 256 KiB chunk bound');
			const statsAfter = rocksStats(rootStore, tables);
			const soakRead = await measureSoakReads(tables, foregroundCount);
			const reopen = await closeAndReopen(indexContext);
			const totalMilliseconds = performance.now() - started;
			return {
				arm,
				tableCount,
				publicationMilliseconds,
				foregroundWindowMilliseconds,
				workloadMilliseconds,
				totalMilliseconds,
				indexing,
				foreground: summarizeLatencies(foregroundLatencies),
				soakRead,
				search: indexContext
					? {
							duringIndexing: summarizeLatencies(searchLatencies.duringIndexing),
							afterIndexing:
								searchLatencies.afterIndexing.length > 0
									? summarizeLatencies(searchLatencies.afterIndexing)
									: undefined,
							reopen,
						}
					: undefined,
				eventLoop: eventLoopSummary,
				storage,
				committedEvents,
				rocks: { before: statsBefore, after: statsAfter },
				gates: undefined,
			};
		} finally {
			control.stop = true;
			control.searchReady.resolve();
			await Promise.allSettled([foreground, searches].filter(Boolean));
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
			const path = await mkdtemp(join(testRoot, 'fulltext-native-control-'));
			const index = await fulltextNative.openNativeFullTextIndex({ ...common, path });
			return {
				arm,
				index,
				config: { ...common, path },
				storageMeasurements: undefined,
				disposed: false,
				async close() {
					if (this.disposed) return;
					try {
						await this.index.close({ mode: 'rollback' });
					} finally {
						try {
							await rm(path, { recursive: true, force: true });
						} finally {
							this.disposed = true;
						}
					}
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
				try {
					await this.index.close({ mode: 'rollback' });
				} finally {
					try {
						this.rawStorage.close();
					} finally {
						this.disposed = true;
					}
				}
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
				if (
					start === 0 ||
					end === options.documents ||
					performance.now() - sincePublication >= publicationMilliseconds
				) {
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
					control.searchReady.resolve();
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

	async function driveForeground(tables, control, started, latencies) {
		const interval = 1_000 / options.foregroundRate;
		const deadline = started + options.minimumDurationMs;
		let next = started;
		let sequence = 0;
		const pending = new PendingRequests();
		while (!control.stop && !pending.failed && next < deadline) {
			const wait = next - performance.now();
			if (wait > 0) await delay(wait);
			if (control.stop || pending.failed) break;
			const scheduled = next;
			next += interval;
			const id = sequence++;
			const Table = tables[id % tables.length];
			const request = Promise.resolve()
				.then(() => Table.put(`noise-${id}`, { value: `foreground-${id}` }))
				.then(() => {
					latencies.push(performance.now() - scheduled);
				});
			pending.add(request);
			if (pending.size >= 256) await pending.waitForOne();
		}
		await pending.drain('foreground writes');
		return latencies.length;
	}

	async function warmForeground(tables) {
		for (const Table of tables) {
			for (let sequence = 0; sequence < 32; sequence++) {
				await Table.put(`warm-${sequence}`, { value: `warm-${sequence}` });
			}
		}
	}

	async function measureSoakReads(tables, foregroundCount) {
		assert(foregroundCount > 0, 'foreground workload completed no writes');
		const latencies = [];
		for (let sequence = 0; sequence < options.soakReads; sequence++) {
			const id = sequence % foregroundCount;
			const Table = tables[id % tables.length];
			const started = performance.now();
			assert(await Table.get(`noise-${id}`));
			latencies.push(performance.now() - started);
		}
		return summarizeLatencies(latencies);
	}

	async function driveSearch(index, control, latencies) {
		if (!index) return;
		const queries = ['waterproof trail shoes', 'wireless headphones', 'cotton blue shirt', 'outdoor product'];
		const interval = 1_000 / options.queryRate;
		let sequence = 0;
		const pending = new PendingRequests();
		await control.searchReady.promise;
		let next = performance.now();
		while (!control.stop && !pending.failed && (control.indexing || sequence < options.queryCount)) {
			const wait = next - performance.now();
			if (wait > 0) await delay(wait);
			if (control.stop || pending.failed) break;
			const scheduled = next;
			next += interval;
			const query = queries[sequence % queries.length];
			const bucket = control.indexing ? latencies.duringIndexing : latencies.afterIndexing;
			const request = index.search({ text: query, limit: 10 }).then((result) => {
				assert(result.hits.length > 0, `full-text query returned no hits: ${query}`);
				bucket.push(performance.now() - scheduled);
			});
			pending.add(request);
			if (pending.size >= 256) await pending.waitForOne();
			sequence++;
		}
		await pending.drain('concurrent full-text searches');
	}

	async function closeAndReopen(context) {
		if (!context) return undefined;
		const expected = await context.index.search({ text: 'waterproof trail shoes', limit: 10, exactTotal: true });
		assert(expected.hits.length > 0);
		await context.index.close();
		let reopened;
		let reopenedStorage;
		let reopenMeasurements;
		try {
			const started = performance.now();
			if (context.arm === 'native') {
				reopened = await fulltextNative.openNativeFullTextIndex(context.config);
			} else {
				context.rawStorage.close();
				reopenedStorage = new RocksDerivedIndexStorage(context.rootStore, context.storeName);
				reopenMeasurements = emptyStorageMeasurements();
				const storage = measuredStorage(reopenedStorage, context.arm, reopenMeasurements, context.committedEvents);
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
			return {
				reopenMilliseconds,
				searchMilliseconds,
				total: result.total,
				storage: reopenMeasurements ? storageSummary(reopenMeasurements, 0) : undefined,
			};
		} finally {
			try {
				if (reopened) await reopened.close();
			} finally {
				try {
					try {
						reopenedStorage?.close();
					} finally {
						if (context.arm === 'native') await rm(context.config.path, { recursive: true, force: true });
					}
				} finally {
					context.disposed = true;
				}
			}
		}
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

	function resetStorageMeasurements(measurements) {
		Object.assign(measurements, emptyStorageMeasurements());
	}

	function rocksStats(rootStore, tables) {
		const databaseStats = rootStore.getStats();
		const databaseCounters = ['rocksdb.stall.micros', 'rocksdb.compact.read.bytes', 'rocksdb.compact.write.bytes'];
		const columnFamilyProperties = [
			'rocksdb.estimate-pending-compaction-bytes',
			'rocksdb.live-sst-files-size',
			'rocksdb.total-sst-files-size',
		];
		return {
			database: Object.fromEntries(databaseCounters.map((name) => [name, databaseStats[name] ?? null])),
			foregroundColumnFamilies: Object.fromEntries(
				columnFamilyProperties.map((name) => {
					const values = tables.map((Table) => Table.primaryStore.getDBIntProperty(name));
					return [
						name,
						values.some((value) => value === undefined) ? null : values.reduce((sum, value) => sum + value, 0),
					];
				})
			),
		};
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
				'documents': { type: 'string', default: '100000' },
				'batch-size': { type: 'string', default: '1000' },
				'queries': { type: 'string', default: '500' },
				'query-rate': { type: 'string', default: '500' },
				'soak-reads': { type: 'string', default: '1000' },
				'foreground-rate': { type: 'string', default: '100' },
				'minimum-duration-ms': { type: 'string', default: '12000' },
				'publication-ms': { type: 'string', default: '1000' },
				'table-counts': { type: 'string', default: '1' },
				'arms': { type: 'string', default: 'no-index,native,wal-only,root-flush' },
				'help': { type: 'boolean', default: false },
			},
		});
		if (values.help) {
			console.log(
				'node benchmarks/fulltext-hosted/run.cjs --fulltext-root /path/to/fulltext ' +
					'[--revision harper-sha] [--fulltext-revision fulltext-sha] ' +
					'[--documents 100000] [--batch-size 1000] [--queries 500] [--query-rate 500] ' +
					'[--foreground-rate 100] [--minimum-duration-ms 12000] ' +
					'[--soak-reads 1000] [--publication-ms 1000,5000,30000] [--table-counts 1,16,128]' +
					' [--arms no-index,native,wal-only,root-flush]'
			);
			process.exit(0);
		}
		const fulltextRoot = values['fulltext-root'] ?? process.env.HARPER_FULLTEXT_ROOT;
		if (!fulltextRoot) throw new Error('--fulltext-root or HARPER_FULLTEXT_ROOT is required');
		const arms = values.arms.split(',');
		const allowed = new Set(['no-index', 'native', 'wal-only', 'root-flush']);
		if (arms.length === 0 || arms.some((arm) => !allowed.has(arm)) || arms[0] !== 'no-index') {
			throw new Error('arms must start with no-index and contain only no-index,native,wal-only,root-flush');
		}
		return {
			fulltextRoot: resolve(fulltextRoot),
			revision: values.revision,
			fulltextRevision: values['fulltext-revision'],
			documents: positiveInteger(values.documents, 'documents'),
			batchSize: positiveInteger(values['batch-size'], 'batch-size'),
			queryCount: positiveInteger(values.queries, 'queries'),
			queryRate: positiveInteger(values['query-rate'], 'query-rate'),
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

	function errorSummary(error) {
		if (!(error instanceof Error)) return { message: String(error) };
		const summary = { name: error.name, message: error.message };
		if ('code' in error && error.code !== undefined) summary.code = String(error.code);
		if (error instanceof AggregateError) summary.errors = error.errors.map(errorSummary);
		return summary;
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
