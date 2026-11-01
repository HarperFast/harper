const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { fullTextDerivedIndexReadiness, setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');

describe('published full-text optional count admission', () => {
	let Product;

	before(async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
	});

	afterEach(async () => {
		const runtime = Product?.derivedIndexRuntime;
		if (Product) Product.derivedIndexRuntime = undefined;
		try {
			if (runtime) await runtime.close();
		} finally {
			Product = undefined;
			setFullTextNativeBindingForTests(undefined);
		}
	});

	it('preserves an ordinary page when real native queue admission rejects optional count traversal', async () => {
		const binding = await loadFullTextNativeBinding();
		let searches = 0;
		const admissionErrors = [];
		setFullTextNativeBindingForTests({
			binding: {
				...binding,
				async openNativeFullTextReader(options) {
					// This query packs to 54 bytes; traversal adds two bytes and exceeds the real queue capacity.
					const reader = await binding.openNativeFullTextReader({
						...options,
						limits: { ...options.limits, maxQueuedBytes: 54, maxBatchBytes: 24 },
					});
					const search = reader.search;
					const searchPage = reader.searchPage;
					reader.search = async function (...args) {
						const result = await search.apply(this, args);
						searches++;
						return result;
					};
					reader.searchPage = async function (...args) {
						try {
							return await searchPage.apply(this, args);
						} catch (error) {
							admissionErrors.push(error);
							throw error;
						}
					};
					return reader;
				},
			},
			closeTimeoutMilliseconds: 5000,
			shutdownTimeoutMilliseconds: 10000,
		});
		Product = table({
			database: `fulltext-count-admission-${Date.now()}`,
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
		await Product.put(Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}`, title: 'widget' })));
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const query = {
			conditions: [
				{
					attribute: 'catalogSearch',
					comparator: 'matches',
					value: 'widget',
					fields: ['title'],
					maxIndexLagMilliseconds: 0,
					waitForIndexMilliseconds: 30000,
				},
			],
			limit: 1,
		};
		const baseline = [];
		for await (const row of Product.search(query)) baseline.push(row.id);
		assert.strictEqual(baseline.length, 1);
		assert.strictEqual(admissionErrors.length, 0);
		const page = await Product.search({ ...query, count: 'exact' });
		assert.deepStrictEqual(
			page.map(({ id }) => id),
			baseline
		);
		assert.strictEqual(page.recordCount, null);
		assert.strictEqual(page.recordCountExact, false);
		assert.strictEqual(searches, 2);
		assert.strictEqual(admissionErrors.length, 1);
		assert.strictEqual(admissionErrors[0].code, 'E_QUEUE_FULL');
		assert.match(admissionErrors[0].message, /queue limits are exhausted/);
		await assert.rejects(
			async () =>
				Product.search({
					...query,
					conditions: [{ ...query.conditions[0], value: 'widget widget' }],
					count: 'exact',
				}),
			(error) => error.statusCode === 503 && /busy/.test(error.message)
		);
	});
});
