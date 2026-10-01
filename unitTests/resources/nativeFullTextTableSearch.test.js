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

function supportsPublishedBinding() {
	const glibcVersion =
		process.platform === 'linux' ? process.report?.getReport().header.glibcVersionRuntime : undefined;
	return (
		(process.platform === 'darwin' && process.arch === 'arm64') ||
		(process.platform === 'linux' && glibcVersion && ['arm64', 'x64'].includes(process.arch)) ||
		(process.platform === 'win32' && process.arch === 'x64')
	);
}

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

	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !supportsPublishedBinding()) this.skip();
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
});
