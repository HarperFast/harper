'use strict';

const { getFullTextTestConfiguration, setFullTextTestConfiguration } = require('./fullTextTestConfiguration');

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { fullTextDerivedIndexReadiness, setFullTextNativeBindingForTests } = require('#src/resources/derivedIndexes');
const { loadFullTextNativeBinding } = require('#src/resources/indexes/fullTextNativeBinding');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const { parseQuery } = require('#src/resources/search');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
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

	it('boosts required matches and adds optional scores without changing eligibility', async () => {
		const searchDefinition = definition('catalogSearch', [
			{ name: 'title', weight: 1, highlight: true },
			{ name: 'details', weight: 1, highlight: true },
		]);
		searchDefinition.highlighting = { maxFragments: 2, fragmentLength: 80 };
		const database = `fulltext-relevance-${Date.now()}`;
		Product = table({
			database,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'details', type: 'String' },
			],
			fullTextIndexes: [searchDefinition],
		});
		await Product.put([
			{ id: 'a', title: 'widget', details: 'plain catalog' },
			{ id: 'b', title: 'widget', details: 'trail running' },
			{ id: 'c', title: 'widget', details: 'plain catalog' },
			{ id: 'outside', title: 'different', details: 'trail running' },
		]);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const condition = {
			attribute: 'catalogSearch',
			comparator: 'matches',
			value: 'widget',
			fields: ['title'],
			maxIndexLagMilliseconds: 0,
			waitForIndexMilliseconds: 30000,
		};
		const search = (controls = {}, options = {}) =>
			collect(
				Product.search({
					conditions: [{ ...condition, ...controls }],
					select: ['id', 'title', 'details', '$score'],
					...options,
				})
			);
		const boundaryClause = { comparator: 'matches', value: 'widget', fields: ['title'] };
		assert.strictEqual(
			(await search({ should: Array.from({ length: 127 }, () => ({ ...boundaryClause })) })).length,
			3
		);
		await assert.rejects(
			search({ should: Array.from({ length: 128 }, () => ({ ...boundaryClause })) }),
			(error) => error.statusCode === 400 && /Full-text query on 'catalogSearch' is invalid/.test(error.message)
		);
		const baseline = await search();
		assert.deepStrictEqual(
			baseline.map(({ id }) => id),
			['a', 'b', 'c']
		);
		for (const controls of [{ boost: 3 }, { should: [{ comparator: 'matches', value: 'trail' }] }])
			await assert.rejects(
				Product.fullTextQueryIndexes.catalogSearch.customIndex.search({ ...condition, ...controls }, {}),
				(error) => error.statusCode === 400 && /compiled fullTextQuery/.test(error.message)
			);
		const boosted = await search({ boost: 3 });
		assert.deepStrictEqual(ids(boosted), ids(baseline));
		const pending = Product.fullTextQueryIndexes.catalogSearch.customIndex.search(
			{
				...condition,
				fullTextQuery: { operator: 'boost', boost: 2, clause: { text: 'widget', mode: 'any', fields: ['title'] } },
				maxIndexLagMilliseconds: 5000,
				waitForIndexMilliseconds: 0,
			},
			{},
			{ minResults: 1 }
		);
		assert(pending.indexCoverage, 'non-waiting scoring exposes coverage before await');
		assert(['current', 'bounded'].includes(pending.indexCoverage.state));
		await pending;

		for (let index = 0; index < baseline.length; index++)
			assert.strictEqual(boosted[index].$score, Math.fround(baseline[index].$score * 3));
		const zero = await search({ boost: 0 });
		assert.deepStrictEqual(ids(zero), ids(baseline));
		assert(zero.every(({ $score }) => $score === 0));
		const controls = {
			should: [{ comparator: 'matches_phrase', value: 'trail running', fields: ['details'], boost: 10 }],
		};
		const ranked = await search(controls);
		assert.deepStrictEqual(
			ranked.map(({ id }) => id),
			['b', 'a', 'c']
		);
		assert.deepStrictEqual(ids(ranked), ids(baseline));
		const optionalClauses = [
			{ comparator: 'matches', value: 'trail', fields: ['details'], boost: 2 },
			{ comparator: 'matches', value: 'running', fields: ['details'], boost: 3.5 },
		];
		const bonusScores = [];
		for (const { boost: _boost, ...clause } of optionalClauses)
			bonusScores.push(new Map((await search(clause)).map(({ id, $score }) => [id, $score])));
		const additive = await search({ boost: 0.5, should: optionalClauses });
		assert.deepStrictEqual(ids(additive), ['a', 'b', 'c']);
		const requiredScores = new Map(baseline.map(({ id, $score }) => [id, $score]));
		for (const record of additive) {
			const contributions = [
				Math.fround(requiredScores.get(record.id) * 0.5),
				...optionalClauses.map(({ boost }, index) => Math.fround((bonusScores[index].get(record.id) ?? 0) * boost)),
			];
			const expected = contributions.reduce((sum, score) => sum + score, 0);
			const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-6);
			assert(Math.abs(record.$score - expected) <= tolerance, `additive Table score for ${record.id}`);
			if (record.id === 'b') {
				assert(record.$score > Math.max(...contributions) + tolerance, 'sum must exceed max-only scoring');
				assert(
					contributions.every((score) => score > tolerance),
					'each contribution must be discriminated'
				);
			}
		}

		const bridge = new ResourceBridge();
		const bridged = await collect(
			await bridge.searchByConditions({
				database,
				schema: database,
				table: 'Product',
				get_attributes: ['id', 'title', 'details', '$score'],
				conditions: [{ ...condition, ...controls }],
			})
		);
		assert.deepStrictEqual(bridged, ranked);
		const misplacedControls = await Promise.allSettled(
			[{ boost: 2 }, { should: controls.should }].map((rootControls) =>
				bridge.searchByConditions({
					database,
					schema: database,
					table: 'Product',
					get_attributes: ['id'],
					conditions: [{ ...condition }],
					...rootControls,
				})
			)
		);
		assert.deepStrictEqual(
			misplacedControls.map(({ status }) => status),
			['rejected', 'rejected']
		);
		for (const result of misplacedControls) assert.strictEqual(result.reason.statusCode, 400);

		await assert.rejects(
			() =>
				bridge.searchByConditions({
					database,
					schema: database,
					table: 'Product',
					get_attributes: ['id'],
					conditions: [{ ...condition, boost: 2, negated: true }],
				}),
			(error) => error.statusCode === 400
		);

		assert.deepStrictEqual(
			(await search(controls, { offset: 1, limit: 1 })).map(({ id }) => id),
			['a']
		);
		assert.deepStrictEqual(
			(await search(controls, { rowFilter: (record) => record.id !== 'b', limit: 2 })).map(({ id }) => id),
			['a', 'c']
		);
		const highlights = await search({ ...controls, includeHighlights: true });
		assert.deepStrictEqual(highlights[0].$highlights.details[0].spans, [{ start: 0, end: 13 }]);
		assert.strictEqual(highlights[1].$highlights.details, undefined);
		const implicitFields = { should: [{ comparator: 'matches', value: 'trail' }] };
		assert.strictEqual((await search(implicitFields))[0].id, 'b');
		assert.strictEqual(implicitFields.should[0].fields, undefined);
		const user = {
			role: {
				permission: {
					[database]: {
						tables: {
							Product: {
								read: true,
								attribute_permissions: [
									{ attribute_name: 'title', read: true },
									{ attribute_name: 'details', read: false },
								],
							},
						},
					},
				},
			},
		};
		const allowedTarget = {
			conditions: [{ ...condition, should: [{ comparator: 'matches', value: 'widget', fields: ['title'] }] }],
			select: ['title', '$score'],
		};
		assert.strictEqual((await collect(Product.search(allowedTarget, { user }))).length, 3);
		for (const should of [
			[{ comparator: 'matches', value: 'trail', fields: ['details'] }],
			[{ comparator: 'matches', value: 'trail' }],
		])
			await assert.rejects(
				async () => collect(Product.search({ ...allowedTarget, conditions: [{ ...condition, should }] }, { user })),
				(error) => error.name === 'AccessViolation'
			);

		for (const invalid of [
			{ should: [] },
			{ comparator: 'not_matches', boost: 1 },
			{ negated: true, should: controls.should },
			{ should: [{ ...controls.should[0], attribute: 'other' }] },
			{ should: [{ ...controls.should[0], fields: [] }] },
			{ should: [{ ...controls.should[0], fields: ['missing'] }] },
			{ should: [{ comparator: 'matches_fuzzy', value: 'catxxog', fuzzyDistance: 2 }] },
		])
			await assert.rejects(
				async () => search(invalid),
				(error) => error.statusCode === 400
			);
		for (const operator of ['and', 'or'])
			await assert.rejects(
				async () =>
					collect(
						Product.search({
							operator,
							conditions: [
								{ ...condition, boost: 2 },
								{ ...condition, comparator: 'matches_fuzzy', value: 'catxxog', fuzzyDistance: 2 },
							],
						})
					),
				(error) => error.statusCode === 400 && /maxFuzzyDistance/.test(error.message)
			);
		for (const controls of [{ boost: 1 }, { should: [{ comparator: 'matches', value: 'widget' }] }]) {
			await assert.rejects(
				async () =>
					collect(Product.search({ conditions: [{ attribute: 'id', value: 'a', comparator: 'equals', ...controls }] })),
				/positive full-text/
			);
			await assert.rejects(
				async () =>
					collect(Product.search({ conditions: [{ operator: 'and', conditions: [condition], ...controls }] })),
				/positive full-text/
			);
			await assert.rejects(
				async () => collect(Product.search({ conditions: [condition], ...controls })),
				/positive full-text/
			);
		}
	});

	it('keeps custom iterable searches and re-evaluates later offset requests', async () => {
		Product = table({
			database: `fulltext-offset-contract-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
		});
		await Product.put(['a', 'b', 'c'].map((id) => ({ id, title: 'widget' })));
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const query = {
			conditions: [
				{
					attribute: 'catalogSearch',
					comparator: 'matches',
					value: 'widget',
					maxIndexLagMilliseconds: 0,
					waitForIndexMilliseconds: 5000,
				},
			],
			limit: 1,
		};
		class Filtered extends Product {
			search(target) {
				return super.search({ ...target, rowFilter: (record) => record.id !== 'a' });
			}
		}
		assert.strictEqual(Product.searchPage, undefined);
		assert.strictEqual(new Product().searchPage, undefined);
		assert.strictEqual(typeof Filtered.search(query)[Symbol.asyncIterator], 'function');
		assert.deepStrictEqual(ids(await collect(Filtered.search(query))), ['b']);
		assert.deepStrictEqual(ids(await collect(Filtered.search({ ...query, offset: 1 }))), ['c']);
		await Product.delete('b');
		assert.deepStrictEqual(ids(await collect(Filtered.search(query))), ['c']);
		assert.deepStrictEqual(await collect(Filtered.search({ ...query, offset: 1 })), []);
	});

	it('preserves fuzzy defaults, exact matching, transposition controls and preview admission', async () => {
		const searchDefinition = definition('catalogSearch', [{ name: 'title', weight: 1, highlight: true }]);
		searchDefinition.highlighting = { maxFragments: 2, fragmentLength: 80 };
		Product = table({
			database: `fulltext-fuzzy-controls-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [searchDefinition],
		});
		await Product.put('catalog', { title: 'catalog' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const condition = {
			attribute: 'catalogSearch',
			comparator: 'matches_fuzzy',
			value: 'catlaog',
			maxIndexLagMilliseconds: 0,
			waitForIndexMilliseconds: 30000,
		};
		const search = (options = {}) => collect(Product.search({ conditions: [{ ...condition, ...options }] }));
		assert.deepStrictEqual(ids(await search()), ['catalog']);
		assert.deepStrictEqual(await search({ fuzzyTranspositions: false }), []);
		assert.deepStrictEqual(await search({ fuzzyDistance: 0 }), []);
		const exact = await search({ value: 'catalog', fuzzyDistance: 0, includeHighlights: true });
		assert.deepStrictEqual(ids(exact), ['catalog']);
		assert(exact[0].$highlights.title.length > 0);
		await assert.rejects(
			async () => search({ value: 'catxxog', fuzzyDistance: 2 }),
			(error) => error.statusCode === 400 && /maxFuzzyDistance/.test(error.message)
		);
		for (const options of [
			{ fuzzyDistance: '1' },
			{ fuzzyDistance: 1.5 },
			{ fuzzyDistance: -1 },
			{ fuzzyTranspositions: 'false' },
			{ comparator: 'matches', fuzzyDistance: 1 },
		])
			await assert.rejects(
				async () => search(options),
				(error) => error.statusCode === 400
			);
	});

	it('rejects fuzzy controls on ordinary, full-text and mixed condition groups', async () => {
		Product = table({
			database: `fulltext-group-controls-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [definition('catalogSearch', [{ name: 'title', weight: 1 }])],
		});
		await Product.put('catalog', { title: 'catalog' });
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const ordinary = { attribute: 'id', comparator: 'equals', value: 'catalog' };
		const native = {
			attribute: 'catalogSearch',
			comparator: 'matches_fuzzy',
			value: 'catalog',
			maxIndexLagMilliseconds: 0,
			waitForIndexMilliseconds: 30000,
		};
		for (const conditions of [[ordinary], [native], [ordinary, native]]) {
			for (const controls of [{ fuzzyDistance: 1 }, { fuzzyTranspositions: false }]) {
				const group = { operator: 'and', conditions, ...controls };
				await assert.rejects(
					async () => collect(Product.search({ conditions: [group] })),
					(error) => error.statusCode === 400 && /on a full-text index condition/.test(error.message),
					`group with ${conditions.length} conditions and ${Object.keys(controls)[0]}`
				);
			}
		}
	});

	it('preserves per-leaf fuzzy controls and exact highlights through nested Boolean queries', async () => {
		const searchDefinition = definition('catalogSearch', [{ name: 'title', weight: 1, highlight: true }]);
		searchDefinition.highlighting = { maxFragments: 2, fragmentLength: 80 };
		Product = table({
			database: `fulltext-nested-fuzzy-${Date.now()}`,
			table: 'Product',
			audit: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
			],
			fullTextIndexes: [searchDefinition],
		});
		await Product.put([
			{ id: 'amber', title: 'catalog amber' },
			{ id: 'violet', title: 'catalog violet' },
			{ id: 'literal', title: 'catlaog amber' },
			{ id: 'blocked', title: 'catalog blocked' },
		]);
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 30000);
		const leaf = (value, options = {}) => ({
			attribute: 'catalogSearch',
			comparator: 'matches_fuzzy',
			value,
			includeHighlights: true,
			maxIndexLagMilliseconds: 0,
			waitForIndexMilliseconds: 30000,
			...options,
		});
		const excluded = leaf('blokced', { comparator: 'not_matches_fuzzy', fuzzyTranspositions: true });
		const cases = [
			{
				conditions: [
					leaf('catalog', { fuzzyDistance: 0 }),
					{ operator: 'or', conditions: [leaf('catlaog', { fuzzyTranspositions: true }), leaf('absent')] },
					excluded,
				],
				expected: ['amber', 'violet'],
			},
			{
				conditions: [
					{
						operator: 'or',
						conditions: [
							{ operator: 'and', conditions: [leaf('catalog', { fuzzyDistance: 0 }), leaf('absent')] },
							leaf('catlaog', { fuzzyDistance: 1, fuzzyTranspositions: false }),
						],
					},
					excluded,
				],
				expected: ['literal'],
			},
			{
				conditions: [
					leaf('catalog', { fuzzyDistance: 0 }),
					{
						operator: 'and',
						conditions: [
							excluded,
							leaf('vioelt', { comparator: 'not_matches_fuzzy', fuzzyDistance: 1, fuzzyTranspositions: false }),
						],
					},
				],
				expected: ['amber', 'violet'],
			},
		];
		for (const { conditions, expected } of cases) {
			const records = await collect(Product.search({ operator: 'and', conditions }));
			assert.deepStrictEqual(ids(records), expected);
			for (const record of records) {
				assert.deepStrictEqual(record.$highlights.title[0].spans, [{ start: 0, end: 7 }]);
			}
		}
		await assert.rejects(
			() =>
				collect(
					Product.search({
						conditions: [
							leaf('catalog'),
							{
								operator: 'or',
								conditions: [leaf('absent'), leaf('catxxog', { comparator: 'not_matches_fuzzy', fuzzyDistance: 2 })],
							},
						],
					})
				),
			(error) => error.statusCode === 400 && /maxFuzzyDistance/.test(error.message)
		);
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
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 60_000);

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
			).catch((error) => {
				error.message += ` (${comparator})`;
				throw error;
			});
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
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 60_000);

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
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 60_000);

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
				assert.strictEqual(ordinary.totalRelation, 'exact');
				assert.deepStrictEqual((await reader.searchPage({ query, limit: ordinary.hits.length })).hits, ordinary.hits);
				for (const limit of [17, 73, 113, 257]) {
					const page = await reader.searchPage({ query, limit });
					const sharedLength = Math.min(ordinary.hits.length, page.hits.length);
					assert.strictEqual(sharedLength, Math.min(ordinary.hits.length, limit));
					assert.deepStrictEqual(page.hits.slice(0, sharedLength), ordinary.hits.slice(0, sharedLength));
				}
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
				const tail = await walk(17);
				assert.deepStrictEqual(tail, await walk(113));
				const ordered = [...first.hits, ...tail];
				for (let n = 1; n < ordered.length; n++) {
					if (ordered[n - 1].score === ordered[n].score)
						assert(
							Buffer.compare(Buffer.from(ordered[n - 1].id), Buffer.from(ordered[n].id)) < 0,
							'equal-score native hits must advance by document-ID bytes'
						);
				}
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
		await waitFor(() => fullTextDerivedIndexReadiness(Product, 'catalogSearch').state === 'ready', 60_000);
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

		const previousPolicy = getFullTextTestConfiguration();
		try {
			setFullTextTestConfiguration({ ...previousPolicy, maxRawHitsPerRequest: 128 });
			await assert.rejects(
				search('matches', 'widget catalog', { rowFilter: (record) => tail.has(record.id) }),
				(error) => error.statusCode === 400 && error.message.includes('storage.fullText.maxRawHitsPerRequest')
			);
		} finally {
			setFullTextTestConfiguration(previousPolicy);
		}

		await assert.rejects(
			search('matches', 'widget catalog', { rowFilter: (record) => tail.has(record.id) }),
			(error) => error.statusCode === 400 && /maxRawHitsPerRequest/.test(error.message)
		);
		setFullTextTestConfiguration({
			...previousPolicy,
			maxRawHitsPerRequest: count * 3,
			maxResultsPerRequest: count,
		});
		try {
			assert.deepStrictEqual(
				(await search('matches', 'widget catalog', { rowFilter: (record) => tail.has(record.id) })).map(({ id }) => id),
				ordered.slice(info.limits.maxSearchWindow)
			);
			assert.deepStrictEqual(
				(await search('matches', 'widget catalog', { offset: info.limits.maxSearchWindow })).map(({ id }) => id),
				ordered.slice(info.limits.maxSearchWindow)
			);
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
		} finally {
			setFullTextTestConfiguration(previousPolicy);
		}
	});
});
