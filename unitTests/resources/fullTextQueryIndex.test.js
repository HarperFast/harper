require('../testUtils');
const assert = require('node:assert');
const { toBufferKey } = require('ordered-binary');
const { waitFor } = require('../waitFor');
const { publishDerivedIndexReadiness } = require('#src/resources/derivedIndexRuntime');
const {
	FullTextQueryIndex,
	pauseNativeFullTextQueryReaders,
	resumeNativeFullTextQueryReaders,
} = require('#src/resources/indexes/fullTextQueryIndex');
const { encodeFullTextCursorPayload } = require('#src/resources/indexes/fullTextDerivedIndex');
const { nativeFullTextIndexPath } = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');

function sharedStore() {
	const buffers = new Map();
	const callbacks = new Map();
	let committedPosition;
	const rootStore = {
		getMonotonicTimestamp: () => 100,
		listLogs: () => ['local'],
		useLog: () => ({
			getStats: () => ({
				lastCommittedPosition: committedPosition,
				nextLogPosition: committedPosition ?? { sequence: 0, offset: 0 },
			}),
		}),
	};
	return {
		buffers,
		rootStore,
		getUserSharedBuffer(name, proposed, options) {
			if (!buffers.has(name)) buffers.set(name, new SharedArrayBuffer(proposed.byteLength));
			const buffer = structuredClone(buffers.get(name));
			const listeners = callbacks.get(name) ?? new Set();
			callbacks.set(name, listeners);
			if (options?.callback) listeners.add(options.callback);
			buffer.notify = () => {
				for (const callback of listeners) setImmediate(callback);
			};
			buffer.cancel = () => options?.callback && listeners.delete(options.callback);
			return buffer;
		},
		setCoverage(readinessId, nanoseconds) {
			const buffer = buffers.get(`derived-index:${readinessId}:readiness`);
			new BigInt64Array(buffer, buffer.byteLength - 8, 1)[0] = nanoseconds;
		},
		setCommittedPosition(position) {
			committedPosition = position;
		},
		listenerCount(readinessId) {
			return callbacks.get(`derived-index:${readinessId}:publication`)?.size ?? 0;
		},
		publish(readinessId, notify = true) {
			const name = `derived-index:${readinessId}:publication`;
			const revision = Atomics.add(new BigInt64Array(buffers.get(name), 0, 1), 0, 1n) + 1n;
			if (notify) for (const callback of callbacks.get(name) ?? []) setImmediate(callback);
			return revision;
		},
	};
}

function publicationPayload(logTimestamp = 1) {
	return encodeFullTextCursorPayload({ format: 1, logs: { local: logTimestamp }, coverage: { local: null } });
}

function nativeId(tableId, key) {
	return `${tableId}.${toBufferKey(key).toString('base64url')}`;
}

function definition() {
	return {
		name: 'catalogSearch',
		fields: [{ name: 'title', weight: 2, highlight: true }],
		analyzer: 'english@2',
		stopWords: true,
		positions: true,
		surfaceTerms: true,
		synonyms: [],
		highlighting: { fragmentLength: 120, maxFragments: 2 },
	};
}

function attachCurrentCoverage(index, auditStore, readinessId) {
	auditStore.setCoverage(readinessId, 99_000_000n);
	index.attachDerivedHost({
		readiness: () => ({ state: 'ready' }),
		requestRebuild: () => true,
		waitForCoverage: async () => {},
	});
	return { publish: (notify) => auditStore.publish(readinessId, notify) };
}

function simpleQueryIndex({ auditStore, readinessId, payload, hits, onReload, onGetEntry }) {
	let committedPayload = payload;
	let reloads = 0;
	const index = new FullTextQueryIndex({
		Table: {
			tableId: 1,
			primaryStore: {
				rootStore: auditStore.rootStore,
				getEntry: (key) => {
					onGetEntry?.(key);
					return { version: 1, value: { title: 'shoe' } };
				},
			},
			_readTxnForContext: () => undefined,
		},
		definition: definition(),
		auditStore,
		readinessId,
		indexId: readinessId,
		storePath: '/unused',
		storeName: 'unused',
		sourceGeneration: 'generation',
		limits: {},
		binding: {
			async runtimeInfo() {
				return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
			},
			async openNativeFullTextReader() {
				return {
					get committedPayload() {
						return committedPayload;
					},
					async search() {
						const current = hits();
						return { total: current.length, totalRelation: 'exact', hits: current };
					},
					async reload() {
						reloads++;
						onReload?.();
					},
					async close() {},
				};
			},
		},
	});
	return {
		index,
		reloads: () => reloads,
		setPayload: (value) => (committedPayload = value),
	};
}

describe('FullTextQueryIndex', () => {
	it('subscribes to publications only after the first query and cancels on close', async () => {
		const auditStore = sharedStore();
		const readinessId = 'lazy-publication-subscription';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const { index } = simpleQueryIndex({
			auditStore,
			readinessId,
			payload: publicationPayload(),
			hits: () => [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
		});
		attachCurrentCoverage(index, auditStore, readinessId);
		assert.strictEqual(auditStore.listenerCount(readinessId), 0);
		await index.search({ comparator: 'matches', value: 'shoe' }, {}, { minResults: 1 });
		assert.strictEqual(auditStore.listenerCount(readinessId), 1);
		await index.close();
		assert.strictEqual(auditStore.listenerCount(readinessId), 0);
	});

	it('shares the loaded source entry with pushed-down record filters', async () => {
		const auditStore = sharedStore();
		const readinessId = 'single-source-load';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let reads = 0;
		let filteredEntry;
		const index = simpleQueryIndex({
			auditStore,
			readinessId,
			payload: publicationPayload(),
			hits: () => [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
			onGetEntry: () => reads++,
		}).index;
		attachCurrentCoverage(index, auditStore, readinessId);
		await index.search(
			{ comparator: 'matches', value: 'shoe' },
			{},
			{
				minResults: 1,
				filter(_key, entry) {
					filteredEntry = entry;
					return true;
				},
			}
		);
		assert.strictEqual(reads, 1);
		assert.strictEqual(filteredEntry.value.title, 'shoe');
		await index.close();
	});

	it('filters stale hits, reloads on publication, and batches highlighting at native limits', async () => {
		const auditStore = sharedStore();
		const readinessId = 'fulltext:products:catalogSearch';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const tableId = 42;
		const entries = new Map([
			['one', { version: 2, value: { title: 'red running shoe' } }],
			['two', { version: 3, value: { title: 'blue running shoe' } }],
		]);
		const searches = [];
		const traces = [];
		let traceComplete = true;
		let reloads = 0;
		let closes = 0;
		let readerOptions;
		const reader = {
			committedPayload: publicationPayload(),
			async reload() {
				reloads++;
			},
			async search(request) {
				searches.push(request);
				return {
					total: 3,
					totalRelation: 'exact',
					hits: [
						{ id: nativeId(tableId, 'stale'), version: '1', score: 9 },
						{ id: nativeId(tableId, 'one'), version: '2', score: 8 },
						{ id: nativeId(tableId, 'two'), version: '3', score: 7 },
					],
				};
			},
			async traceMatches(request, records) {
				traces.push({ request, records });
				return {
					complete: traceComplete,
					records: records.map(({ id }) => ({
						id,
						values: [
							{
								field: 'title',
								valueIndex: 0,
								spans: [{ start: 0, end: 3 }],
								fragments: [{ text: 'red running shoe', start: 0, spans: [{ start: 0, end: 3 }] }],
							},
						],
					})),
				};
			},
			async close() {
				closes++;
				return {};
			},
		};
		const binding = {
			async runtimeInfo() {
				return {
					queryClassIsolationMinimumSearchThreads: 3,
					limits: { maxSearchWindow: 10_000, maxTraceRecords: 10, maxTraceSourceBytes: 20 },
				};
			},
			async openNativeFullTextReader(options) {
				readerOptions = options;
				return reader;
			},
		};
		const Table = {
			tableId,
			primaryStore: {
				getEntry: (key) => entries.get(key),
				getEstimatedKeyCount: () => 100,
			},
			_readTxnForContext: () => undefined,
		};
		const index = new FullTextQueryIndex({
			Table,
			definition: definition(),
			auditStore,
			readinessId,
			indexId: 'products-catalog-search',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {
				indexingThreads: 1,
				searchThreads: 2,
				writerMemoryBytes: 50_000_000,
				maxQueuedCommands: 16,
				maxQueuedBytes: 8_000_000,
				maxBatchBytes: 4_000_000,
			},
			binding,
		});
		const publication = attachCurrentCoverage(index, auditStore, readinessId);
		const condition = {
			attribute: 'catalogSearch',
			comparator: 'matches_all',
			value: 'running shoe',
			fullTextQuery: { text: 'running shoe', mode: 'all' },
			fullTextLeaves: [{ text: 'running shoe', mode: 'all' }],
			includeHighlights: true,
		};
		const first = await index.search(condition, {}, { minResults: 2 });
		assert.strictEqual(readerOptions.limits.searchThreads, 3);
		assert.deepStrictEqual(
			first.map(({ key, $score }) => ({ key, $score })),
			[
				{ key: 'one', $score: 8 },
				{ key: 'two', $score: 7 },
			]
		);
		assert.deepStrictEqual(searches[0].query, { text: 'running shoe', mode: 'all' });
		assert.strictEqual(searches[0].limit, 32);
		assert.strictEqual(traces.length, 2);
		assert(traces.every(({ records }) => records.length === 1));
		assert.deepStrictEqual(first[0].$highlights.title[0].spans, [{ start: 0, end: 3 }]);
		traceComplete = false;
		await assert.rejects(index.search(condition, {}, { minResults: 1 }), /incomplete highlights/);
		traceComplete = true;

		traces.length = 0;
		const paged = await index.search(condition, {}, { minResults: 2, resultOffset: 1 });
		assert.strictEqual(traces.length, 1);
		assert.strictEqual(traces[0].records[0].id, nativeId(tableId, 'two'));
		assert.strictEqual(paged[0].$highlights, undefined);
		assert(paged[1].$highlights);

		await index.search(condition, {}, { minResults: 1 });
		assert.strictEqual(reloads, 0);
		publication.publish(false);
		await index.search(condition, {}, { minResults: 1 });
		assert.strictEqual(reloads, 1);
		publication.publish();
		await waitFor(() => reloads === 2);
		await index.search(condition, {}, { minResults: 1 });
		assert.strictEqual(reloads, 2);
		assert.strictEqual(index.estimateCount(), 5);

		await index.close();
		assert.strictEqual(closes, 1);
	});

	it('coalesces publication notifications and certifies coverage from the reloaded reader', async () => {
		const auditStore = sharedStore();
		const readinessId = 'publication-race';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let payload = encodeFullTextCursorPayload({ format: 1, logs: { local: 1 } });
		let reloads = 0;
		const firstReload = Promise.withResolvers();
		const finishFirstReload = Promise.withResolvers();
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						get committedPayload() {
							return payload;
						},
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						async reload() {
							reloads++;
							if (reloads === 1) {
								firstReload.resolve();
								await finishFirstReload.promise;
							}
						},
						async close() {},
					};
				},
			},
		});
		const publication = attachCurrentCoverage(index, auditStore, readinessId);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await index.search(query, {}, { minResults: 1 });
		payload = publicationPayload(2);
		publication.publish();
		await firstReload.promise;
		publication.publish();
		finishFirstReload.resolve();
		await waitFor(() => reloads === 2);
		assert.strictEqual((await index.search({ ...query, maxIndexLagMilliseconds: 0 }, {}, { minResults: 1 })).length, 1);
		await index.close();
	});

	it('reloads the covering data publication before a waiting search', async () => {
		const auditStore = sharedStore();
		const readinessId = 'waiting-publication-generation';
		const firstPosition = { sequence: 1, offset: 10 };
		const secondPosition = { sequence: 1, offset: 20 };
		auditStore.setCommittedPosition(firstPosition);
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let visible = false;
		const fixture = simpleQueryIndex({
			auditStore,
			readinessId,
			payload: encodeFullTextCursorPayload({
				format: 1,
				logs: { local: 1 },
				coverage: { local: firstPosition },
			}),
			hits: () => (visible ? [{ id: nativeId(1, 'one'), version: '1', score: 1 }] : []),
			onReload: () => (visible = true),
		});
		const { index } = fixture;
		auditStore.setCoverage(readinessId, 99_000_000n);
		index.attachDerivedHost({
			readiness: () => ({ state: 'ready' }),
			requestRebuild: () => true,
			waitForCoverage: async () => {
				fixture.setPayload(
					encodeFullTextCursorPayload({
						format: 1,
						logs: { local: 2 },
						coverage: { local: secondPosition },
					})
				);
				auditStore.publish(readinessId, false);
			},
		});
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		assert.strictEqual((await index.search(query, {}, { minResults: 1 })).length, 0);

		auditStore.setCommittedPosition(secondPosition);
		const results = await index.search({ ...query, waitForIndexMilliseconds: 1000 }, {}, { minResults: 1 });
		assert.strictEqual(fixture.reloads(), 1);
		assert.deepStrictEqual(
			results.map(({ key }) => key),
			['one']
		);
		await index.close();
	});

	it('keeps coverage-only publication off the data-freshness path', async () => {
		const auditStore = sharedStore();
		const readinessId = 'coverage-only-publication';
		const firstPosition = { sequence: 1, offset: 10 };
		const secondPosition = { sequence: 1, offset: 20 };
		auditStore.setCommittedPosition(firstPosition);
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const fixture = simpleQueryIndex({
			auditStore,
			readinessId,
			payload: encodeFullTextCursorPayload({
				format: 1,
				logs: { local: 1 },
				coverage: { local: firstPosition },
			}),
			hits: () => [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
		});
		const { index } = fixture;
		auditStore.setCoverage(readinessId, 99_000_000n);
		index.attachDerivedHost({
			readiness: () => ({ state: 'ready' }),
			requestRebuild: () => true,
			waitForCoverage: async () => {},
		});
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual((await index.search({ ...query, maxIndexLagMilliseconds: 0 }, {}, { minResults: 1 })).length, 1);

		auditStore.setCommittedPosition(secondPosition);
		assert.strictEqual(
			(await index.search({ ...query, waitForIndexMilliseconds: 1000 }, {}, { minResults: 1 })).length,
			1
		);
		await assert.rejects(
			index.search({ ...query, maxIndexLagMilliseconds: 0 }, {}, { minResults: 1 }),
			(error) => error.code === 'DERIVED_INDEX_LAGGING'
		);
		assert.strictEqual(fixture.reloads(), 0);

		fixture.setPayload(
			encodeFullTextCursorPayload({
				format: 1,
				logs: { local: 1 },
				coverage: { local: secondPosition },
			})
		);
		auditStore.publish(readinessId);
		await waitFor(() => fixture.reloads() === 1);
		assert.strictEqual((await index.search({ ...query, maxIndexLagMilliseconds: 0 }, {}, { minResults: 1 })).length, 1);
		await index.close();
	});

	it('fails closed and requests one rebuild for an invalid reader checkpoint', async () => {
		for (const payload of [undefined, 'not-json']) {
			const auditStore = sharedStore();
			const readinessId = `invalid-reader-checkpoint-${String(payload)}`;
			publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
			let rebuilds = 0;
			const index = new FullTextQueryIndex({
				Table: { tableId: 1, primaryStore: {}, _readTxnForContext: () => undefined },
				definition: definition(),
				auditStore,
				readinessId,
				indexId: readinessId,
				storePath: '/unused',
				storeName: 'unused',
				sourceGeneration: 'generation',
				limits: {},
				binding: {
					async runtimeInfo() {
						return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
					},
					async openNativeFullTextReader() {
						return { committedPayload: payload, async search() {}, async reload() {}, async close() {} };
					},
				},
			});
			auditStore.setCoverage(readinessId, 99_000_000n);
			index.attachDerivedHost({
				readiness: () => ({ state: 'ready' }),
				requestRebuild: () => (rebuilds++, true),
				waitForCoverage: async () => {},
			});
			const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
			await assert.rejects(index.search(query, {}), (error) => error.name === 'IndexRebuildingError');
			await assert.rejects(index.search(query, {}), (error) => error.name === 'IndexRebuildingError');
			assert.strictEqual(rebuilds, 1);
			await index.close();
		}
	});

	it('retries a rebuild request that throws without consuming the repair latch', async () => {
		const auditStore = sharedStore();
		const readinessId = 'throwing-rebuild-request';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let rebuilds = 0;
		const index = new FullTextQueryIndex({
			Table: { tableId: 1, primaryStore: {}, _readTxnForContext: () => undefined },
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return { committedPayload: undefined, async search() {}, async reload() {}, async close() {} };
				},
			},
		});
		auditStore.setCoverage(readinessId, 99_000_000n);
		index.attachDerivedHost({
			readiness: () => ({ state: 'ready' }),
			requestRebuild() {
				if (++rebuilds === 1) throw new Error('notification unavailable');
				return true;
			},
			waitForCoverage: async () => {},
		});
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await assert.rejects(index.search(query, {}), (error) => error.name === 'IndexRebuildingError');
		await assert.rejects(index.search(query, {}), (error) => error.name === 'IndexRebuildingError');
		assert.strictEqual(rebuilds, 2);
		await index.close();
	});

	it('does not consume the rebuild request before a derived host is attached', async () => {
		const auditStore = sharedStore();
		const readinessId = 'late-rebuild-host';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const index = new FullTextQueryIndex({
			Table: { tableId: 1, primaryStore: {}, _readTxnForContext: () => undefined },
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return { committedPayload: undefined, async search() {}, async reload() {}, async close() {} };
				},
			},
		});
		auditStore.setCoverage(readinessId, 99_000_000n);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await assert.rejects(index.search(query, {}), (error) => error.name === 'IndexRebuildingError');
		let rebuilds = 0;
		index.attachDerivedHost({
			readiness: () => ({ state: 'ready' }),
			requestRebuild: () => (rebuilds++, true),
			waitForCoverage: async () => {},
		});
		await assert.rejects(index.search(query, {}), (error) => error.name === 'IndexRebuildingError');
		assert.strictEqual(rebuilds, 1);
		await index.close();
	});

	it('does not open native storage before shared readiness is ready', async () => {
		const auditStore = sharedStore();
		let opens = 0;
		const index = new FullTextQueryIndex({
			Table: { tableId: 1, primaryStore: {} },
			definition: definition(),
			auditStore,
			readinessId: 'not-ready',
			indexId: 'not-ready',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async openNativeFullTextReader() {
					opens++;
				},
			},
		});
		index.attachDerivedHost({
			readiness: () => ({ state: 'unknown' }),
			requestRebuild: () => false,
			waitForCoverage: async () => {},
		});
		await assert.rejects(
			index.search({ attribute: 'not-ready', comparator: 'matches', value: 'shoe' }, {}),
			(error) => error.name === 'IndexRebuildingError'
		);
		assert.strictEqual(opens, 0);
	});

	it('retries native capability discovery after a transient failure', async () => {
		const auditStore = sharedStore();
		const readinessId = 'binding-retry';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let probes = 0;
		let opens = 0;
		const index = new FullTextQueryIndex({
			Table: { tableId: 1, primaryStore: {}, _readTxnForContext: () => undefined },
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					if (++probes === 1) throw new Error('temporary capability probe failure');
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					opens++;
					return {
						async search() {
							return { total: 0, totalRelation: 'exact', hits: [] };
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, readinessId);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await assert.rejects(index.search(query, {}), /Full-text search on 'catalogSearch' failed/);
		assert.deepStrictEqual(await index.search(query, {}), []);
		assert.strictEqual(probes, 2);
		assert.strictEqual(opens, 1);
		await index.close();
	});

	it('maps native query failures without exposing native details', async () => {
		const auditStore = sharedStore();
		publishDerivedIndexReadiness(auditStore, 'query-errors', 'ready');
		const errors = [
			Object.assign(new Error('expanded secret details'), { code: 'E_PREFIX_TOO_BROAD' }),
			new Error('storage path and internal details'),
		];
		const index = new FullTextQueryIndex({
			Table: { tableId: 1, primaryStore: {}, _readTxnForContext: () => undefined },
			definition: definition(),
			auditStore,
			readinessId: 'query-errors',
			indexId: 'query-errors',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							throw errors.shift();
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, 'query-errors');
		const query = { attribute: 'query-errors', comparator: 'matches_prefix', value: 's' };
		await assert.rejects(
			index.search(query, {}),
			(error) => error.statusCode === 400 && error.message === "Full-text query on 'catalogSearch' is invalid"
		);
		await assert.rejects(
			index.search(query, {}),
			(error) => error.statusCode === 500 && error.message === "Full-text search on 'catalogSearch' failed"
		);
		await index.close();
	});

	it('retries a transient reload failure on the existing reader', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-reconfigure';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const entry = { version: 1, value: { title: 'running shoe' } };
		const opens = [];
		let closes = 0;
		let failReload = false;
		const binding = {
			async runtimeInfo() {
				return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 } };
			},
			async openNativeFullTextReader(options) {
				opens.push(structuredClone(options));
				return {
					async search() {
						return {
							total: 1,
							totalRelation: 'exact',
							hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
						};
					},
					committedPayload: publicationPayload(),
					async reload() {
						if (failReload) {
							failReload = false;
							throw Object.assign(new Error('reload failed'), { code: 'E_RELOAD_FAILED' });
						}
					},
					async close() {
						closes++;
					},
				};
			},
		};
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => entry },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding,
		});
		const publication = attachCurrentCoverage(index, auditStore, readinessId);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await index.search(query, {}, { minResults: 1 });
		index.updateDefinition({ ...definition(), fields: [{ name: 'title', weight: 7, highlight: true }] });
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(opens.length, 2);
		assert.strictEqual(opens[1].fields[0].weight, 7);

		publication.publish();
		failReload = true;
		await assert.rejects(index.search(query, {}, { minResults: 1 }), (error) => error.name === 'DerivedIndexLagError');
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(opens.length, 2);
		assert.strictEqual(closes, 1);
		await index.close();
		assert.strictEqual(closes, 2);
	});

	it('reopens a reader after repeated reload failures', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-reload-reopen';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let opens = 0;
		let closes = 0;
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'running shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused-reload-reopen',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					opens++;
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {
							throw Object.assign(new Error('reload failed'), { code: 'E_RELOAD_FAILED' });
						},
						async close() {
							closes++;
						},
					};
				},
			},
		});
		const publication = attachCurrentCoverage(index, auditStore, readinessId);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await index.search(query, {}, { minResults: 1 });
		publication.publish();
		for (let attempt = 0; attempt < 3; attempt++)
			await assert.rejects(
				index.search(query, {}, { minResults: 1 }),
				(error) => error.name === 'DerivedIndexLagError'
			);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(closes, 1);
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(opens, 2);
		await index.close();
	});

	it('requires callers to page searches larger than the native result window', async () => {
		const auditStore = sharedStore();
		publishDerivedIndexReadiness(auditStore, 'query-window', 'ready');
		let searches = 0;
		let lastRequest;
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: {
					getEntry: (key) => ({ version: 1, value: { title: key } }),
				},
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId: 'query-window',
			indexId: 'query-window',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 2, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						async search(request) {
							searches++;
							lastRequest = request;
							return {
								total: 3,
								totalRelation: 'exact',
								hits: [
									{ id: nativeId(1, 'one'), version: '1', score: 2 },
									{ id: nativeId(1, 'two'), version: '1', score: 1 },
								],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, 'query-window');
		const query = { attribute: 'query-window', comparator: 'matches', value: 'shoe' };
		assert.deepStrictEqual(await index.search(query, {}, { minResults: 0 }), []);
		assert.strictEqual(searches, 0);
		await assert.rejects(index.search(query, {}, { minResults: 3 }), /reduce offset or limit/);
		assert.strictEqual(searches, 0);
		await assert.rejects(index.search(query, {}), /exceeds the 2-result search window/);
		assert.strictEqual(lastRequest.exactTotal, true);
		await index.close();
	});

	it('pages unbounded searches instead of reading the native window in one turn', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-paging';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const hits = Array.from({ length: 300 }, (_value, index) => ({
			id: nativeId(1, `record-${index}`),
			version: '1',
			score: 300 - index,
		}));
		const requests = [];
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: (key) => ({ version: 1, value: { title: key } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					return {
						async search(request) {
							requests.push(request);
							return {
								total: hits.length,
								totalRelation: 'exact',
								hits: hits.slice(request.offset, request.offset + request.limit),
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, readinessId);
		const results = await index.search({ attribute: readinessId, comparator: 'matches', value: 'shoe' }, {});
		assert.strictEqual(results.length, 300);
		assert.deepStrictEqual(
			requests.map(({ offset, limit, exactTotal }) => ({ offset, limit, exactTotal })),
			[
				{ offset: 0, limit: 256, exactTotal: true },
				{ offset: 256, limit: 256, exactTotal: undefined },
			]
		);
		await index.close();
	});

	it('fails instead of returning an incomplete bounded page after filtering exhausts the native window', async () => {
		const auditStore = sharedStore();
		publishDerivedIndexReadiness(auditStore, 'filtered-window', 'ready');
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId: 'filtered-window',
			indexId: 'filtered-window',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 2, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							return {
								total: 2,
								totalRelation: 'lower-bound',
								hits: [
									{ id: nativeId(1, 'one'), version: '1', score: 2 },
									{ id: nativeId(1, 'two'), version: '1', score: 1 },
								],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, 'filtered-window');
		await assert.rejects(
			index.search(
				{ attribute: 'filtered-window', comparator: 'matches', value: 'shoe' },
				{},
				{ minResults: 1, filter: () => false }
			),
			/filters exhausted the 2-result search window/
		);
		await index.close();
	});

	it('reports stale native versions as retryable index lag', async () => {
		const auditStore = sharedStore();
		publishDerivedIndexReadiness(auditStore, 'stale-window', 'ready');
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 2, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId: 'stale-window',
			indexId: 'stale-window',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 2, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							return {
								total: 3,
								totalRelation: 'lower-bound',
								hits: [
									{ id: nativeId(1, 'one'), version: '1', score: 2 },
									{ id: nativeId(1, 'two'), version: '1', score: 1 },
								],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, 'stale-window');
		await assert.rejects(
			index.search({ attribute: 'stale-window', comparator: 'matches', value: 'shoe' }, {}, { minResults: 1 }),
			(error) => error.name === 'DerivedIndexLagError' && error.statusCode === 503 && error.retryable === true
		);
		await index.close();
	});

	it('requests a rebuild for native corruption and retries a rejected reader close', async () => {
		const auditStore = sharedStore();
		publishDerivedIndexReadiness(auditStore, 'query-rebuild', 'ready');
		let rebuilds = 0;
		let closeAttempts = 0;
		const index = new FullTextQueryIndex({
			Table: { tableId: 1, primaryStore: {}, _readTxnForContext: () => undefined },
			definition: definition(),
			auditStore,
			readinessId: 'query-rebuild',
			indexId: 'query-rebuild',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							throw Object.assign(new Error('corrupt'), { code: 'E_INDEX_CORRUPT' });
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {
							if (closeAttempts++ === 0) throw new Error('close failed');
						},
					};
				},
			},
		});
		index.attachDerivedHost({
			readiness: () => ({ state: 'ready' }),
			requestRebuild: () => (rebuilds++, true),
			waitForCoverage: async () => {},
		});
		auditStore.setCoverage('query-rebuild', 99_000_000n);
		await assert.rejects(
			index.search({ attribute: 'query-rebuild', comparator: 'matches', value: 'shoe' }, {}),
			(error) => error.name === 'IndexRebuildingError'
		);
		assert.strictEqual(rebuilds, 1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(closeAttempts, 1);
		await index.close();
		assert.strictEqual(closeAttempts, 2);
	});

	it('requests a rebuild for native identity and incomplete-create failures', async () => {
		for (const code of ['E_IDENTITY_MISMATCH', 'E_INCOMPLETE_CREATE']) {
			const auditStore = sharedStore();
			const readinessId = `query-rebuild-${code}`;
			publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
			let rebuilds = 0;
			const index = new FullTextQueryIndex({
				Table: { tableId: 1, primaryStore: {}, _readTxnForContext: () => undefined },
				definition: definition(),
				auditStore,
				readinessId,
				indexId: readinessId,
				storePath: '/unused',
				storeName: 'unused',
				sourceGeneration: 'generation',
				limits: {},
				binding: {
					async runtimeInfo() {
						return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
					},
					async openNativeFullTextReader() {
						return {
							async search() {
								throw Object.assign(new Error('native storage cannot open'), { code });
							},
							committedPayload: publicationPayload(),
							async reload() {},
							async close() {},
						};
					},
				},
			});
			index.attachDerivedHost({
				readiness: () => ({ state: 'ready' }),
				requestRebuild: () => (rebuilds++, true),
				waitForCoverage: async () => {},
			});
			auditStore.setCoverage(readinessId, 99_000_000n);
			await assert.rejects(
				index.search({ attribute: readinessId, comparator: 'matches', value: 'shoe' }, {}),
				(error) => error.name === 'IndexRebuildingError'
			);
			assert.strictEqual(rebuilds, 1);
			await index.close();
		}
	});

	it('rejects a native hit without its source version', async () => {
		const auditStore = sharedStore();
		publishDerivedIndexReadiness(auditStore, 'missing-hit-version', 'ready');
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId: 'missing-hit-version',
			indexId: 'missing-hit-version',
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { queryClassIsolationMinimumSearchThreads: 1, limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), score: 1 }],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, 'missing-hit-version');
		await assert.rejects(
			index.search({ attribute: 'missing-hit-version', comparator: 'matches', value: 'shoe' }, {}),
			/without a source version/
		);
		await index.close();
	});

	it('reloads a reader for a new publication without interrupting an in-flight search', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-reader-lease';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const firstSearch = Promise.withResolvers();
		const firstStarted = Promise.withResolvers();
		let closes = 0;
		let opens = 0;
		let reloads = 0;
		let searches = 0;
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					const readerIndex = opens++;
					return {
						async search() {
							if (readerIndex === 0 && searches++ === 0) {
								firstStarted.resolve();
								await firstSearch.promise;
							}
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {
							reloads++;
						},
						async close() {
							closes++;
						},
					};
				},
			},
		});
		const publication = attachCurrentCoverage(index, auditStore, readinessId);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		const first = index.search(query, {}, { minResults: 1 });
		await firstStarted.promise;
		publication.publish();
		const second = await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(second.length, 1);
		assert.strictEqual(opens, 1);
		assert.strictEqual(reloads, 1);
		assert.strictEqual(closes, 0);
		firstSearch.resolve();
		const firstResult = await first;
		assert.strictEqual(firstResult.length, 1);
		await index.close();
		assert.strictEqual(closes, 1);
	});

	it('does not let a native reader close failure reject lifecycle shutdown', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-reader-close-failure';
		const storePath = '/unused';
		const storeName = 'query-reader-close-failure';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let closes = 0;
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath,
			storeName,
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {
							closes++;
							throw new Error('close failed');
						},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, readinessId);
		await index.search({ attribute: readinessId, comparator: 'matches', value: 'shoe' }, {});
		await index.close();
		assert.strictEqual(closes, 1);
		await pauseNativeFullTextQueryReaders(nativeFullTextIndexPath(storePath, storeName), readinessId, 1n);
		assert.strictEqual(closes, 1);
	});

	it('reads and returns highlights only for fields selected by the query', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-highlight-fields';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let bodyReads = 0;
		let bodyReadFails = false;
		const tracedFieldSets = [];
		class CountedBlob extends Blob {
			async arrayBuffer() {
				bodyReads++;
				if (bodyReadFails) throw new Error('blob store unavailable');
				return super.arrayBuffer();
			}
		}
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: {
					getEntry: () => ({ version: 1, value: { title: 'trail shoe', body: new CountedBlob(['shoe body']) } }),
				},
				_readTxnForContext: () => undefined,
			},
			definition: {
				...definition(),
				fields: [
					{ name: 'title', weight: 1, highlight: true },
					{ name: 'body', weight: 1, highlight: true, mediaType: 'text/plain' },
				],
			},
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						async traceMatches(request, records) {
							tracedFieldSets.push(Object.keys(records[0].fields));
							assert.deepStrictEqual(Object.keys(records[0].fields), request.fields);
							return {
								complete: true,
								records: [
									{
										id: records[0].id,
										values: [
											{ field: 'title', valueIndex: 0, spans: [{ start: 6, end: 10 }] },
											{ field: 'body', valueIndex: 0, spans: [{ start: 0, end: 4 }] },
										],
									},
								],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, readinessId);
		const [result] = await index.search(
			{
				attribute: readinessId,
				comparator: 'matches',
				value: 'shoe',
				fields: ['title'],
				fullTextLeaves: [{ text: 'shoe', mode: 'any', fields: ['title'] }],
				includeHighlights: true,
			},
			{},
			{ minResults: 1 }
		);
		assert.strictEqual(bodyReads, 0);
		assert.deepStrictEqual(Object.keys(result.$highlights), ['title']);
		await index.search(
			{
				attribute: readinessId,
				comparator: 'matches',
				value: 'shoe',
				fullTextLeaves: [
					{ text: 'trail', mode: 'any', fields: ['title'] },
					{ text: 'shoe', mode: 'any', fields: ['body'] },
				],
				includeHighlights: true,
			},
			{},
			{ minResults: 1 }
		);
		assert.deepStrictEqual(tracedFieldSets, [['title'], ['title'], ['body']]);
		assert.strictEqual(bodyReads, 1);
		bodyReads = 0;
		bodyReadFails = true;
		await assert.rejects(
			index.search(
				{
					attribute: readinessId,
					comparator: 'matches',
					value: 'shoe',
					fields: ['body'],
					fullTextLeaves: [{ text: 'shoe', mode: 'any', fields: ['body'] }],
					includeHighlights: true,
				},
				{},
				{ minResults: 1 }
			),
			(error) => {
				assert.strictEqual(error.name, 'DerivedIndexLagError');
				assert.strictEqual(error.statusCode, 503);
				assert.strictEqual(error.retryable, true);
				return true;
			}
		);
		assert.strictEqual(bodyReads, 1);
		await index.close();
	});

	it('orders reader pause and resume epochs and recovers a completed pause', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-pause-epochs';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const storePath = '/unused';
		const storeName = 'query-pause-epochs';
		const path = nativeFullTextIndexPath(storePath, storeName);
		let opens = 0;
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath,
			storeName,
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					opens++;
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, readinessId);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await pauseNativeFullTextQueryReaders(path, readinessId, 0n);
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(opens, 1);
		await pauseNativeFullTextQueryReaders(path, readinessId, 1n);
		resumeNativeFullTextQueryReaders(path, readinessId, 0n);
		await assert.rejects(index.search(query, {}, { minResults: 1 }), (error) => error.name === 'IndexRebuildingError');
		resumeNativeFullTextQueryReaders(path, readinessId, 1n);
		await index.search(query, {}, { minResults: 1 });
		await index.close();
	});

	it('does not clear a new same-generation pause with a stale owner epoch', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-pause-stale-owner';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const storePath = '/unused';
		const storeName = 'query-pause-stale-owner';
		const path = nativeFullTextIndexPath(storePath, storeName);
		const openStarted = Promise.withResolvers();
		const finishOpen = Promise.withResolvers();
		let firstOpen = true;
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath,
			storeName,
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					if (firstOpen) {
						firstOpen = false;
						openStarted.resolve();
						await finishOpen.promise;
					}
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, readinessId);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		const search = index.search(query, {}, { minResults: 1 });
		await openStarted.promise;
		publishDerivedIndexReadiness(auditStore, readinessId, 'rebuilding');
		const pause = pauseNativeFullTextQueryReaders(path, readinessId, 0n);
		finishOpen.resolve();
		await assert.rejects(search, (error) => error.name === 'IndexRebuildingError');
		await pause;
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		assert.strictEqual((await index.search(query, {}, { minResults: 1 })).length, 1);
		await index.close();
	});

	it('drains superseded readers on the same path before pausing a successor generation', async () => {
		const auditStore = sharedStore();
		const oldReadinessId = 'query-pause-old-generation';
		const newReadinessId = 'query-pause-new-generation';
		publishDerivedIndexReadiness(auditStore, oldReadinessId, 'ready');
		publishDerivedIndexReadiness(auditStore, newReadinessId, 'ready');
		const storePath = '/unused';
		const storeName = 'query-pause-generations';
		const path = nativeFullTextIndexPath(storePath, storeName);
		const searchStarted = Promise.withResolvers();
		const finishSearch = Promise.withResolvers();
		let oldCloses = 0;
		const createIndex = (readinessId, oldGeneration) => {
			const index = new FullTextQueryIndex({
				Table: {
					tableId: 1,
					primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
					_readTxnForContext: () => undefined,
				},
				definition: definition(),
				auditStore,
				readinessId,
				indexId: readinessId,
				storePath,
				storeName,
				sourceGeneration: readinessId,
				limits: {},
				binding: {
					async runtimeInfo() {
						return {
							queryClassIsolationMinimumSearchThreads: 1,
							limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
						};
					},
					async openNativeFullTextReader() {
						return {
							async search() {
								if (oldGeneration) {
									searchStarted.resolve();
									await finishSearch.promise;
								}
								return {
									total: 1,
									totalRelation: 'exact',
									hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
								};
							},
							committedPayload: publicationPayload(),
							async reload() {},
							async close() {
								if (oldGeneration) oldCloses++;
							},
						};
					},
				},
			});
			attachCurrentCoverage(index, auditStore, readinessId);
			return index;
		};
		const oldIndex = createIndex(oldReadinessId, true);
		const newIndex = createIndex(newReadinessId, false);
		const oldSearch = oldIndex.search({ attribute: oldReadinessId, comparator: 'matches', value: 'shoe' }, {});
		await searchStarted.promise;
		let paused = false;
		const pause = pauseNativeFullTextQueryReaders(path, newReadinessId, 1n).then(() => {
			paused = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(paused, false);
		assert.strictEqual(oldCloses, 0);
		finishSearch.resolve();
		await oldSearch;
		await pause;
		assert.strictEqual(oldCloses, 1);
		resumeNativeFullTextQueryReaders(path, newReadinessId, 1n);
		assert.strictEqual(
			(await oldIndex.search({ attribute: oldReadinessId, comparator: 'matches', value: 'shoe' }, {})).length,
			1
		);
		assert.strictEqual(
			(await newIndex.search({ attribute: newReadinessId, comparator: 'matches', value: 'shoe' }, {})).length,
			1
		);
		await pauseNativeFullTextQueryReaders(path, oldReadinessId, 2n);
		await pauseNativeFullTextQueryReaders(path, newReadinessId, 2n);
		resumeNativeFullTextQueryReaders(path, newReadinessId, 2n);
		await assert.rejects(
			newIndex.search({ attribute: newReadinessId, comparator: 'matches', value: 'shoe' }, {}),
			(error) => error.name === 'IndexRebuildingError'
		);
		resumeNativeFullTextQueryReaders(path, oldReadinessId, 2n);
		assert.strictEqual(
			(await newIndex.search({ attribute: newReadinessId, comparator: 'matches', value: 'shoe' }, {})).length,
			1
		);
		await oldIndex.close();
		await newIndex.close();
	});

	it('requires the exact generation-scoped reset token to resume a shared path', async () => {
		const auditStore = sharedStore();
		const oldReadinessId = 'query-predecessor-pause';
		const newReadinessId = 'query-successor-resume';
		publishDerivedIndexReadiness(auditStore, oldReadinessId, 'ready');
		publishDerivedIndexReadiness(auditStore, newReadinessId, 'ready');
		const storePath = '/unused';
		const storeName = 'query-predecessor-successor';
		const path = nativeFullTextIndexPath(storePath, storeName);
		const createIndex = (readinessId) => {
			const index = new FullTextQueryIndex({
				Table: {
					tableId: 1,
					primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
					_readTxnForContext: () => undefined,
				},
				definition: definition(),
				auditStore,
				readinessId,
				indexId: readinessId,
				storePath,
				storeName,
				sourceGeneration: readinessId,
				limits: {},
				binding: {
					async runtimeInfo() {
						return {
							queryClassIsolationMinimumSearchThreads: 1,
							limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
						};
					},
					async openNativeFullTextReader() {
						return {
							async search() {
								return {
									total: 1,
									totalRelation: 'exact',
									hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
								};
							},
							committedPayload: publicationPayload(),
							async reload() {},
							async close() {},
						};
					},
				},
			});
			attachCurrentCoverage(index, auditStore, readinessId);
			return index;
		};
		const oldIndex = createIndex(oldReadinessId);
		const newIndex = createIndex(newReadinessId);

		await pauseNativeFullTextQueryReaders(path, oldReadinessId, 1n);
		await pauseNativeFullTextQueryReaders(path, newReadinessId, 1n);
		resumeNativeFullTextQueryReaders(path, oldReadinessId, 1n);
		await assert.rejects(
			oldIndex.search({ attribute: oldReadinessId, comparator: 'matches', value: 'shoe' }, {}),
			(error) => error.name === 'IndexRebuildingError'
		);
		await assert.rejects(
			newIndex.search({ attribute: newReadinessId, comparator: 'matches', value: 'shoe' }, {}),
			(error) => error.name === 'IndexRebuildingError'
		);
		resumeNativeFullTextQueryReaders(path, newReadinessId, 1n);
		assert.strictEqual(
			(await oldIndex.search({ attribute: oldReadinessId, comparator: 'matches', value: 'shoe' }, {})).length,
			1
		);
		assert.strictEqual(
			(await newIndex.search({ attribute: newReadinessId, comparator: 'matches', value: 'shoe' }, {})).length,
			1
		);
		await oldIndex.close();
		await newIndex.close();
	});

	it('recovers a foreign pause after its readiness returns to ready', async () => {
		const auditStore = sharedStore();
		const pausedReadinessId = 'query-missed-resume-old';
		const currentReadinessId = 'query-missed-resume-current';
		publishDerivedIndexReadiness(auditStore, pausedReadinessId, 'rebuilding');
		publishDerivedIndexReadiness(auditStore, currentReadinessId, 'ready');
		const storePath = '/unused';
		const storeName = 'query-missed-resume';
		const path = nativeFullTextIndexPath(storePath, storeName);
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => ({ version: 1, value: { title: 'shoe' } }) },
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId: currentReadinessId,
			indexId: currentReadinessId,
			storePath,
			storeName,
			sourceGeneration: currentReadinessId,
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						committedPayload: publicationPayload(),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index, auditStore, currentReadinessId);
		const query = { attribute: currentReadinessId, comparator: 'matches', value: 'shoe' };
		await pauseNativeFullTextQueryReaders(path, pausedReadinessId, 0n);
		await assert.rejects(index.search(query, {}), (error) => error.name === 'IndexRebuildingError');
		publishDerivedIndexReadiness(auditStore, pausedReadinessId, 'ready');
		assert.strictEqual((await index.search(query, {})).length, 1);
		await index.close();
	});

	it('reports bounded coverage and waits for current coverage when requested', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-coverage';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		auditStore.setCoverage(readinessId, 99_000_000n);
		let waited = 0;
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: {
					rootStore: { getMonotonicTimestamp: () => performance.now() },
					getEntry: () => ({ version: 1, value: { title: 'shoe' } }),
				},
				_readTxnForContext: () => undefined,
			},
			definition: definition(),
			auditStore,
			readinessId,
			indexId: readinessId,
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return {
						queryClassIsolationMinimumSearchThreads: 1,
						limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 },
					};
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						committedPayload: encodeFullTextCursorPayload({ format: 1, logs: { local: 1 } }),
						async reload() {},
						async close() {},
					};
				},
			},
		});
		index.attachDerivedHost({
			readiness: () => ({ state: 'ready' }),
			requestRebuild: () => true,
			waitForCoverage: async () => {
				waited++;
			},
		});
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe', maxIndexLagMilliseconds: 25 };
		const pending = index.search(query, {}, { minResults: 1 });
		assert.deepStrictEqual(pending.indexCoverage, {
			state: 'bounded',
			maxLagMilliseconds: 25,
			lagUpperBoundMilliseconds: 1,
		});
		await pending;
		await index.search(
			{ ...query, waitForIndexMilliseconds: 10 },
			{ indexSearchStart: Promise.resolve() },
			{ minResults: 1 }
		);
		assert.strictEqual(waited, 1);
		await index.close();
	});
});
