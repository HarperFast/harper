'use strict';

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { fullTextDerivedIndexReadiness, setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { parseQuery } = require('#src/resources/search');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');

async function collect(iterable) {
	const values = [];
	for await (const value of iterable) values.push(value);
	return values;
}

function ids(records) {
	return records.map(({ id }) => id).sort();
}

function definition(name, fields) {
	return {
		name,
		fields,
		analyzer: 'english@2',
		stopWords: true,
		positions: true,
		surfaceTerms: true,
		synonyms: [],
	};
}

describe('published native full-text Table.search integration', () => {
	let Product;

	before(async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
	});

	beforeEach(async () => {
		const binding = await loadFullTextNativeBinding();
		setFullTextNativeBindingForTests({
			binding,
			closeTimeoutMilliseconds: 5_000,
			shutdownTimeoutMilliseconds: 10_000,
		});
	});

	afterEach(async () => {
		const runtime = Product?.derivedIndexRuntime;
		if (Product) Product.derivedIndexRuntime = undefined;
		if (runtime) await runtime.close();
		Product = undefined;
		setFullTextNativeBindingForTests(undefined);
	});

	it('continues immutable full-text pages while applying current row filters', async () => {
		Product = table({
			database: `fulltext-native-continuation-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'allowed', type: 'Boolean' },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1, highlight: false }])],
		});
		for (let n = 0; n < 35; n++)
			await Product.put(String(n).padStart(3, '0'), { title: 'widget', allowed: n % 3 === 0 });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const base = {
			conditions: [
				{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget', waitForIndexMilliseconds: 5000 },
			],
			limit: 4,
		};
		const first = await Product.search({ ...base, continuation: true, rowFilter: (record) => record.allowed });
		assert(Array.isArray(first));
		assert.strictEqual(first.length, 4);
		assert.strictEqual(first.complete, false);
		assert(first.continuation);
		assert(first.expiresAt > Date.now());
		assert.strictEqual(JSON.stringify(first).includes('continuation'), false);
		const token = first.continuation;
		await Product.put('new', { title: 'widget widget widget', allowed: true });
		const second = await Product.search({ ...base, continuation: token, rowFilter: (record) => record.allowed });
		const replay = await Product.search({ ...base, continuation: token, rowFilter: (record) => record.allowed });
		assert.deepStrictEqual(ids(replay), ids(second));
		const seen = new Set([...ids(first), ...ids(second)]);
		let next = second.continuation;
		while (next) {
			const page = await Product.search({ ...base, continuation: next, rowFilter: (record) => record.allowed });
			for (const record of page) {
				assert(!seen.has(record.id));
				seen.add(record.id);
			}
			next = page.continuation;
			if (!next) {
				assert.strictEqual(page.complete, true);
				assert.strictEqual(page.expiresAt, undefined);
			}
		}
		assert.strictEqual(seen.size, 12);
		assert(!seen.has('new'));
		await assert.rejects(Product.search({ ...base, continuation: token }), (error) => error.statusCode === 410);
		const beforeClose = await Product.search({ ...base, continuation: true });
		await Product.fullTextQueryIndexes.catalogSearch.customIndex.close();
		await assert.rejects(
			Product.search({ ...base, continuation: beforeClose.continuation }),
			(error) => error.statusCode === 410
		);
	});

	it('admits sixteen concurrent retained searches when the configured pool is raised', async () => {
		const env = require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		const pages = [];
		const query = {
			conditions: [
				{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget', waitForIndexMilliseconds: 5000 },
			],
			limit: 1,
		};
		try {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { ...previous, maxCursors: 16 });
			Product = table({
				database: `fulltext-concurrency-${Date.now()}`,
				table: 'Product',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
				],
				fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
			});
			await Product.put('one', { title: 'widget' });
			await Product.put('two', { title: 'widget' });
			await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
			const results = await Promise.allSettled(
				Array.from({ length: 16 }, () => Product.search({ ...query, continuation: true }))
			);
			for (const result of results) if (result.status === 'fulfilled') pages.push(result.value);
			assert.strictEqual(pages.length, 16, JSON.stringify(results.filter(({ status }) => status === 'rejected')));
			assert.strictEqual(new Set(pages.map(({ continuation }) => continuation)).size, 16);
			for (const page of pages) {
				assert.strictEqual(page.length, 1);
				assert(page.continuation);
			}
		} finally {
			try {
				await Promise.all(
					pages.map((page) => Product.search({ ...query, continuation: page.continuation, closeContinuation: true }))
				);
			} finally {
				env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
			}
		}
	});

	it('continues batch-aligned pages within a one-hit raw budget', async function () {
		this.timeout(15000);
		const env = require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		try {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { ...previous, maxRawHitsPerRequest: 1 });
			Product = table({
				database: `fulltext-single-hit-${Date.now()}`,
				table: 'Product',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
				],
				fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
			});
			for (const id of ['a', 'b', 'c']) await Product.put(id, { title: 'widget' });
			await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 10000);
			const seen = [];
			let continuation = true;
			for (let pageNumber = 0; continuation && pageNumber < 4; pageNumber++) {
				const page = await Product.search({
					conditions: [
						{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget', waitForIndexMilliseconds: 5000 },
					],
					limit: 1,
					continuation,
				});
				assert.strictEqual(page.length, 1);
				seen.push(...ids(page));
				continuation = page.continuation;
			}
			assert.strictEqual(continuation, undefined);
			assert.deepStrictEqual(seen.sort(), ['a', 'b', 'c']);
		} finally {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
		}
	});

	it('continues through coerced BigInt filters with closeContinuation disabled', async () => {
		Product = table({
			database: `fulltext-native-bigint-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'rank', type: 'BigInt', indexed: true },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1, highlight: false }])],
		});
		for (const id of ['a', 'b']) await Product.put(id, { title: 'widget', rank: 9007199254740993n });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const query = {
			conditions: [
				{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget' },
				{ attribute: 'rank', comparator: 'equals', value: '9007199254740993' },
			],
			limit: 1,
			closeContinuation: false,
		};
		assert.strictEqual((await collect(Product.search(query))).length, 1);
		const first = await Product.search({ ...query, continuation: true });
		assert(first.continuation);
		const second = await Product.search({ ...query, continuation: first.continuation });
		assert.deepStrictEqual(ids([...first, ...second]), ['a', 'b']);
		assert.strictEqual(second.complete, true);
	});

	it('validates continuation options and query binding and allows explicit close through REST syntax', async () => {
		Product = table({
			database: `fulltext-native-continuation-close-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1, highlight: false }])],
		});
		await Product.put('a', { title: 'widget' });
		await Product.put('b', { title: 'widget' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const base = { conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget' }], limit: 1 };
		let allow = true;
		let checks = 0;
		class AsyncAllowedProduct extends Product {
			allowRead() {
				checks++;
				return Promise.resolve(allow);
			}
		}
		class AsyncDeniedProduct extends Product {
			allowRead() {
				return Promise.resolve(false);
			}
		}
		const policyContext = { user: { username: 'policy-reader', role: { permission: { super_user: true } } } };
		const allowedResource = new AsyncAllowedProduct(null, policyContext);
		const sharedTarget = { ...base, continuation: true, checkPermission: true };
		const authorized = await allowedResource.search(sharedTarget);
		assert.strictEqual(authorized.length, 1);
		assert(authorized.continuation);
		assert.strictEqual(sharedTarget.checkPermission, true);
		sharedTarget.continuation = authorized.continuation;
		allow = false;
		await assert.rejects(allowedResource.search(sharedTarget), (error) => error.statusCode === 403);
		allow = true;

		await allowedResource.search({
			...base,
			continuation: authorized.continuation,
			closeContinuation: true,
			checkPermission: true,
		});
		await assert.rejects(
			new AsyncDeniedProduct(null, { user: { username: 'policy-reader' } }).search({
				...base,
				continuation: true,
				checkPermission: true,
			}),
			(error) => error.statusCode === 403
		);
		assert.strictEqual(checks, 3);
		let syncAllow = true;
		class SyncProduct extends Product {
			allowRead() {
				return syncAllow;
			}
		}
		const syncResource = new SyncProduct(null, policyContext);
		const syncTarget = { ...base, continuation: true, checkPermission: true };
		const syncPage = await syncResource.search(syncTarget);
		assert.strictEqual(syncTarget.checkPermission, true);
		syncTarget.continuation = syncPage.continuation;
		syncAllow = false;
		await assert.rejects(syncResource.search(syncTarget), (error) => error.statusCode === 403);
		syncAllow = true;
		await syncResource.search({ ...syncTarget, closeContinuation: true });
		const first = await Product.search({ ...base, continuation: true });
		assert(first.continuation);
		assert.deepStrictEqual(first.getColumns(), ['id', 'title']);
		const changed = { ...base, select: ['id'], continuation: first.continuation };
		await assert.rejects(Product.search(changed), (error) => error.statusCode === 410);
		for (const invalid of [
			{ limit: 0 },
			{ offset: 1 },
			{ count: 'exact' },
			{ limit: require('#src/resources/indexes/fullTextSearchLimits').DEFAULT_FULL_TEXT_SEARCH_LIMITS.maxPageSize + 1 },
		])
			await assert.rejects(
				Product.search({ ...base, continuation: true, ...invalid }),
				(error) => error.statusCode === 400
			);
		const parsed = parseQuery(
			`catalogSearch=matches=widget&limit(1)&continuation(${first.continuation})&closeContinuation()`
		);
		assert.strictEqual(parsed.continuation, first.continuation);
		const closed = await Product.search(parsed);
		assert.strictEqual(closed.length, 0);
		assert.strictEqual(closed.complete, true);
		const groupedQuery = '(catalogSearch=matches=widget|catalogSearch=matches=missing)&limit(1)';
		const grouped = await Product.search(parseQuery(`${groupedQuery}&continuation()`));
		assert.strictEqual(grouped.length, 1);
		assert(grouped.continuation);
		const groupedNext = await Product.search(parseQuery(`${groupedQuery}&continuation(${grouped.continuation})`));
		assert.strictEqual(groupedNext.length, 1);
		assert.notStrictEqual(groupedNext[0].id, grouped[0].id);
		if (groupedNext.continuation)
			await Product.search(parseQuery(`${groupedQuery}&continuation(${groupedNext.continuation})&closeContinuation()`));
		await assert.rejects(
			Product.search({ ...base, continuation: first.continuation }),
			(error) => error.statusCode === 410
		);
	});

	it('binds a continuation to its database even when table IDs and definitions match', async () => {
		let other;
		try {
			const make = (database) =>
				table({
					database,
					table: 'Product',
					audit: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						{ name: 'title', type: 'String' },
					],
					fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
				});
			Product = make(`fulltext-scope-a-${Date.now()}`);
			other = make(`fulltext-scope-b-${Date.now()}`);
			assert.strictEqual(other.tableId, Product.tableId);
			for (const resource of [Product, other]) {
				await resource.put('one', { title: 'widget' });
				await resource.put('two', { title: 'widget' });
				await waitFor(() => fullTextDerivedIndexReadiness(resource, 'catalogSearch').state === 'ready', 30000);
			}
			const query = {
				conditions: [
					{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget', waitForIndexMilliseconds: 5000 },
				],
				limit: 1,
			};
			const first = await Product.search({ ...query, continuation: true });
			assert(first.continuation);
			await assert.rejects(
				other.search({ ...query, continuation: first.continuation }),
				(error) => error.statusCode === 410
			);
			await Product.search({ ...query, continuation: first.continuation, closeContinuation: true });
		} finally {
			await other?.derivedIndexRuntime?.close();
		}
	});

	it('executes every query mode, negation, REST syntax, field selection, and same-index OR', async () => {
		const searchDefinition = definition('catalogSearch', [
			{ name: 'title', weight: 2, highlight: true },
			{ name: 'description', weight: 1, highlight: true },
			{ name: 'tags', weight: 1, highlight: false },
		]);
		searchDefinition.highlighting = { maxFragments: 2, fragmentLength: 80 };
		Product = table({
			database: `fulltext-native-search-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'description', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [searchDefinition],
		});
		await Product.put('one', { title: 'Waterproof Trail Running Shoes', tags: ['outdoor', 'trail'] });
		await Product.put('two', { title: 'Waterproof Road Shoes', tags: ['outdoor', 'road'] });
		await Product.put('three', { title: 'Wireless Headphones', tags: ['electronics'] });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30_000);

		const search = (comparator, value, options = {}) =>
			collect(
				Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator,
							value,
							maxIndexLagMilliseconds: 0,
							waitForIndexMilliseconds: 30_000,
							...options.condition,
						},
					],
					...options.query,
				})
			);

		const cases = [
			['matches', 'trail headphones', ['one', 'three']],
			['matches_all', 'waterproof shoes', ['one', 'two']],
			['matches_phrase', 'trail running', ['one']],
			['matches_prefix', 'waterproof trai', ['one']],
			['matches_fuzzy', 'waterprof', ['one', 'two']],
			['matches_fuzzy_prefix', 'waterproof tral', ['one']],
		];
		for (const [comparator, value, expected] of cases) {
			let records;
			try {
				records = await search(comparator, value);
			} catch (error) {
				error.message += ` (${comparator})`;
				throw error;
			}
			assert.deepStrictEqual(ids(records), expected, comparator);
		}

		const negatedCases = [
			['not_matches', 'trail'],
			['not_matches_all', 'trail running'],
			['not_matches_phrase', 'trail running'],
			['not_matches_prefix', 'waterproof trai'],
			['not_matches_fuzzy', 'trail'],
			['not_matches_fuzzy_prefix', 'waterproof tral'],
		];
		for (const [comparator, value] of negatedCases) {
			const records = await collect(
				Product.search({
					operator: 'and',
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator: 'matches',
							value: 'waterproof',
							maxIndexLagMilliseconds: 0,
							waitForIndexMilliseconds: 30_000,
						},
						{ attribute: 'catalogSearch', comparator, value },
					],
				})
			);
			assert.deepStrictEqual(ids(records), ['two'], comparator);
		}

		assert.deepStrictEqual(ids(await search('matches', 'waterproof', { condition: { fields: ['tags'] } })), []);
		const [highlighted] = await search('matches_phrase', 'trail running', {
			condition: { includeHighlights: true },
			query: { select: ['title', '$score', '$highlights'] },
		});
		assert.strictEqual(typeof highlighted.$score, 'number');
		assert.deepStrictEqual(highlighted.$highlights.title[0].spans, [{ start: 11, end: 24 }]);
		assert.strictEqual(highlighted.$highlights.description, undefined);

		const orResults = await collect(
			Product.search({
				operator: 'or',
				conditions: [
					{ attribute: 'catalogSearch', comparator: 'matches_phrase', value: 'trail running' },
					{ attribute: 'catalogSearch', comparator: 'matches', value: 'headphones' },
				],
			})
		);
		assert.deepStrictEqual(ids(orResults), ['one', 'three']);

		const guardedOr = () => ({
			operator: 'or',
			conditions: [
				{ attribute: 'catalogSearch', comparator: 'matches', value: 'waterproof' },
				{ attribute: 'catalogSearch', comparator: 'matches', value: 'headphones' },
			],
		});
		const ranked = await collect(Product.search(guardedOr()));
		assert.strictEqual(ranked.length, 3);
		const deniedId = ranked[0].id;
		const rowFilter = (record) => record.id !== deniedId;
		assert.deepStrictEqual(
			(await collect(Product.search({ ...guardedOr(), rowFilter, limit: 1 }))).map(({ id }) => id),
			[ranked[1].id]
		);
		assert.deepStrictEqual(
			(await collect(Product.search({ ...guardedOr(), rowFilter, offset: 1, limit: 1 }))).map(({ id }) => id),
			[ranked[2].id]
		);

		const restQuery = parseQuery('catalogSearch=matches_phrase=trail%20running&select(id,title,$score,$highlights)');
		const [restResult] = await collect(Product.search(restQuery));
		assert.strictEqual(restResult.id, 'one');
		assert.strictEqual(restResult.title, 'Waterproof Trail Running Shoes');
		assert.strictEqual(restResult.tags, undefined);
		assert.strictEqual(typeof restResult.$score, 'number');
		assert.deepStrictEqual(restResult.$highlights.title[0].spans, [{ start: 11, end: 24 }]);
	});

	it('keeps multiple full-text indexes independent and rejects combining them in one query', async () => {
		Product = table({
			database: `fulltext-native-multiple-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tags', type: 'array', elements: { type: 'String' } },
			],
			fullTextIndexes: [
				definition('titleSearch', [{ name: 'title', weight: 1 }]),
				definition('tagSearch', [{ name: 'tags', weight: 1 }]),
			],
		});
		await Product.put('one', { title: 'Trail Shoes', tags: ['outdoor'] });
		await Product.put('two', { title: 'Office Shoes', tags: ['formal'] });
		await waitFor(
			() =>
				fullTextDerivedIndexReadiness(Product, 'titleSearch').state === 'ready' &&
				fullTextDerivedIndexReadiness(Product, 'tagSearch').state === 'ready',
			30_000
		);

		const query = (attribute, value) =>
			collect(
				Product.search({
					conditions: [
						{
							attribute,
							comparator: 'matches',
							value,
							maxIndexLagMilliseconds: 0,
							waitForIndexMilliseconds: 30_000,
						},
					],
				})
			);
		assert.deepStrictEqual(ids(await query('titleSearch', 'trail')), ['one']);
		assert.deepStrictEqual(ids(await query('tagSearch', 'formal')), ['two']);
		await assert.rejects(
			async () =>
				collect(
					Product.search({
						operator: 'and',
						conditions: [
							{ attribute: 'titleSearch', comparator: 'matches', value: 'shoes' },
							{ attribute: 'tagSearch', comparator: 'matches', value: 'outdoor' },
						],
					})
				),
			/One query cannot combine conditions from different full-text indexes/
		);
	});

	it('probes a broad indexed equality before loading full-text source records', async () => {
		Product = table({
			database: `fulltext-native-companion-probe-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'category', type: 'String', indexed: true },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
		});
		await Product.put(
			Array.from({ length: 100 }, (_value, index) => ({
				id: `product-${String(index).padStart(3, '0')}`,
				title: 'identical catalog product',
				category: index < 50 ? 'other' : 'target',
			}))
		);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30_000);

		const originalGetEntry = Product.primaryStore.getEntry;
		let sourceReads = 0;
		Product.primaryStore.getEntry = function (...args) {
			sourceReads++;
			return originalGetEntry.apply(this, args);
		};
		let records;
		try {
			records = await collect(
				Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator: 'matches',
							value: 'catalog',
							waitForIndexMilliseconds: 30_000,
						},
						{ attribute: 'category', comparator: 'equals', value: 'target' },
					],
					enforceExecutionOrder: true,
					limit: 1,
				})
			);
		} finally {
			Product.primaryStore.getEntry = originalGetEntry;
		}
		assert.deepStrictEqual(ids(records), ['product-050']);
		assert.strictEqual(sourceReads, 1, 'secondary-index misses must not load authoritative records');
	});

	it('keeps tied BM25 results stable across native pages', async () => {
		Product = table({
			database: `fulltext-native-stable-pages-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
		});
		const expected = Array.from({ length: 300 }, (_value, index) => `product-${String(index).padStart(3, '0')}`);
		const insertionOrder = [...expected].reverse();
		for (let start = 0; start < insertionOrder.length; start += 100)
			await Product.put(
				insertionOrder.slice(start, start + 100).map((id) => ({ id, title: 'identical catalog product' }))
			);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30_000);

		const search = (limit) =>
			collect(
				Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator: 'matches',
							value: 'identical catalog',
							maxIndexLagMilliseconds: 0,
							waitForIndexMilliseconds: 30_000,
						},
					],
					limit,
				})
			);
		const results = await search(270);
		assert.deepStrictEqual(
			results.map(({ id }) => id),
			expected.slice(0, 270)
		);

		for (const id of expected.slice(-5)) await Product.delete(id);
		const afterDeletes = await search(300);
		assert.deepStrictEqual(
			afterDeletes.map(({ id }) => id),
			expected.slice(0, -5)
		);
	});
	it('keeps native ordinary and traversal prefixes consistent across score, ID and page-size boundaries', async () => {
		const { mkdtemp, rm } = require('node:fs/promises');
		const { join } = require('node:path');
		const binding = await loadFullTextNativeBinding();
		const info = await binding.runtimeInfo();
		const path = await mkdtemp(join(__dirname, '../envDir/', String(process.pid), 'fulltext-prefix-'));
		const options = {
			path,
			indexId: 'prefix-test',
			generation: '1',
			fields: [{ name: 'title' }],
			analyzer: 'english@2',
			surfaceTerms: true,
			limits: {
				indexingThreads: 1,
				searchThreads: Math.max(2, info.queryClassIsolationMinimumSearchThreads),
				writerMemoryBytes: 30000000,
				maxQueuedCommands: 16,
				maxQueuedBytes: 8388608,
				maxBatchBytes: 8388608,
			},
		};
		let writer, reader;
		try {
			writer = await binding.openNativeFullTextIndex(options);
			for (let start = 0; start < 1024; start += 128) {
				await writer.applyMutationBatch({
					upserts: Array.from({ length: 128 }, (_, i) => ({
						id: `${start + i}-é-😀`,
						version: String((start + i) % 3),
						fields: { title: (start + i) % 3 ? 'widget catalog' : 'widget widget catalog' },
					})),
				});
				await writer.commit();
			}
			reader = await binding.openNativeFullTextReader(options);
			for (const query of [
				{ text: 'widget catalog', mode: 'any' },
				{ text: 'widg', mode: 'prefix' },
				{ text: 'widg', mode: 'fuzzy-prefix' },
				{ operator: 'and', clauses: [{ text: 'widget' }, { operator: 'not', clause: { text: 'absent' } }] },
			]) {
				const ordinary = await reader.search({
					query,
					limit: query.mode?.includes('prefix') ? info.limits.maxAutocompleteResults : 1024,
					exactTotal: true,
				});
				assert.deepStrictEqual((await reader.searchPage({ query, limit: ordinary.hits.length })).hits, ordinary.hits);
				const first = await reader.searchPage({ query, limit: 73 });
				const walk = async (limit) => {
					const hits = [];
					let continuation = first.continuation;
					do {
						const page = await reader.searchPage({ query, limit, continuation });
						assert.strictEqual(page.total, 1024);
						hits.push(...page.hits);
						continuation = page.continuation;
					} while (continuation);
					return hits;
				};
				assert.deepStrictEqual(await walk(17), await walk(113));
				const small = await reader.searchPage({ query, limit: 17, continuation: first.continuation });
				const large = await reader.searchPage({ query, limit: 113, continuation: first.continuation });
				assert.deepStrictEqual(small.hits, large.hits.slice(0, 17));
			}
		} finally {
			await reader?.close();
			await writer?.close();
			await rm(path, { recursive: true, force: true });
		}
	});

	it('fills filtered ordinary and autocomplete pages beyond the native offset and hit windows', async () => {
		const { toBufferKey } = require('ordered-binary');
		const info = await (await loadFullTextNativeBinding()).runtimeInfo();
		const count = info.limits.maxSearchWindow + 25;
		Product = table({
			database: `fulltext-native-traversal-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
		});
		const keys = Array.from({ length: count }, (_, i) => `product-${String(i).padStart(5, '0')}`);
		for (let start = 0; start < count; start += 250)
			await Product.put(keys.slice(start, start + 250).map((id) => ({ id, title: 'widget catalog' })));
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30_000);
		const ordered = keys
			.slice()
			.sort((a, b) =>
				Buffer.compare(
					Buffer.from(toBufferKey(a).toString('base64url')),
					Buffer.from(toBufferKey(b).toString('base64url'))
				)
			);
		const search = (comparator, value, options = {}) =>
			collect(
				Product.search({
					conditions: [
						{
							attribute: 'catalogSearch',
							comparator,
							value,
							maxIndexLagMilliseconds: 0,
							waitForIndexMilliseconds: 30_000,
						},
					],
					limit: 25,
					...options,
				})
			);
		const tail = new Set(ordered.slice(info.limits.maxSearchWindow));
		const env = require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const previousPolicy = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		try {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { ...previousPolicy, maxRawHitsPerRequest: 128 });
			await assert.rejects(
				search('matches', 'widget catalog', { rowFilter: (record) => tail.has(record.id) }),
				(error) => error.statusCode === 400 && error.message.includes('storage.fullText.maxRawHitsPerRequest')
			);
		} finally {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previousPolicy);
		}

		assert.deepStrictEqual(
			(await search('matches', 'widget catalog', { rowFilter: (record) => tail.has(record.id) })).map(({ id }) => id),
			ordered.slice(info.limits.maxSearchWindow)
		);
		const snapshotQuery = {
			conditions: [
				{ attribute: 'catalogSearch', comparator: 'matches', value: 'widget catalog', waitForIndexMilliseconds: 5000 },
			],
			limit: require('#src/resources/indexes/fullTextSearchLimits').DEFAULT_FULL_TEXT_SEARCH_LIMITS.maxPageSize,
			select: ['id', '$score'],
		};
		const snapshotIds = [];
		let continuation = true;
		while (continuation) {
			const page = await Product.search({ ...snapshotQuery, continuation });
			snapshotIds.push(...page.map(({ id }) => id));
			continuation = page.continuation;
			if (!continuation) {
				assert.strictEqual(page.complete, true);
				assert.strictEqual(page.expiresAt, undefined);
			}
		}
		assert.deepStrictEqual(snapshotIds, ordered);
		const first = new Set(ordered.slice(0, info.limits.maxAutocompleteResults));
		for (const comparator of ['matches_prefix', 'matches_fuzzy_prefix']) {
			assert.deepStrictEqual(
				(await search(comparator, 'widg', { rowFilter: (record) => !first.has(record.id) })).map(({ id }) => id),
				ordered.slice(info.limits.maxAutocompleteResults, info.limits.maxAutocompleteResults + 25)
			);
			assert.deepStrictEqual(
				(await search(comparator, 'widg', { limit: info.limits.maxAutocompleteResults + 25 })).map(({ id }) => id),
				ordered.slice(0, info.limits.maxAutocompleteResults + 25)
			);
		}
	});
});
