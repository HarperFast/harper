const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { fullTextDerivedIndexReadiness, setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
const { getFullTextTestConfiguration, setFullTextTestConfiguration } = require('./fullTextTestConfiguration');

async function collect(iterable) {
	const records = [];
	for await (const record of iterable) records.push(record);
	return records;
}

const query = (extra = {}) => ({
	conditions: [
		{
			attribute: 'catalogSearch',
			comparator: 'matches',
			value: 'widget',
			includeHighlights: true,
			maxIndexLagMilliseconds: 0,
			waitForIndexMilliseconds: 30000,
		},
	],
	limit: 10,
	...extra,
});

describe('published full-text final page preparation', () => {
	let Product;
	let traces;
	let previousConfiguration;
	let closedReaders;
	let serial = 0;

	before(async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !(await supportsPublishedFullTextBinding())) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
	});

	beforeEach(async () => {
		previousConfiguration = getFullTextTestConfiguration();
		traces = [];
		closedReaders = new Set();
		const binding = await loadFullTextNativeBinding();
		setFullTextNativeBindingForTests({
			binding: {
				...binding,
				async openNativeFullTextReader(options) {
					const reader = await binding.openNativeFullTextReader(options);
					const traceMatches = reader.traceMatches;
					const close = reader.close;
					reader.close = async function (...args) {
						const result = await close.apply(this, args);
						closedReaders.add(reader);
						return result;
					};
					reader.traceMatches = async function (...args) {
						traces.push(args[1].length);
						return traceMatches.apply(this, args);
					};
					return reader;
				},
			},
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
			setFullTextTestConfiguration(previousConfiguration);
		}
	});

	async function seed(count = 30, extraAttributes = []) {
		Product = table({
			database: `fulltext-page-preparation-${Date.now()}-${serial++}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'price', type: 'Float' },
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
		await Product.put(Array.from({ length: count }, (_, price) => ({ id: `row-${price}`, title: 'widget', price })));
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
	}

	it('batches highlights for the final sorted page', async () => {
		await seed();
		const page = await collect(Product.search(query({ sort: { attribute: 'price' } })));
		assert.strictEqual(page.length, 10);
		assert.deepStrictEqual(traces, [10]);
		assert(page.every((record) => record.$highlights?.title?.length > 0));
	});

	it('isolates concurrent page preparation, selection and row policies from cached source entries', async () => {
		await seed();
		const [even, odd] = await Promise.all([
			Product.search(
				query({
					count: 'exact',
					sort: { attribute: 'price' },
					select: ['id', 'price', '$highlights'],
					rowFilter: (record) => record.price % 2 === 0,
				})
			),
			Product.search(
				query({
					count: 'exact',
					sort: { attribute: 'price', descending: true },
					select: ['id', 'title', '$highlights'],
					rowFilter: (record) => record.price % 2 === 1,
				})
			),
		]);
		assert.deepStrictEqual(
			even.map(({ id }) => id),
			Array.from({ length: 10 }, (_, index) => `row-${index * 2}`)
		);
		assert.deepStrictEqual(
			odd.map(({ id }) => id),
			Array.from({ length: 10 }, (_, index) => `row-${29 - index * 2}`)
		);
		assert.strictEqual(even.recordCount, 15);
		assert.strictEqual(odd.recordCount, 15);
		assert.strictEqual(even.recordCountExact, true);
		assert.strictEqual(odd.recordCountExact, true);
		for (const row of even) assert.deepStrictEqual(Object.keys(row).sort(), ['$highlights', 'id', 'price']);
		for (const row of odd) assert.deepStrictEqual(Object.keys(row).sort(), ['$highlights', 'id', 'title']);
		for (const row of [...even, ...odd]) assert(row.$highlights?.title?.length > 0);
		for (let index = 0; index < 30; index++) {
			const entry = Product.primaryStore.getEntry(`row-${index}`);
			assert.strictEqual(Object.hasOwn(entry, '$highlights'), false);
			assert.strictEqual(Object.hasOwn(entry.value, '$highlights'), false);
			assert.deepStrictEqual(Object.keys(entry.value).sort(), ['id', 'price', 'title']);
		}
		assert.deepStrictEqual(
			traces.sort((a, b) => a - b),
			[10, 10]
		);
	});

	it('preserves application errors with native-looking codes from the final row policy', async () => {
		await seed(1);
		const failure = Object.assign(new Error('final row policy failed'), { code: 'E_TIMEOUT' });
		let calls = 0;
		await assert.rejects(
			async () =>
				Product.search(
					query({
						count: 'exact',
						limit: 1,
						rowFilter() {
							if (++calls === 2) throw failure;
							return true;
						},
					})
				),
			(error) => error === failure
		);
		assert.strictEqual(calls, 2);
		assert.deepStrictEqual(traces, []);
	});

	it('preserves application error identity when final projection fails after native tracing', async () => {
		await seed(1, [{ name: 'computed', type: 'String', computed: true }]);
		const failure = Object.assign(new Error('final projection failed'), { code: 'E_RESOURCE_LIMIT' });
		Product.setComputedAttribute('computed', () => {
			throw failure;
		});
		await assert.rejects(
			async () => Product.search(query({ count: 'exact', limit: 1, select: ['id', 'computed', '$highlights'] })),
			(error) => error === failure
		);
		assert.deepStrictEqual(traces, [1]);
	});

	it('does not project skipped offset rows during count-page preparation', async () => {
		await seed(3, [{ name: 'computed', type: 'String', computed: true }]);
		const projected = [];
		Product.setComputedAttribute('computed', (record) => {
			projected.push(record.id);
			if (record.price === 0) throw new Error('off-page projection must not run');
			return `selected-${record.id}`;
		});
		const page = await Product.search(
			query({
				count: 'exact',
				sort: { attribute: 'price' },
				offset: 1,
				limit: 1,
				select: ['id', 'computed', '$highlights'],
			})
		);
		assert.strictEqual(page.length, 1);
		assert.strictEqual(page[0].id, 'row-1');
		assert.strictEqual(page[0].computed, 'selected-row-1');
		assert(page[0].$highlights?.title?.length > 0);
		assert.strictEqual(page.recordCount, 3);
		assert.strictEqual(page.recordCountExact, true);
		assert.deepStrictEqual(projected, ['row-1', 'row-2']);
		assert.deepStrictEqual(traces, [1]);
	});

	it('keeps unhighlighted exact counts off the page-preparation path', async () => {
		await seed(3);
		const transformEntryForSelect = Product.transformEntryForSelect;
		let preparedSelections = 0;
		Product.transformEntryForSelect = function (...args) {
			if (args[9] !== undefined) preparedSelections++;
			return transformEntryForSelect.apply(this, args);
		};
		try {
			const target = query({ count: 'exact', limit: 1 });
			target.conditions = target.conditions.map((condition) => ({ ...condition, includeHighlights: false }));
			const page = await Product.search(target);
			assert.strictEqual(page.length, 1);
			assert.strictEqual(page.recordCount, 3);
			assert.strictEqual(page.recordCountExact, true);
			assert.strictEqual(Object.hasOwn(page[0], '$highlights'), false);
			assert.strictEqual(preparedSelections, 0);
			assert.deepStrictEqual(traces, []);
		} finally {
			Product.transformEntryForSelect = transformEntryForSelect;
		}
	});

	it('preserves onlyIfCached expiry messages without source loading or native highlights', async () => {
		await seed(1);
		const expiresAt = Date.now() + 1500;
		await Product.put('row-0', { id: 'row-0', title: 'widget', price: 0 }, { expiresAt });
		let sourceCalls = 0;
		Product.sourcedFrom({
			async get(id) {
				sourceCalls++;
				return { id, title: 'widget', price: 0 };
			},
		});
		const transformEntryForSelect = Product.transformEntryForSelect;
		let crossedExpiry = false;
		Product.transformEntryForSelect = function (...args) {
			const transform = transformEntryForSelect.apply(this, args);
			const delayed = async function (entry) {
				if (!crossedExpiry) {
					assert(Date.now() < expiresAt, 'candidate was accepted before its real TTL');
					await waitFor(() => Date.now() > expiresAt, 5000);
					crossedExpiry = true;
				}
				return transform.call(this, entry);
			};
			delayed.return = () => transform.return?.();
			return delayed;
		};
		try {
			const page = await Product.search(query({ count: 'exact', limit: 1 }), { onlyIfCached: true });
			assert.deepStrictEqual([...page], [{ id: 'row-0', message: 'This entry has expired' }]);
			assert.strictEqual(crossedExpiry, true);
			assert.strictEqual(sourceCalls, 0);
			assert.deepStrictEqual(traces, []);
		} finally {
			Product.transformEntryForSelect = transformEntryForSelect;
		}
	});

	it('keeps nested relationship restrictions specific to concurrent prepared pages', async () => {
		const Child = table({
			database: `fulltext-page-children-${Date.now()}-${serial++}`,
			table: 'Child',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'parentId', type: 'String', indexed: true },
				{ name: 'label', type: 'String', indexed: true },
			],
		});
		await seed(2, [
			{
				name: 'children',
				relationship: { to: 'parentId' },
				elements: { type: 'Child', definition: { tableClass: Child } },
			},
		]);
		await Child.put(
			['gold', 'silver'].flatMap((label) =>
				[0, 1].map((index) => ({
					id: `${label}-${index}`,
					parentId: `row-${index}`,
					label,
				}))
			)
		);
		const pages = await Promise.all(
			['gold', 'silver'].map((label) => {
				const target = query({
					count: 'exact',
					sort: { attribute: 'price' },
					select: ['id', { name: 'children', limit: 10, select: ['id', 'label'] }, '$highlights'],
				});
				target.conditions.push({ attribute: ['children', 'label'], value: label });
				return Product.search(target);
			})
		);
		for (const [pageIndex, label] of ['gold', 'silver'].entries()) {
			const page = pages[pageIndex];
			assert.strictEqual(page.recordCount, 2);
			assert.strictEqual(page.recordCountExact, true);
			assert.strictEqual(page.length, 2);
			for (const [index, row] of page.entries()) {
				assert.strictEqual(row.id, `row-${index}`);
				assert.deepStrictEqual(row.children, [{ id: `${label}-${index}`, label }]);
				assert(row.$highlights?.title?.length > 0);
			}
		}
	});

	it('preserves cancellation raised during the final row policy', async () => {
		await seed(1);
		const controller = new AbortController();
		const reason = new Error('cancel final page preparation');
		let calls = 0;
		await assert.rejects(
			async () =>
				Product.search(
					query({
						count: 'exact',
						limit: 1,
						rowFilter() {
							if (++calls === 2) controller.abort(reason);
							return true;
						},
					}),
					{ signal: controller.signal }
				),
			(error) => error === reason
		);
		assert.strictEqual(calls, 2);
		assert.deepStrictEqual(traces, []);
	});

	it('bounds an unresolved source refresh during final materialization and releases its native reader', async function () {
		this.timeout(10000);
		await seed(1);
		const expiresAt = Date.now() + 1500;
		await Product.put('row-0', { id: 'row-0', title: 'widget', price: 0 }, { expiresAt });
		let releaseSource;
		const sourceGate = new Promise((resolve) => {
			releaseSource = resolve;
		});
		let sourceCalls = 0;
		Product.sourcedFrom({
			async get(id) {
				sourceCalls++;
				await sourceGate;
				return { id, title: 'widget', price: 0 };
			},
		});
		const transformEntryForSelect = Product.transformEntryForSelect;
		let crossedExpiry = false;
		Product.transformEntryForSelect = function (...args) {
			const transform = transformEntryForSelect.apply(this, args);
			const delayed = async function (entry) {
				if (!crossedExpiry) {
					assert(Date.now() < expiresAt, 'candidate was accepted before its real TTL');
					await waitFor(() => Date.now() > expiresAt, 5000);
					crossedExpiry = true;
				}
				return transform.call(this, entry);
			};
			delayed.return = () => transform.return?.();
			return delayed;
		};
		setFullTextTestConfiguration({ ...previousConfiguration, requestBudgetMilliseconds: 2500 });
		let timer;
		try {
			await assert.rejects(
				Promise.race([
					Product.search(query({ count: 'exact', limit: 1 })),
					new Promise((_resolve, reject) => {
						timer = setTimeout(() => reject(new Error('final source materialization did not settle')), 6000);
					}),
				]),
				(error) => error.statusCode === 503 && /materialization budget/.test(error.message)
			);
			assert.strictEqual(crossedExpiry, true);
			assert.strictEqual(sourceCalls, 1);
			assert.deepStrictEqual(traces, []);
			assert.strictEqual(closedReaders.size, 0);
			const retirement = Product.fullTextQueryIndexes.catalogSearch.customIndex.close();
			retirement.catch(() => {});
			await waitFor(() => closedReaders.size > 0, 5000);
			await retirement;
		} finally {
			clearTimeout(timer);
			releaseSource();
			Product.transformEntryForSelect = transformEntryForSelect;
		}
	});
});
