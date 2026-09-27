require('../testUtils');
const assert = require('node:assert');
const { toBufferKey } = require('ordered-binary');
const { publishDerivedIndexReadiness } = require('#src/resources/derivedIndexRuntime');
const {
	FullTextQueryIndex,
	pauseNativeFullTextQueryReaders,
	resumeNativeFullTextQueryReaders,
} = require('#src/resources/indexes/fullTextQueryIndex');
const { nativeFullTextIndexPath } = require('#src/resources/indexes/nativeFullTextDerivedIndexLifecycle');

function sharedStore() {
	const buffers = new Map();
	return {
		buffers,
		getUserSharedBuffer(name, proposed) {
			if (!buffers.has(name)) buffers.set(name, proposed);
			return buffers.get(name);
		},
	};
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

function attachCurrentCoverage(index) {
	let publicationRevision = 0n;
	index.attachDerivedHost({
		readiness: () => ({ state: 'ready' }),
		coverage: (maxLagMilliseconds) => ({
			state: 'current',
			maxLagMilliseconds,
			lagUpperBoundMilliseconds: 0,
		}),
		requestRebuild: () => true,
		publicationRevision: () => publicationRevision,
		waitForCoverage: async () => {},
	});
	return { publish: () => publicationRevision++ };
}

describe('FullTextQueryIndex', () => {
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
		const reader = {
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
				return { limits: { maxSearchWindow: 10_000, maxTraceRecords: 1 } };
			},
			async openNativeFullTextReader() {
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
		const publication = attachCurrentCoverage(index);
		const condition = {
			attribute: 'catalogSearch',
			comparator: 'matches_all',
			value: 'running shoe',
			fullTextQuery: { text: 'running shoe', mode: 'all' },
			fullTextLeaves: [{ text: 'running shoe', mode: 'all' }],
			includeHighlights: true,
		};
		const first = await index.search(condition, {}, { minResults: 2 });
		assert.deepStrictEqual(
			first.map(({ key, $score }) => ({ key, $score })),
			[
				{ key: 'one', $score: 8 },
				{ key: 'two', $score: 7 },
			]
		);
		assert.deepStrictEqual(searches[0].query, { text: 'running shoe', mode: 'all' });
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
		publication.publish();
		await index.search(condition, {}, { minResults: 1 });
		assert.strictEqual(reloads, 1);
		assert.strictEqual(index.estimateCount(), 5);

		await index.close();
		assert.strictEqual(closes, 1);
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
		attachCurrentCoverage(index);
		await assert.rejects(
			index.search({ attribute: 'not-ready', comparator: 'matches', value: 'shoe' }, {}),
			(error) => error.name === 'IndexRebuildingError'
		);
		assert.strictEqual(opens, 0);
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
					return { limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							throw errors.shift();
						},
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index);
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

	it('reopens after a reload failure and applies query-only definition changes', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-reconfigure';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const entry = { version: 1, value: { title: 'running shoe' } };
		const opens = [];
		let closes = 0;
		let failReload = false;
		const binding = {
			async runtimeInfo() {
				return { limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 } };
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
		const publication = attachCurrentCoverage(index);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await index.search(query, {}, { minResults: 1 });
		index.updateDefinition({ ...definition(), fields: [{ name: 'title', weight: 7, highlight: true }] });
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(opens.length, 2);
		assert.strictEqual(opens[1].fields[0].weight, 7);

		publication.publish();
		failReload = true;
		await assert.rejects(index.search(query, {}, { minResults: 1 }), (error) => error.name === 'IndexRebuildingError');
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(opens.length, 3);
		assert.strictEqual(closes, 2);
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
					return { limits: { maxSearchWindow: 2, maxTraceRecords: 10 } };
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
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index);
		const query = { attribute: 'query-window', comparator: 'matches', value: 'shoe' };
		assert.deepStrictEqual(await index.search(query, {}, { minResults: 0 }), []);
		assert.strictEqual(searches, 0);
		await assert.rejects(index.search(query, {}, { minResults: 3 }), /reduce offset or limit/);
		assert.strictEqual(searches, 0);
		await assert.rejects(index.search(query, {}), /exceeds the 2-result search window/);
		assert.strictEqual(lastRequest.exactTotal, true);
		await index.close();
	});

	it('fails instead of returning an incomplete bounded page after filtering exhausts the native window', async () => {
		const auditStore = sharedStore();
		publishDerivedIndexReadiness(auditStore, 'filtered-window', 'ready');
		const index = new FullTextQueryIndex({
			Table: {
				tableId: 1,
				primaryStore: { getEntry: () => undefined },
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
					return { limits: { maxSearchWindow: 2, maxTraceRecords: 10 } };
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
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index);
		await assert.rejects(
			index.search({ attribute: 'filtered-window', comparator: 'matches', value: 'shoe' }, {}, { minResults: 1 }),
			/filters exhausted the 2-result search window/
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
					return { limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					return {
						async search() {
							throw Object.assign(new Error('corrupt'), { code: 'E_INDEX_CORRUPT' });
						},
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
			coverage: () => ({ state: 'current', maxLagMilliseconds: 0, lagUpperBoundMilliseconds: 0 }),
			requestRebuild: () => (rebuilds++, true),
			publicationRevision: () => 0n,
			waitForCoverage: async () => {},
		});
		await assert.rejects(
			index.search({ attribute: 'query-rebuild', comparator: 'matches', value: 'shoe' }, {}),
			(error) => error.name === 'IndexRebuildingError'
		);
		assert.strictEqual(rebuilds, 1);
		await index.close();
		assert.strictEqual(closeAttempts, 2);
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
					return { limits: { maxSearchWindow: 10, maxTraceRecords: 10 } };
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
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index);
		await assert.rejects(
			index.search({ attribute: 'missing-hit-version', comparator: 'matches', value: 'shoe' }, {}),
			/without a source version/
		);
		await index.close();
	});

	it('keeps an in-flight reader alive while publishing a replacement reader', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-reader-lease';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		const firstSearch = Promise.withResolvers();
		const firstStarted = Promise.withResolvers();
		const closes = [0, 0];
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
			storePath: '/unused',
			storeName: 'unused',
			sourceGeneration: 'generation',
			limits: {},
			binding: {
				async runtimeInfo() {
					return { limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 } };
				},
				async openNativeFullTextReader() {
					const readerIndex = opens++;
					return {
						async search() {
							if (readerIndex === 0) {
								firstStarted.resolve();
								await firstSearch.promise;
							}
							return {
								total: 1,
								totalRelation: 'exact',
								hits: [{ id: nativeId(1, 'one'), version: '1', score: 1 }],
							};
						},
						async reload() {},
						async close() {
							closes[readerIndex]++;
						},
					};
				},
			},
		});
		const publication = attachCurrentCoverage(index);
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		const first = index.search(query, {}, { minResults: 1 });
		await firstStarted.promise;
		publication.publish();
		const second = await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(second.length, 1);
		assert.strictEqual(opens, 2);
		assert.strictEqual(closes[0], 0);
		firstSearch.resolve();
		await first;
		assert.strictEqual(closes[0], 1);
		await index.close();
		assert.strictEqual(closes[1], 1);
	});

	it('reads and returns highlights only for fields selected by the query', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-highlight-fields';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
		let bodyReads = 0;
		class CountedBlob extends Blob {
			async arrayBuffer() {
				bodyReads++;
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
					return { limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 } };
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
						async traceMatches(_request, records) {
							assert.deepStrictEqual(Object.keys(records[0].fields), ['title']);
							assert.strictEqual(records[0].fields.title, 'trail shoe');
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
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index);
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
					return { limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 } };
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
						async reload() {},
						async close() {},
					};
				},
			},
		});
		attachCurrentCoverage(index);
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

	it('reports bounded coverage and waits for current coverage when requested', async () => {
		const auditStore = sharedStore();
		const readinessId = 'query-coverage';
		publishDerivedIndexReadiness(auditStore, readinessId, 'ready');
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
					return { limits: { maxSearchWindow: 10_000, maxTraceRecords: 10 } };
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
						async reload() {},
						async close() {},
					};
				},
			},
		});
		index.attachDerivedHost({
			readiness: () => ({ state: 'ready' }),
			coverage: (maxLagMilliseconds) => ({
				state: 'bounded',
				maxLagMilliseconds,
				lagUpperBoundMilliseconds: 1,
			}),
			requestRebuild: () => true,
			publicationRevision: () => 0n,
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
