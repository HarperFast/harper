/**
 * Executes the native full-text schema, resource, JavaScript, REST, and Operations API examples published in
 * Harper's v5.3 documentation. This is the executable contract for
 * https://github.com/HarperFast/documentation/pull/691.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'full-text-search-docs');
const OPTIONS = { config: { threads: { count: 2 } }, env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' } };
const READER = { username: 'docs_fulltext_reader', password: 'Docs-fulltext-reader-691!' };
const READER_AUTH = `Basic ${Buffer.from(`${READER.username}:${READER.password}`).toString('base64')}`;

function ids(records: any[]): string[] {
	return records.map(({ id }) => id).sort();
}

suite('documented native full-text examples', (ctx: ContextWithHarper) => {
	let authorization: string;

	async function response(path: string, options: RequestInit = {}, auth = authorization) {
		return fetch(`${ctx.harper.httpURL}${path}`, {
			...options,
			headers: { 'Authorization': auth, 'Content-Type': 'application/json', ...options.headers },
			signal: AbortSignal.timeout(45_000),
		});
	}

	async function request(path: string, options: RequestInit = {}, expectedStatus = 200, auth = authorization) {
		const result = await response(path, options, auth);
		const text = await result.text();
		assert.strictEqual(result.status, expectedStatus, `${options.method ?? 'GET'} ${path}: ${text}`);
		return text ? JSON.parse(text) : undefined;
	}

	async function operation(body: Record<string, unknown>, expectedStatus = 200, auth = authorization): Promise<any> {
		const result = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(45_000),
		});
		const text = await result.text();
		assert.strictEqual(result.status, expectedStatus, `operation ${body.operation}: ${text}`);
		return text ? JSON.parse(text) : undefined;
	}

	async function waitForReady(database: string, table: string) {
		const deadline = Date.now() + 30_000;
		let states: string[] = [];
		do {
			const description = await operation({ operation: 'describe_table', database, table });
			assert.ok(Array.isArray(description.full_text_indexes), `${database}.${table} has no full-text indexes`);
			states = description.full_text_indexes.map(({ readiness }) => readiness.state);
			if (states.length > 0 && states.every((state) => state === 'ready')) return;
			assert.ok(!states.includes('unavailable'), `${database}.${table} full-text index is unavailable`);
			await delay(50);
		} while (Date.now() < deadline);
		assert.ok(states.length > 0 && states.every((state) => state === 'ready'), `${database}.${table}: ${states}`);
	}

	async function waitForCoverage(database: string, table: string, attribute: string, value: string) {
		const records = await operation({
			operation: 'search_by_conditions',
			database,
			table,
			conditions: [
				{
					attribute,
					comparator: 'matches',
					value,
					maxIndexLagMilliseconds: 0,
					waitForIndexMilliseconds: 30_000,
				},
			],
		});
		assert.ok(records.length > 0, `${database}.${table}.${attribute} reached current coverage without a match`);
	}

	async function documentedQuery(example: string) {
		return request('/DocumentedProductQueries/', {
			method: 'POST',
			body: JSON.stringify({ example }),
		});
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		await request(
			'/Product/',
			{
				method: 'POST',
				body: JSON.stringify({
					id: 'shoe-1',
					name: 'Waterproof trail running shoe',
					description: 'Lightweight shoe for wet mountain trails',
					tags: ['outdoor', 'trail'],
					category: 'footwear',
					price: 129,
				}),
			},
			201
		);

		await operation({
			operation: 'insert',
			database: 'catalog',
			table: 'Product',
			records: [
				{
					id: 'shoe-2',
					name: 'Waterproof leather hiking boot',
					description: 'Leather boot for wet trails',
					tags: ['outdoor', 'hiking'],
					category: 'footwear',
					price: 159,
				},
				{
					id: 'shoe-3',
					name: 'Waterproof city walking shoe',
					description: 'Lightweight road shoe',
					tags: ['road'],
					category: 'footwear',
					price: 99,
				},
				{
					id: 'tag-only',
					name: 'Everyday sneaker',
					description: 'Simple canvas footwear',
					tags: ['trail'],
					category: 'footwear',
					price: 80,
				},
				{
					id: 'expensive-trail',
					name: 'Trail shoe deluxe',
					description: 'Premium mountain footwear',
					tags: ['trail'],
					category: 'footwear',
					price: 220,
				},
				{
					id: 'seasonal',
					name: 'New seasonal product',
					description: 'Limited catalog release',
					tags: ['seasonal'],
					category: 'accessories',
					price: 25,
				},
				{
					id: 'rank-name',
					name: 'Aurora',
					description: 'Ordinary catalog item',
					category: 'accessories',
					price: 30,
				},
				{
					id: 'rank-description',
					name: 'Ordinary catalog item',
					description: 'Aurora',
					category: 'accessories',
					price: 30,
				},
				{
					id: 'highlight-bounds',
					name: 'Highlight bounds',
					description: `luminescent ${'catalog detail '.repeat(18)}`.repeat(8),
					category: 'documentation',
					price: 30,
				},
			],
		});
		await operation({
			operation: 'insert',
			database: 'data',
			table: 'Article',
			records: [{ id: 'article-1', body: 'Compact trail running article' }],
		});
		await operation({
			operation: 'insert',
			database: 'data',
			table: 'HighlightArticle',
			records: [
				{
					id: 'highlight-1',
					title: 'Trail guide',
					body: 'A trail running field guide with practical route details and equipment notes. '.repeat(8),
				},
			],
		});
		await operation({
			operation: 'insert',
			database: 'data',
			table: 'SynonymProduct',
			records: [
				{ id: 'synonym-shoe', description: 'Lightweight sneaker' },
				{ id: 'synonym-tv', description: 'Compact tv' },
			],
		});
		await operation({
			operation: 'insert',
			database: 'catalog',
			table: 'MultipleIndexProduct',
			records: [{ id: 'multi-1', name: 'Trail runner', tags: ['outdoor'] }],
		});
		await request('/WriteDocument/', {
			method: 'POST',
			body: JSON.stringify({ id: 'document-1', text: 'A luminous constellation lights the sky.' }),
		});
		await operation({
			operation: 'add_role',
			role: 'docs_fulltext_reader',
			permission: {
				super_user: false,
				catalog: {
					tables: {
						Product: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: ['id', 'name', 'description', 'tags', 'category', 'price'].map(
								(attribute_name) => ({
									attribute_name,
									read: attribute_name !== 'description',
									insert: false,
									update: false,
								})
							),
						},
					},
				},
			},
		});
		await operation({ operation: 'add_user', ...READER, role: 'docs_fulltext_reader', active: true });

		for (const [database, table] of [
			['catalog', 'Product'],
			['data', 'Article'],
			['data', 'HighlightArticle'],
			['data', 'SynonymProduct'],
			['catalog', 'MultipleIndexProduct'],
			['data', 'Document'],
		]) {
			await waitForReady(database, table);
		}
		for (const [database, table, attribute, value] of [
			['catalog', 'Product', 'catalogSearch', 'waterproof'],
			['data', 'Article', 'bodySearch', 'trail'],
			['data', 'HighlightArticle', 'articleSearch', 'trail'],
			['data', 'SynonymProduct', 'catalogSearch', 'sneaker'],
			['catalog', 'MultipleIndexProduct', 'titleSearch', 'trail'],
			['catalog', 'MultipleIndexProduct', 'tagSearch', 'outdoor'],
			['data', 'Document', 'contentSearch', 'constellation'],
		]) {
			await waitForCoverage(database, table, attribute, value);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('runs the documented Product schema, record write, and describe_table request', async () => {
		const record = await request('/Product/shoe-1');
		assert.deepStrictEqual(record, {
			id: 'shoe-1',
			name: 'Waterproof trail running shoe',
			description: 'Lightweight shoe for wet mountain trails',
			tags: ['outdoor', 'trail'],
			category: 'footwear',
			price: 129,
		});
		const description = await operation({ operation: 'describe_table', database: 'catalog', table: 'Product' });
		const index = description.full_text_indexes.find(({ name }) => name === 'catalogSearch');
		assert.deepStrictEqual(
			index.fields.map(({ name, weight, highlight }) => ({ name, weight, highlight: Boolean(highlight) })),
			[
				{ name: 'name', weight: 3, highlight: true },
				{ name: 'description', weight: 1, highlight: true },
				{ name: 'tags', weight: 1, highlight: false },
			]
		);
		assert.strictEqual(index.analyzer, 'english@2');
		assert.deepStrictEqual(index.highlighting, { maxFragments: 2, fragmentLength: 120 });
		assert.deepStrictEqual(index.query_modes, ['any', 'all', 'fuzzy', 'phrase', 'prefix', 'fuzzy-prefix']);
		assert.strictEqual(index.readiness.state, 'ready');
		assert.ok(!description.attributes.some(({ attribute }) => attribute === 'catalogSearch'));
		const openapi = await request('/openapi');
		assert.ok(!Object.hasOwn(openapi.components.schemas.Product.properties, 'catalogSearch'));
	});

	test('runs the documented SearchProducts resource with authorization and tag-only highlighting', async () => {
		const records = await request('/SearchProducts/', {
			method: 'POST',
			body: JSON.stringify({ q: 'trail', category: 'footwear' }),
		});
		assert.ok(ids(records).includes('shoe-1'));
		assert.ok(ids(records).includes('tag-only'));
		const shoe = records.find(({ id }) => id === 'shoe-1');
		assert.strictEqual(typeof shoe.$score, 'number');
		assert.ok(shoe.$highlights.name);
		const tagOnly = records.find(({ id }) => id === 'tag-only');
		assert.ok(!tagOnly.$highlights || !Object.hasOwn(tagOnly.$highlights, 'tags'));
		await request(
			'/SearchProducts/',
			{ method: 'POST', body: JSON.stringify({ q: 'trail', category: 'footwear' }) },
			401,
			''
		);
		await request('/SearchProducts/', { method: 'POST', body: JSON.stringify({}) }, 400);
		await request(
			'/SearchProducts/',
			{ method: 'POST', body: JSON.stringify({ q: 'trail', category: 'footwear' }) },
			403,
			READER_AUTH
		);
		const readable = await operation(
			{
				operation: 'search_by_conditions',
				database: 'catalog',
				table: 'Product',
				get_attributes: ['id', 'name'],
				conditions: [
					{
						attribute: 'catalogSearch',
						comparator: 'matches',
						value: 'waterproof',
						fields: ['name', 'tags'],
					},
				],
			},
			200,
			READER_AUTH
		);
		assert.ok(ids(readable).includes('shoe-1'));
		assert.ok(readable.every((record) => !Object.hasOwn(record, 'description')));
	});

	test('runs every documented Table.search query shape', async () => {
		const basic = await documentedQuery('basic');
		assert.ok(ids(basic).includes('shoe-1'));
		const negated = await documentedQuery('negated');
		assert.ok(ids(negated).includes('shoe-1'));
		assert.ok(!ids(negated).includes('shoe-2'));
		assert.deepStrictEqual(ids(await documentedQuery('restricted')), ['shoe-1']);
		const scored = await documentedQuery('score');
		assert.ok(scored.length > 0 && scored.every(({ $score }) => typeof $score === 'number'));
		const ranked = await documentedQuery('weight');
		assert.deepStrictEqual(
			ranked.map(({ id }) => id),
			['rank-name', 'rank-description']
		);
		assert.ok(ranked[0].$score > ranked[1].$score);
		const [highlighted] = await documentedQuery('highlights');
		assert.strictEqual(highlighted.id, 'shoe-1');
		assert.deepStrictEqual(highlighted.$highlights.name[0].spans, [{ start: 11, end: 24 }]);
		const structured = ids(await documentedQuery('structured-and'));
		assert.ok(structured.includes('shoe-1'));
		assert.ok(!structured.includes('shoe-2'));
		assert.ok(!structured.includes('expensive-trail'));
		assert.deepStrictEqual(ids(await documentedQuery('full-text-or')), ['shoe-1', 'shoe-2']);
		assert.deepStrictEqual(ids(await documentedQuery('freshness')), ['seasonal']);
		assert.deepStrictEqual(ids(await documentedQuery('tutorial-freshness')), ['seasonal']);
	});

	test('runs the documented REST term, phrase, prefix, negation, coverage, and count requests', async () => {
		const term = await request(
			'/Product/?catalogSearch=matches=waterproof%20trail&category=footwear&select(id,name,price,$score,$highlights)&limit(20)'
		);
		assert.ok(ids(term).includes('shoe-1'));
		assert.deepStrictEqual(ids(await request('/Product/?catalogSearch=matches_phrase=trail%20running&limit(20)')), [
			'shoe-1',
		]);
		assert.deepStrictEqual(
			ids(await request('/Product/?catalogSearch=matches_prefix=waterproof%20tra&select(id,name)&limit(10)')),
			['shoe-1', 'shoe-2']
		);
		assert.ok(ids(await request('/Product/?catalogSearch=matches_fuzzy=waterprof&limit(20)')).includes('shoe-1'));
		assert.ok(
			ids(await request('/Product/?catalogSearch=matches_fuzzy_prefix=waterproof%20tral&limit(20)')).includes('shoe-1')
		);
		const negated = await request(
			'/Product/?catalogSearch=matches=waterproof&catalogSearch=not_matches=leather&limit(20)'
		);
		assert.ok(ids(negated).includes('shoe-1'));
		assert.ok(!ids(negated).includes('shoe-2'));

		const counted = await response('/Product/?catalogSearch=matches=waterproof&limit(20)', {
			headers: { Prefer: 'count=exact' },
		});
		assert.strictEqual(counted.status, 200);
		assert.strictEqual(counted.headers.get('preference-applied'), 'count=exact');
		assert.match(counted.headers.get('content-range') ?? '', /\/\*$/);
		assert.match(
			counted.headers.get('harper-index-coverage') ?? '',
			/^(current; lag=0|bounded; lag=\d+(?:\.\d+)?); tolerance=3000$/
		);
		await counted.arrayBuffer();
		await request('/Product/?catalogSearch=matches=waterproof&select(id,name)', {}, 403, READER_AUTH);
	});

	test('runs the documented search_by_conditions request', async () => {
		const records = await operation({
			operation: 'search_by_conditions',
			database: 'catalog',
			table: 'Product',
			limit: 20,
			get_attributes: ['id', 'name', '$score', '$highlights'],
			conditions: [
				{
					attribute: 'catalogSearch',
					comparator: 'matches_all',
					value: 'waterproof trail',
					fields: ['name', 'description'],
					includeHighlights: true,
					maxIndexLagMilliseconds: 0,
					waitForIndexMilliseconds: 10000,
				},
			],
		});
		assert.deepStrictEqual(ids(records), ['shoe-1', 'shoe-2']);
		assert.ok(records.every(({ $score }) => typeof $score === 'number'));
		assert.ok(records.every(({ $highlights }) => $highlights.name || $highlights.description));
	});

	test('runs the documented reduced phrase and prefix configuration', async () => {
		const description = await operation({ operation: 'describe_table', database: 'data', table: 'Article' });
		const index = description.full_text_indexes.find(({ name }) => name === 'bodySearch');
		assert.deepStrictEqual(index.query_modes, ['any', 'all', 'fuzzy']);
		assert.strictEqual(index.positions, false);
		assert.strictEqual(index.surface_terms, false);
		assert.strictEqual(index.highlighting, false);

		const base = {
			operation: 'search_by_conditions',
			database: 'data',
			table: 'Article',
			conditions: [{ attribute: 'bodySearch', comparator: 'matches', value: 'trail' }],
		};
		assert.deepStrictEqual(ids(await operation(base)), ['article-1']);
		for (const [comparator, expectedError] of [
			['matches_phrase', /does not store phrase positions/],
			['matches_prefix', /does not store surface terms/],
			['matches_fuzzy_prefix', /does not store surface terms/],
		]) {
			const result = await operation(
				{
					...base,
					conditions: [{ attribute: 'bodySearch', comparator, value: 'trail running' }],
				},
				400
			);
			assert.match(result.error, expectedError);
		}
		const highlightError = await operation({ ...base, get_attributes: ['id', '$highlights'] }, 400);
		assert.match(highlightError.error, /does not enable highlighting/);
	});

	test('runs the documented highlighting, synonym, multiple-index, and Blob declarations', async () => {
		const productHighlights = await operation({
			operation: 'search_by_conditions',
			database: 'catalog',
			table: 'Product',
			get_attributes: ['id', '$highlights'],
			conditions: [
				{
					attribute: 'catalogSearch',
					comparator: 'matches',
					value: 'luminescent',
					fields: ['description'],
					includeHighlights: true,
				},
			],
		});
		assert.deepStrictEqual(ids(productHighlights), ['highlight-bounds']);
		const [productDescriptionHighlights] = productHighlights[0].$highlights.description;
		assert.strictEqual(productDescriptionHighlights.fragments.length, 2);
		assert.ok(productDescriptionHighlights.fragments.every(({ text }) => text.length <= 120));

		const highlighted = await operation({
			operation: 'search_by_conditions',
			database: 'data',
			table: 'HighlightArticle',
			get_attributes: ['id', '$highlights'],
			conditions: [{ attribute: 'articleSearch', comparator: 'matches_phrase', value: 'trail running' }],
		});
		assert.deepStrictEqual(ids(highlighted), ['highlight-1']);
		const [bodyHighlights] = highlighted[0].$highlights.body;
		assert.ok(bodyHighlights.fragments.length > 0 && bodyHighlights.fragments.length <= 3);
		assert.ok(bodyHighlights.fragments.every(({ text }) => text.length <= 160));
		assert.ok(bodyHighlights.spans.length > 0);

		for (const value of ['shoe', 'trainer']) {
			const records = await operation({
				operation: 'search_by_conditions',
				database: 'data',
				table: 'SynonymProduct',
				conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value }],
			});
			assert.deepStrictEqual(ids(records), ['synonym-shoe'], value);
		}
		assert.deepStrictEqual(
			ids(
				await operation({
					operation: 'search_by_conditions',
					database: 'data',
					table: 'SynonymProduct',
					conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'television' }],
				})
			),
			['synonym-tv']
		);

		const title = await operation({
			operation: 'search_by_conditions',
			database: 'catalog',
			table: 'MultipleIndexProduct',
			conditions: [{ attribute: 'titleSearch', comparator: 'matches', value: 'trail' }],
		});
		const tags = await operation({
			operation: 'search_by_conditions',
			database: 'catalog',
			table: 'MultipleIndexProduct',
			conditions: [{ attribute: 'tagSearch', comparator: 'matches', value: 'outdoor' }],
		});
		assert.deepStrictEqual(ids(title), ['multi-1']);
		assert.deepStrictEqual(ids(tags), ['multi-1']);
		await operation(
			{
				operation: 'search_by_conditions',
				database: 'catalog',
				table: 'MultipleIndexProduct',
				conditions: [
					{ attribute: 'titleSearch', comparator: 'matches', value: 'trail' },
					{ attribute: 'tagSearch', comparator: 'matches', value: 'outdoor' },
				],
			},
			400
		);

		const documents = await operation({
			operation: 'search_by_conditions',
			database: 'data',
			table: 'Document',
			conditions: [{ attribute: 'contentSearch', comparator: 'matches', value: 'constellation' }],
		});
		assert.deepStrictEqual(ids(documents), ['document-1']);
	});
});
