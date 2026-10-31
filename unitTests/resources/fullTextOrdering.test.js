const assert = require('node:assert');
const { compareKeys } = require('ordered-binary');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { fullTextDerivedIndexReadiness, setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { isFullTextSearchLimitError } = require('#src/resources/indexes/fullTextQueryProtocol');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
const { getFullTextTestConfiguration, setFullTextTestConfiguration } = require('./fullTextTestConfiguration');

async function collect(iterable) {
	const records = [];
	for await (const record of iterable) records.push(record);
	return records;
}
const ids = (records) => records.map(({ id }) => id);

describe('published full-text ordering and exact counts', () => {
	let Product;
	let previousConfiguration;
	let serial = 0;

	before(async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
	});
	beforeEach(async () => {
		previousConfiguration = getFullTextTestConfiguration();
		setFullTextNativeBindingForTests({
			binding: await loadFullTextNativeBinding(),
			closeTimeoutMilliseconds: 5000,
			shutdownTimeoutMilliseconds: 10000,
		});
	});
	afterEach(async () => {
		const runtime = Product?.derivedIndexRuntime;
		if (Product) Product.derivedIndexRuntime = undefined;
		try {
			if (runtime) await runtime.close();
		} finally {
			Product = undefined;
			setFullTextNativeBindingForTests(undefined);
			if (previousConfiguration) setFullTextTestConfiguration(previousConfiguration);
		}
	});

	async function seed(records, extraAttributes = []) {
		Product = table({
			database: `fulltext-ordering-${Date.now()}-${serial++}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'label', type: 'String' },
				{ name: 'price', type: 'Float' },
				{ name: 'active', type: 'Boolean' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
				...extraAttributes,
			],
			fullTextIndexes: [
				{
					name: 'catalogSearch',
					fields: [{ name: 'title', weight: 1, highlight: true }],
					analyzer: 'english@2',
					stopWords: true,
					positions: true,
					surfaceTerms: true,
					synonyms: [],
					highlighting: { maxFragments: 2, fragmentLength: 80 },
				},
			],
		});
		for (let start = 0; start < records.length; start += 250) await Product.put(records.slice(start, start + 250));
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
	}
	const condition = (extra = {}) => ({
		attribute: 'catalogSearch',
		comparator: 'matches',
		value: 'widget',
		maxIndexLagMilliseconds: 0,
		waitForIndexMilliseconds: 30000,
		...extra,
	});
	const query = (extra = {}) => ({ conditions: [condition()], ...extra });

	it('sorts all eligible rows before pagination using Harper string, number, Boolean and array semantics', async () => {
		await seed([
			{ id: 'a', title: 'widget', label: '\uE000', price: -3, active: true, tags: ['a', 'z'] },
			{ id: 'b', title: 'widget', label: '\u{10000}', price: -0, active: false, tags: ['a', 'b'] },
			{ id: 'c', title: 'widget', label: 'alpha', price: 4, active: true, tags: ['b'] },
			{ id: 'd', title: 'widget', label: null, price: null, active: null, tags: null },
			{ id: 'e', title: 'widget' },
		]);
		const relevance = await collect(Product.search(query()));
		for (const attribute of ['label', 'price', 'active', 'tags']) {
			for (const descending of [false, true]) {
				const sort = { attribute, descending };
				const expected = relevance
					.slice()
					.sort((a, b) =>
						descending ? compareKeys(b[attribute], a[attribute]) : compareKeys(a[attribute], b[attribute])
					);
				const actual = await collect(Product.search(query({ sort, offset: 1, limit: 2 })));
				assert.deepStrictEqual(ids(actual), ids(expected.slice(1, 3)), `${attribute}, descending=${descending}`);
				const ordinary = await collect(Product.search({ conditions: [{ attribute: 'title', value: 'widget' }], sort }));
				assert.deepStrictEqual(
					actual.map((record) => record[attribute]),
					ordinary.slice(1, 3).map((record) => record[attribute])
				);
			}
		}
	});

	it('supports linked sorts and keeps relevance ties stable without changing default iterable results', async () => {
		await seed([
			{ id: 'a', title: 'widget widget', label: 'same', price: 3 },
			{ id: 'b', title: 'widget extra words', label: 'same', price: 1 },
			{ id: 'c', title: 'widget', label: 'same', price: 2 },
		]);
		const baseline = await collect(Product.search(query()));
		const iterable = Product.search(query({ sort: { attribute: 'label' }, limit: 2 }));
		assert.strictEqual(typeof iterable[Symbol.asyncIterator], 'function');
		assert.deepStrictEqual(ids(await collect(iterable)), ids(baseline.slice(0, 2)));
		assert.deepStrictEqual(
			ids(
				await collect(
					Product.search(
						query({
							sort: { attribute: 'label', next: { attribute: 'price', descending: true } },
							limit: 2,
						})
					)
				)
			),
			['a', 'c']
		);
		const reusedSort = { attribute: 'price' };
		const pending = Product.search(query({ sort: reusedSort, limit: 2 }));
		reusedSort.attribute = 'label';
		assert.deepStrictEqual(ids(await collect(pending)), ['b', 'c']);
		assert.deepStrictEqual(ids(await collect(Product.search(query()))), ids(baseline));
	});

	it('applies companion predicates and row guards before a sorted window and follows updates', async () => {
		await seed(['a', 'b', 'c', 'd'].map((id, price) => ({ id, title: 'widget', price })));
		const target = {
			conditions: [condition(), { attribute: 'price', comparator: 'ge', value: 1 }],
			rowFilter: (record) => record.id !== 'd',
			sort: { attribute: 'price', descending: true },
			limit: 1,
			count: 'exact',
		};
		const before = await Product.search(target);
		assert.deepStrictEqual(ids(before), ['c']);
		assert.strictEqual(before.recordCount, 2);
		await Product.put('b', { title: 'widget', price: 5 });
		const after = await Product.search(target);
		assert.deepStrictEqual(ids(after), ['b']);
		assert.strictEqual(after.recordCount, 2);
	});

	it('counts every authorized match independently of page size, including zero-sized pages', async () => {
		await seed(['a', 'b', 'c', 'd'].map((id, price) => ({ id, title: 'widget', price })));
		for (const limit of [0, 1, 3]) {
			const page = await Product.search(query({ count: 'exact', limit, rowFilter: (record) => record.id !== 'a' }));
			assert.strictEqual(page.recordCount, 3, `limit=${limit}`);
			assert.strictEqual(page.recordCountExact, true);
			assert.strictEqual(page.length, Math.min(limit, 3));
			assert(page.every((record) => record.id !== 'a'));
		}
		await Product.delete('b');
		const page = await Product.search(query({ count: 'exact', limit: 1, rowFilter: (record) => record.id !== 'a' }));
		assert.strictEqual(page.recordCount, 2);
		assert.strictEqual(page.recordCountExact, true);
	});

	it('attaches highlights to the requested sorted page', async () => {
		await seed(['a', 'b', 'c'].map((id, price) => ({ id, title: 'widget', price })));
		const page = await Product.search({
			conditions: [condition({ includeHighlights: true })],
			sort: { attribute: 'price', descending: true },
			offset: 1,
			limit: 1,
			count: 'exact',
		});
		assert.deepStrictEqual(ids(page), ['b']);
		assert.strictEqual(page.recordCount, 3);
		assert(page[0].$highlights.title.length > 0);
	});

	it('keeps narrowed selection without redispatching a spreading application override', async () => {
		await seed(['a', 'b', 'c', 'd'].map((id, price) => ({ id, title: 'widget', price })));
		let searches = 0;
		Product = class extends Product {
			search(target) {
				searches++;
				return super.search({ ...target });
			}
		};
		setFullTextTestConfiguration({ ...previousConfiguration, maxRawHitsPerRequest: 2, maxResultsPerRequest: 2 });
		const page = await Product.search(query({ count: 'exact', limit: 1, select: ['id', 'price'] }));
		assert.strictEqual(searches, 1);
		assert.strictEqual(page.length, 1);
		assert.strictEqual(page.recordCount, null);
		assert.deepStrictEqual(Object.keys(page[0]).sort(), ['id', 'price']);
	});

	it('preserves the highlighted page when optional tail counting exhausts its own deadline', async () => {
		await seed(['a', 'b', 'c'].map((id) => ({ id, title: 'widget' })));
		let incomplete = 0;
		const entries = await Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
			condition({ includeHighlights: true }),
			undefined,
			{
				minResults: 1,
				exhaustive: true,
				countBudgetMilliseconds: 0,
				onIncompleteCount: () => {
					incomplete++;
				},
			}
		);
		assert.strictEqual(incomplete, 1);
		assert.strictEqual(entries.length, 1);
		assert(entries[0].$highlights.title.length > 0);
	});

	it('propagates cancellation from stored ordering instead of returning results', async () => {
		await seed(['a', 'b', 'c'].map((id) => ({ id, title: 'widget' })));
		const controller = new AbortController();
		const reason = new Error('cancel stored ordering');
		let ordered = 0;
		let incomplete = 0;
		await assert.rejects(
			Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
				condition({ includeHighlights: true }),
				{ signal: controller.signal },
				{
					minResults: 1,
					exhaustive: true,
					orderResults(entries) {
						assert.strictEqual(entries.length, 3);
						ordered++;
						controller.abort(reason);
					},
					onIncompleteCount() {
						incomplete++;
					},
				}
			),
			(error) => error === reason
		);
		assert.strictEqual(ordered, 1);
		assert.strictEqual(incomplete, 0);
	});

	it('propagates cancellation during optional counting after securing the highlighted page', async () => {
		await seed(['a', 'b', 'c'].map((id) => ({ id, title: 'widget' })));
		const controller = new AbortController();
		const reason = new Error('cancel optional count tail');
		let candidates = 0;
		let incomplete = 0;
		await assert.rejects(
			Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
				condition({ includeHighlights: true }),
				{ signal: controller.signal },
				{
					minResults: 1,
					exhaustive: true,
					countBudgetMilliseconds: 30000,
					filter() {
						if (++candidates === 2) controller.abort(reason);
						return true;
					},
					onIncompleteCount() {
						incomplete++;
					},
				}
			),
			(error) => error === reason
		);
		assert(candidates >= 2);
		assert.strictEqual(incomplete, 0);
	});

	it('fails complete sorting at the work ceiling but preserves bounded exact-count pages with unknown totals', async () => {
		await seed(['a', 'b', 'c', 'd'].map((id, price) => ({ id, title: 'widget', price })));
		setFullTextTestConfiguration({ ...previousConfiguration, maxRawHitsPerRequest: 2, maxResultsPerRequest: 2 });
		await assert.rejects(
			async () => collect(Product.search(query({ sort: { attribute: 'price' }, limit: 1 }))),
			(error) =>
				isFullTextSearchLimitError(error) && error.constructor.name === 'ClientError' && error.statusCode === 400
		);
		assert.deepStrictEqual(await collect(Product.search(query({ sort: { attribute: 'price' }, limit: 0 }))), []);
		await assert.rejects(
			async () => collect(Product.search(query({ sort: { attribute: 'missing' }, limit: 0 }))),
			(error) => error.statusCode === 400
		);
		const emptyCount = await Product.search(query({ sort: { attribute: 'price' }, limit: 0, count: 'exact' }));
		assert.strictEqual(emptyCount.length, 0);
		assert.strictEqual(emptyCount.recordCount, null);
		assert.strictEqual(emptyCount.recordCountExact, false);
		let policyCalls = 0;
		await assert.rejects(
			async () =>
				collect(
					Product.search(
						query({
							sort: { attribute: 'price' },
							limit: 1,
							rowFilter: () => {
								policyCalls++;
								return true;
							},
						})
					)
				),
			(error) =>
				isFullTextSearchLimitError(error) &&
				error.statusCode === 400 &&
				/maxRawHitsPerRequest/.test(error.message) &&
				!error.message.includes('4')
		);
		assert.strictEqual(policyCalls, 0);
		const page = await Product.search(query({ count: 'exact', limit: 1 }));
		assert.strictEqual(page.length, 1);
		assert.strictEqual(page.recordCount, null);
		assert.strictEqual(page.recordCountExact, false);
	});
	it('preserves satisfiable filtered pages when optional count replay exceeds its budget', async () => {
		await seed(Array.from({ length: 100 }, (_, index) => ({ id: `record-${index}`, title: 'widget' })));
		const baseline = await collect(Product.search(query({ limit: 100 })));
		const allowedId = baseline[32].id;
		setFullTextTestConfiguration({ ...previousConfiguration, maxRawHitsPerRequest: 100, maxResultsPerRequest: 100 });
		const target = query({ limit: 1, rowFilter: (record) => record.id === allowedId });
		assert.deepStrictEqual(ids(await collect(Product.search(target))), [allowedId]);
		const page = await Product.search({ ...target, count: 'exact' });
		assert.deepStrictEqual(ids(page), [allowedId]);
		assert.strictEqual(page.recordCount, null);
		assert.strictEqual(page.recordCountExact, false);
	});

	it('does not swallow application errors that share native busy error codes during counting', async () => {
		await seed(['a', 'b', 'c'].map((id) => ({ id, title: 'widget' })));
		const baseline = await collect(Product.search(query()));
		for (const code of ['E_TIMEOUT', 'E_QUEUE_FULL', 'E_RESOURCE_LIMIT']) {
			const failure = Object.assign(new Error('Application row policy failed'), { code });
			await assert.rejects(
				async () =>
					Product.search(
						query({
							limit: 1,
							count: 'exact',
							rowFilter: (record) => {
								if (record.id === baseline[1].id) throw failure;
								return true;
							},
						})
					),
				(error) => error.statusCode === 503
			);
		}
	});
	it('preserves pages and completes selective ordering and counting beyond the native offset window', async () => {
		const info = await (await loadFullTextNativeBinding()).runtimeInfo();
		const count = info.limits.maxSearchWindow + 5;
		await seed(
			Array.from({ length: count }, (_, index) => ({
				id: `record-${String(index).padStart(6, '0')}`,
				title: 'widget',
				price: index,
			}))
		);
		setFullTextTestConfiguration({
			...previousConfiguration,
			maxRawHitsPerRequest: count * 4,
			maxResultsPerRequest: count * 2,
			requestBudgetMilliseconds: 30000,
		});
		const target = query({ offset: info.limits.maxSearchWindow, limit: 2 });
		const baseline = await collect(Product.search(target));
		assert.strictEqual(baseline.length, 2);
		const page = await Product.search({ ...target, count: 'exact' });
		assert.deepStrictEqual(ids(page), ids(baseline));
		if (page.recordCountExact) assert.strictEqual(page.recordCount, count);
		else assert.strictEqual(page.recordCount, null);
		setFullTextTestConfiguration({
			...previousConfiguration,
			maxRawHitsPerRequest: count * 4,
			maxResultsPerRequest: 10,
			requestBudgetMilliseconds: 30000,
		});
		const tailIds = new Set(ids(baseline));
		const selective = query({
			conditions: [condition(), { attribute: 'price', comparator: 'ge', value: 0 }],
			rowFilter: (record) => tailIds.has(record.id),
			limit: 1,
		});
		const ordered = await collect(Product.search({ ...selective, sort: { attribute: 'price', descending: true } }));
		assert.deepStrictEqual(
			ids(ordered),
			ids(
				baseline
					.slice()
					.sort((a, b) => b.price - a.price)
					.slice(0, 1)
			)
		);
		const counted = await Product.search({ ...selective, count: 'exact' });
		assert.strictEqual(counted.length, 1);
		assert.strictEqual(counted.recordCount, 2);
		assert.strictEqual(counted.recordCountExact, true);
	});

	it('traces only the visible page while retaining all real index entries for counting and ordering', async () => {
		await seed(['a', 'b', 'c'].map((id) => ({ id, title: 'widget' })));
		await collect(Product.search(query({ limit: 1 })));
		const index = Product.fullTextQueryIndexes.catalogSearch.customIndex;
		for (const ordered of [false, true]) {
			let incomplete = false;
			const entries = await index.search(condition({ includeHighlights: true }), undefined, {
				minResults: 2,
				resultOffset: 1,
				exhaustive: true,
				...(ordered
					? { orderResults: (entries) => entries.reverse() }
					: {
							countBudgetMilliseconds: 30000,
							onIncompleteCount: () => {
								incomplete = true;
							},
						}),
			});
			assert.strictEqual(entries.length, 3);
			assert.strictEqual(incomplete, false);
			assert.strictEqual(entries[0].$highlights, undefined);
			assert(entries[1].$highlights.title.length > 0);
			assert.strictEqual(entries[2].$highlights, undefined);
		}
		const emptyPage = await index.search(condition({ includeHighlights: true }), undefined, {
			minResults: 0,
			exhaustive: true,
			countBudgetMilliseconds: 30000,
			onIncompleteCount() {},
		});
		assert.strictEqual(emptyPage.length, 3);
		assert(emptyPage.every((entry) => entry.$highlights === undefined));
	});
	it('validates linked sort width and stored-field eligibility before evaluating text matches', async () => {
		const Related = table({
			database: `fulltext-ordering-related-${Date.now()}-${serial++}`,
			table: 'Related',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		await seed(
			[
				{ id: 'a', title: 'widget', price: 2 },
				{ id: 'b', title: 'widget', price: 1 },
			],
			[
				{ name: 'computed', type: 'String', computed: true },
				{ name: 'expression', type: 'String', computed: {}, computedFromExpression: 'title.toUpperCase()' },
				{ name: 'blob', type: 'Blob' },
				{ name: 'relatedId', type: 'ID' },
				{ name: 'related', type: 'Related', relationship: { from: 'relatedId' }, definition: { tableClass: Related } },
			]
		);
		Product.setComputedAttribute('computed', (record) => record.title);
		const linked = (width) =>
			Array.from({ length: width }).reduceRight((next) => ({ attribute: 'price', next }), undefined);
		assert.deepStrictEqual(ids(await collect(Product.search(query({ sort: linked(32) })))), ['b', 'a']);
		for (const value of ['widget', 'absent']) {
			await assert.rejects(
				async () => collect(Product.search(query({ conditions: [condition({ value })], sort: linked(33) }))),
				(error) => error.statusCode === 400 && /at most 32/.test(error.message)
			);
			for (const attribute of ['computed', 'expression', 'blob', 'related', ['title', 'nested'], 'catalogSearch'])
				await assert.rejects(
					async () => collect(Product.search(query({ conditions: [condition({ value })], sort: { attribute } }))),
					(error) => error.statusCode === 400 && /directly stored/.test(error.message)
				);
		}
	});

	it('rejects vector-distance ordering even when the text query has no matches', async () => {
		await seed([{ id: 'a', title: 'widget' }], [{ name: 'vector', type: 'Array', indexed: { type: 'HNSW' } }]);
		assert.strictEqual(typeof Product.indices.vector.customIndex.exactDistance, 'function');
		for (const value of ['widget', 'absent'])
			await assert.rejects(
				async () =>
					collect(
						Product.search({
							conditions: [condition({ value })],
							limit: 1,
							sort: { attribute: 'vector', target: [1, 0], distance: 'cosine' },
						})
					),
				(error) => error.statusCode === 400 && /vector.distance|directly stored/.test(error.message)
			);
	});

	it('keeps vector-filter count requests on the bounded row-policy path', async () => {
		await seed(Array.from({ length: 40 }, (_, index) => ({ id: `record-${index}`, title: 'widget' })));
		let policyCalls = 0;
		const target = query({
			limit: 1,
			vectorFilter: () => true,
			rowFilter: () => {
				policyCalls++;
				return true;
			},
		});
		const baseline = await collect(Product.search(target));
		const boundedCalls = policyCalls;
		assert(boundedCalls > 0);
		policyCalls = 0;
		const counted = await Product.search({ ...target, count: 'exact' });
		assert.deepStrictEqual(ids(counted), ids(baseline));
		assert.strictEqual(policyCalls, boundedCalls);
		assert.strictEqual(counted.recordCount, null);
		assert.strictEqual(counted.recordCountExact, false);
	});
	it('proves exhaustion at the retained ceiling without retaining filtered tail rows', async () => {
		await seed(Array.from({ length: 600 }, (_, price) => ({ id: `record-${price}`, title: 'widget', price })));
		const baseline = await collect(Product.search(query({ limit: 600 })));
		const allowed = new Set(ids(baseline.slice(0, 2)));
		setFullTextTestConfiguration({ ...previousConfiguration, maxRawHitsPerRequest: 2000, maxResultsPerRequest: 2 });
		const examined = new Set();
		const target = query({
			limit: 1,
			rowFilter(record) {
				examined.add(record.id);
				return allowed.has(record.id);
			},
		});
		assert.deepStrictEqual(ids(await collect(Product.search(target))), [baseline[0].id]);
		assert.deepStrictEqual([...examined], [baseline[0].id]);
		const sorted = await collect(Product.search({ ...target, sort: { attribute: 'price', descending: true } }));
		assert.deepStrictEqual(ids(sorted), [baseline.slice(0, 2).sort((a, b) => b.price - a.price)[0].id]);
		for (const limit of [0, 1]) {
			const counted = await Product.search({ ...target, limit, count: 'exact' });
			assert.strictEqual(counted.length, limit);
			assert.strictEqual(counted.recordCount, 2);
			assert.strictEqual(counted.recordCountExact, true);
		}

		allowed.add(baseline[500].id);
		await assert.rejects(
			async () => collect(Product.search({ ...target, sort: { attribute: 'price' } })),
			(error) => isFullTextSearchLimitError(error) && /maxResultsPerRequest/.test(error.message)
		);
		const overflow = await Product.search({ ...target, count: 'exact' });
		assert.deepStrictEqual(ids(overflow), [baseline[0].id]);
		assert.strictEqual(overflow.recordCount, null);
		assert.strictEqual(overflow.recordCountExact, false);

		allowed.delete(baseline[500].id);
		setFullTextTestConfiguration({ ...previousConfiguration, maxRawHitsPerRequest: 600, maxResultsPerRequest: 2 });
		await assert.rejects(
			async () => collect(Product.search({ ...target, sort: { attribute: 'price' } })),
			(error) => isFullTextSearchLimitError(error) && /maxRawHitsPerRequest/.test(error.message)
		);
		const bounded = await Product.search({ ...target, count: 'exact' });
		assert.deepStrictEqual(ids(bounded), [baseline[0].id]);
		assert.strictEqual(bounded.recordCount, null);
		assert.strictEqual(bounded.recordCountExact, false);
	});

	it('observes cancellation after securing page highlights before examining the count tail', async () => {
		await seed(['a', 'b', 'c'].map((id) => ({ id, title: 'widget' })));
		const controller = new AbortController();
		const reason = new Error('cancel while securing page highlights');
		let candidates = 0;
		let incomplete = 0;
		await assert.rejects(
			Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
				condition({ includeHighlights: true }),
				{ signal: controller.signal },
				{
					minResults: 1,
					exhaustive: true,
					countBudgetMilliseconds: 30000,
					filter() {
						if (++candidates === 1) queueMicrotask(() => controller.abort(reason));
						return true;
					},
					onIncompleteCount() {
						incomplete++;
					},
				}
			),
			(error) => error === reason
		);
		assert.strictEqual(candidates, 1);
		assert.strictEqual(incomplete, 0);
	});

	it('stops source reads after cancellation during candidate-gate planning', async () => {
		await seed([{ id: 'a', title: 'widget' }]);
		const controller = new AbortController();
		const reason = new Error('cancel after candidate gate');
		let candidates = 0;
		await assert.rejects(
			Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
				condition(),
				{ signal: controller.signal },
				{
					minResults: 1,
					candidateKeys: {
						estimatedCount: Number.MAX_SAFE_INTEGER,
						get probe() {
							queueMicrotask(() => controller.abort(reason));
							return undefined;
						},
						collect() {
							assert.fail('the broad candidate plan should not be collected');
						},
					},
					filter() {
						candidates++;
						return true;
					},
				}
			),
			(error) => error === reason
		);
		assert.strictEqual(candidates, 0);
	});

	for (const sameSourceBatch of [false, true]) {
		for (const optionalCount of [false, true]) {
			it(`stops native tracing and source hydration after cancellation between real ${sameSourceBatch ? 'query leaves' : 'trace batches'} (${optionalCount ? 'optional count' : 'page'})`, async () => {
				const binding = await loadFullTextNativeBinding();
				const batchSize = (await binding.runtimeInfo()).limits.maxTraceRecords;
				const count = sameSourceBatch ? 1 : batchSize * 2 + 1;
				const controller = new AbortController();
				const reason = new Error('cancel after first native trace batch');
				let traceCalls = 0;
				let sourceReads = 0;
				let tracedReader;
				const closedReaders = new Set();
				const restores = [];
				setFullTextNativeBindingForTests({
					binding: {
						...binding,
						async openNativeFullTextReader(options) {
							const reader = await binding.openNativeFullTextReader(options);
							const original = reader.traceMatches;
							const originalClose = reader.close;
							reader.close = async function (...args) {
								const result = await originalClose.apply(this, args);
								closedReaders.add(reader);
								return result;
							};
							reader.traceMatches = async function (...args) {
								tracedReader = reader;
								const result = await original.apply(this, args);
								assert.strictEqual(result.complete, true);
								if (++traceCalls === 1) controller.abort(reason);
								return result;
							};
							restores.push(() => {
								reader.traceMatches = original;
								reader.close = originalClose;
							});
							return reader;
						},
					},
					closeTimeoutMilliseconds: 5000,
					shutdownTimeoutMilliseconds: 10000,
				});
				try {
					await seed(Array.from({ length: count }, (_, index) => ({ id: `trace-${index}`, title: 'widget' })));
					await assert.rejects(
						Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
							condition({
								includeHighlights: true,
								...(sameSourceBatch
									? {
											fullTextLeaves: [
												{ text: 'widget', mode: 'any', fields: ['title'] },
												{ text: 'widget', mode: 'any', fields: ['title'] },
											],
										}
									: null),
							}),
							{ signal: controller.signal },
							{
								minResults: count,
								...(optionalCount
									? { exhaustive: true, onIncompleteCount: () => assert.fail('abort is not an incomplete count') }
									: null),
								filter(key, entry) {
									Object.defineProperty(entry.value, 'title', {
										configurable: true,
										get() {
											sourceReads++;
											return 'widget';
										},
									});
									return true;
								},
							}
						),
						(error) => error === reason
					);
					assert.deepStrictEqual(
						{ traceCalls, sourceReads },
						{ traceCalls: 1, sourceReads: count + Math.min(count, batchSize) }
					);
					const runtime = Product.derivedIndexRuntime;
					Product.derivedIndexRuntime = undefined;
					let closed = false;
					let retired = false;
					const closing = Product.fullTextQueryIndexes.catalogSearch.customIndex.close();
					closing.then(
						() => {
							closed = true;
						},
						() => {
							closed = true;
						}
					);
					try {
						await waitFor(() => closed, 5000);
						await closing;
						assert(closedReaders.has(tracedReader));
						retired = true;
					} finally {
						const cleanup = runtime.close();
						if (retired) await cleanup;
						else void cleanup.catch(() => undefined);
					}
				} finally {
					for (const restore of restores) restore();
				}
			});
		}
	}

	it('discards count-only tail entries after an advisory count becomes incomplete', async () => {
		await seed(['a', 'b', 'c', 'd'].map((id) => ({ id, title: 'widget' })));
		await collect(Product.search(query({ limit: 1 })));
		setFullTextTestConfiguration({ ...previousConfiguration, maxRawHitsPerRequest: 2, maxResultsPerRequest: 2 });
		let incomplete = 0;
		const entries = await Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
			condition({ includeHighlights: true }),
			undefined,
			{
				minResults: 1,
				exhaustive: true,
				countBudgetMilliseconds: 30000,
				onIncompleteCount: () => {
					incomplete++;
				},
			}
		);
		assert.strictEqual(incomplete, 1);
		assert.strictEqual(entries.length, 1);
		assert(entries[0].$highlights.title.length > 0);
	});
});
