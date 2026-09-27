require('../testUtils');
const assert = require('node:assert');
const { toBufferKey } = require('ordered-binary');
const { publishDerivedIndexReadiness } = require('#src/resources/derivedIndexRuntime');
const { FullTextQueryIndex } = require('#src/resources/indexes/fullTextQueryIndex');

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
					complete: true,
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

		traces.length = 0;
		const paged = await index.search(condition, {}, { minResults: 2, resultOffset: 1 });
		assert.strictEqual(traces.length, 1);
		assert.strictEqual(traces[0].records[0].id, nativeId(tableId, 'two'));
		assert.strictEqual(paged[0].$highlights, undefined);
		assert(paged[1].$highlights);

		await index.search(condition, {}, { minResults: 1 });
		assert.strictEqual(reloads, 0);
		const publication = auditStore.buffers.get(`derived-index:${readinessId}:publication`);
		Atomics.add(new BigInt64Array(publication), 0, 1n);
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
		const query = { attribute: readinessId, comparator: 'matches', value: 'shoe' };
		await index.search(query, {}, { minResults: 1 });
		index.updateDefinition({ ...definition(), fields: [{ name: 'title', weight: 7, highlight: true }] });
		await index.search(query, {}, { minResults: 1 });
		assert.strictEqual(opens.length, 2);
		assert.strictEqual(opens[1].fields[0].weight, 7);

		const publication = auditStore.buffers.get(`derived-index:${readinessId}:publication`);
		Atomics.add(new BigInt64Array(publication), 0, 1n);
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
						async search() {
							searches++;
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
		const query = { attribute: 'query-window', comparator: 'matches', value: 'shoe' };
		assert.deepStrictEqual(await index.search(query, {}, { minResults: 0 }), []);
		assert.strictEqual(searches, 0);
		await assert.rejects(index.search(query, {}, { minResults: 3 }), /reduce offset or limit/);
		assert.strictEqual(searches, 0);
		await assert.rejects(index.search(query, {}), /exceeds the 2-result search window/);
		await index.close();
	});
});
