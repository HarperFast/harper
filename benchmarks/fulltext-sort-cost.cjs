const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const { performance } = require('node:perf_hooks');
const { compareKeys } = require('ordered-binary');
const { convertToComparableKeys } = require('#src/resources/Resource');
const { table } = require('#src/resources/databases');
const { setupTestDBPath } = require('../unitTests/testUtils');

const source = fs.readFileSync(path.join(__dirname, '../resources/Table.ts'), 'utf8');
const getterStart = source.indexOf('\tfunction getAttributeValue(');
const getterEnd = source.indexOf('\n\tfunction getPathValue(', getterStart);
const sortStart = source.indexOf(
	'\t\treturn (entries: FullTextSearchEntry[]) => {',
	source.indexOf('function fullTextResultOrder')
);
const sortEnd = source.indexOf('\n\t}\n\n\tfunction assertFullTextReadAccess', sortStart);
assert(
	getterStart >= 0 && getterEnd > getterStart && sortStart >= 0 && sortEnd > sortStart,
	'production closures moved; update the extraction'
);
const getterSource = source.slice(getterStart, getterEnd);
const sortSource = source.slice(sortStart, sortEnd);
const unavailablePath = () => {
	throw new Error('This cost observation supports directly stored scalar fields only');
};
// Extract the production closures so the observation cannot silently time a copied implementation.
const makeGetter = new Function(
	'primaryStore',
	'propertyResolvers',
	'getPathValue',
	`${stripTypeScriptTypes(getterSource)}\nreturn getAttributeValue`
);
const makeSorter = new Function(
	'clauses',
	'getAttributeValue',
	'convertToComparableKeys',
	'compareKeys',
	'context',
	`${stripTypeScriptTypes(`function factory() { ${sortSource} }`)}\nreturn factory()`
);
function summarize(milliseconds) {
	const ranked = milliseconds.slice().sort((left, right) => left - right);
	assert(ranked.length > 0);
	return {
		milliseconds,
		p50Milliseconds: (ranked[Math.floor((ranked.length - 1) / 2)] + ranked[Math.ceil((ranked.length - 1) / 2)]) / 2,
		p95Milliseconds: ranked[Math.ceil(0.95 * ranked.length) - 1],
		maxMilliseconds: ranked.at(-1),
	};
}
const report = {
	node: process.version,
	cpu: os.cpus()[0].model,
	rows: 10000,
	warmups: 3,
	samples: 30,
	closureSha256: createHash('sha256').update(getterSource).update(sortSource).digest('hex'),
	scope:
		'Production getAttributeValue and decorated-key sort closures with real Table scalar property resolvers and resident record entries. Excludes native retrieval, source-version checks, projection, highlighting, GC isolation and end-to-end latency.',
	cases: [],
};

describe('full-text stored scalar sort cost observation', () => {
	before(() => setupTestDBPath());
	for (const width of [1, 3, 32]) {
		it(`${width} clauses over 10000 resident entries`, () => {
			const clauses = Array.from({ length: width }, (_, index) => ({ attribute: `key${index}`, descending: false }));
			const Scalar = table({
				database: 'fulltext-sort-cost',
				table: `Scalar${width}`,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					...clauses.map((clause, index) => ({ name: clause.attribute, type: index < width - 1 ? 'String' : 'Float' })),
				],
			});
			const getter = makeGetter(Scalar.primaryStore, Scalar.propertyResolvers, unavailablePath);
			const sorter = makeSorter(clauses, getter, convertToComparableKeys, compareKeys, undefined);
			const entries = Array.from({ length: report.rows }, (_, index) => ({
				recordEntry: {
					value: Object.fromEntries(
						clauses.map((clause, column) => [
							clause.attribute,
							column < width - 1 ? 'shared' : (index * 7919) % report.rows,
						])
					),
				},
			}));
			const elapsed = [];
			for (let run = 0; run < report.warmups + report.samples; run++) {
				const copy = entries.slice();
				const started = performance.now();
				sorter(copy);
				const milliseconds = performance.now() - started;
				if (run >= report.warmups) elapsed.push(milliseconds);
				assert.strictEqual(copy[0].recordEntry.value[`key${width - 1}`], 0);
				assert.strictEqual(copy.at(-1).recordEntry.value[`key${width - 1}`], report.rows - 1);
			}
			report.cases.push({
				clauses: width,
				leadingTiedKeys: width - 1,
				...summarize(elapsed),
			});
		});
	}
	if (process.env.FULLTEXT_NATIVE_COST === '1') {
		describe('published native end-to-end query observation', () => {
			const {
				fullTextDerivedIndexReadiness,
				setFullTextNativeBindingForTests,
			} = require('#src/resources/derivedIndexes');
			const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
			const { setMainIsWorker } = require('#src/server/threads/manageThreads');
			const { waitFor } = require('../unitTests/waitFor');
			const { DEFAULT_FULL_TEXT_SEARCH_LIMITS } = require('#src/resources/indexes/fullTextSearchLimits');
			const {
				getFullTextTestConfiguration,
				setFullTextTestConfiguration,
			} = require('../unitTests/resources/fullTextTestConfiguration');
			let previousConfiguration;
			let Product;
			before(async () => {
				assert.notStrictEqual(process.env.HARPER_STORAGE_ENGINE, 'lmdb');
				previousConfiguration = getFullTextTestConfiguration();
				setFullTextTestConfiguration(DEFAULT_FULL_TEXT_SEARCH_LIMITS);
				setMainIsWorker(true);
				const binding = await loadFullTextNativeBinding();
				setFullTextNativeBindingForTests({
					binding,
					closeTimeoutMilliseconds: 5000,
					shutdownTimeoutMilliseconds: 10000,
				});
				report.native = {
					rows: 9000,
					warmups: 3,
					samples: 10,
					runtime: await binding.runtimeInfo(),
					policy: DEFAULT_FULL_TEXT_SEARCH_LIMITS,
					scope:
						'Real audited Table writes, published native binding and Product.search plus full consumption of the returned page. Warm resident corpus; highlights only in sort-1-highlights. No concurrency, cold storage, sustained-memory or peak-capacity qualification. RSS snapshots are not peak measurements.',
				};
				report.nativeQueryCases = [];
				Product = table({
					database: `fulltext-native-cost-${Date.now()}`,
					table: 'Product',
					audit: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						{ name: 'title', type: 'String' },
						...Array.from({ length: 32 }, (_, index) => ({
							name: `key${index}`,
							type: index === 31 ? 'Float' : 'String',
						})),
					],
					fullTextIndexes: [
						{
							name: 'catalogSearch',
							fields: [{ name: 'title', weight: 1, highlight: true }],
							highlighting: { maxFragments: 2, fragmentLength: 80 },
							analyzer: 'english@2',
							stopWords: true,
							positions: true,
							surfaceTerms: true,
							synonyms: [],
						},
					],
				});
				for (let start = 0; start < report.native.rows; start += 250) {
					await Product.put(
						Array.from({ length: Math.min(250, report.native.rows - start) }, (_, offset) => {
							const index = start + offset;
							return {
								id: String(index).padStart(5, '0'),
								title: 'widget',
								...Object.fromEntries(
									Array.from({ length: 32 }, (_, column) => [
										`key${column}`,
										column === 31 ? (index * 7919) % report.native.rows : 'shared',
									])
								),
							};
						})
					);
				}
				await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
			});
			after(async () => {
				const runtime = Product?.derivedIndexRuntime;
				if (Product) Product.derivedIndexRuntime = undefined;
				try {
					if (runtime) await runtime.close();
				} finally {
					setFullTextNativeBindingForTests(undefined);
					if (previousConfiguration) setFullTextTestConfiguration(previousConfiguration);
				}
			});
			for (const name of [
				'relevance',
				'exact-count',
				'sort-1',
				'sort-3',
				'sort-32',
				'sort-1-highlights',
				'sort-1-filtered-exact-count',
			]) {
				it(name, async () => {
					const width = name.startsWith('sort-') ? parseInt(name.slice(5), 10) : 0;
					const highlights = name === 'sort-1-highlights';
					const filtered = name === 'sort-1-filtered-exact-count';
					const exactCount = name === 'exact-count' || filtered;
					let sort;
					for (const attribute of [
						...Array.from({ length: Math.max(0, width - 1) }, (_, index) => `key${32 - width + index}`),
						...(width ? ['key31'] : []),
					].reverse())
						sort = { attribute, descending: false, ...(sort ? { next: sort } : {}) };
					const target = {
						conditions: [
							{
								attribute: 'catalogSearch',
								comparator: 'matches',
								value: 'widget',
								...(highlights ? { includeHighlights: true } : {}),
								maxIndexLagMilliseconds: 0,
								waitForIndexMilliseconds: 30000,
							},
							...(filtered ? [{ attribute: 'key31', comparator: 'lt', value: 90 }] : []),
						],
						limit: 20,
						select: ['id', 'key31', ...(highlights ? ['$highlights'] : [])],
						...(sort ? { sort } : {}),
						...(exactCount ? { count: 'exact' } : {}),
					};
					const elapsed = [];
					const countOutcomes = [];
					const rssBeforeBytes = process.memoryUsage().rss;
					for (let run = 0; run < report.native.warmups + report.native.samples; run++) {
						const started = performance.now();
						const result = await Product.search(target);
						const rows = [];
						for await (const row of result) rows.push(row);
						const milliseconds = performance.now() - started;
						assert.strictEqual(rows.length, 20);
						if (highlights) assert(rows.every((row) => row.$highlights.title.some((value) => value.spans.length > 0)));
						if (width)
							assert.deepStrictEqual(
								rows.map((row) => row.key31),
								Array.from({ length: 20 }, (_, index) => index)
							);
						if (exactCount) {
							if (result.recordCountExact) assert.strictEqual(result.recordCount, filtered ? 90 : report.native.rows);
							else assert.strictEqual(result.recordCount, null);
							if (run >= report.native.warmups)
								countOutcomes.push({ total: result.recordCount, exact: result.recordCountExact });
						}
						if (run >= report.native.warmups) elapsed.push(milliseconds);
					}
					report.nativeQueryCases.push({
						name,
						clauses: width,
						highlights,
						filtered,
						...summarize(elapsed),
						rssBeforeBytes,
						rssAfterBytes: process.memoryUsage().rss,
						...(countOutcomes.length ? { countOutcomes } : {}),
					});
				});
			}
		});
	}
	after(() => {
		assert.strictEqual(report.cases.length, 3, 'All cost cases must complete before publishing samples');
		if (process.env.FULLTEXT_NATIVE_COST === '1') assert.strictEqual(report.nativeQueryCases?.length, 7);
		const json = JSON.stringify(report, null, 2) + '\n';
		if (process.env.FULLTEXT_SORT_COST_REPORT) fs.writeFileSync(process.env.FULLTEXT_SORT_COST_REPORT, json);
		console.log(json);
	});
});
