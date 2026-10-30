import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import * as native from '@harperfast/fulltext/native';
import { createHash } from 'node:crypto';
import { previousFullTextProcess } from '../../unitTests/resources/fixtures/fullTextUpgradeHelpers.cjs';

const { runtimeInfo } = native;

const FIXTURE_PATH = resolve(import.meta.dirname, 'full-text-search');
const OPTIONS = {
	config: {
		threads: { count: 2 },
		storage: { fullText: { query: { maxQueryTerms: 128, maxQueryClauses: 512, maxFuzzyDistance: 2 } } },
	},
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const READER = { username: 'fulltext_reader', password: 'Fulltext-reader-2855!' };
const READER_AUTH = `Basic ${Buffer.from(`${READER.username}:${READER.password}`).toString('base64')}`;
const PAGE_IDS = Array.from({ length: 300 }, (_, index) => `page-${String(index).padStart(3, '0')}`);

function ids(records: any[]): string[] {
	return records.map(({ id }) => id).sort();
}

function query(value: string, condition: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
	return {
		conditions: [
			{
				attribute: 'catalogSearch',
				comparator: 'matches',
				value,
				maxIndexLagMilliseconds: 0,
				waitForIndexMilliseconds: 30_000,
				...condition,
			},
		],
		...options,
	};
}

async function assertOperationsQueryRejection(
	operationsAPIURL: string,
	authorization: string,
	target: ReturnType<typeof query>,
	message: string
) {
	const response = await fetch(operationsAPIURL, {
		method: 'POST',
		headers: {
			'Authorization': authorization,
			'Content-Type': 'application/json',
			'Accept': 'application/x-ndjson',
		},
		body: JSON.stringify({ operation: 'search_by_conditions', schema: 'data', table: 'Product', ...target }),
		signal: AbortSignal.timeout(45_000),
	});
	const body = await response.text();
	assert.strictEqual(response.status, 200, body);
	assert.match(response.headers.get('content-type'), /^application\/x-ndjson(?:;|$)/);
	assert.deepStrictEqual(body.trim().split('\n').map(JSON.parse), [
		{ $harperStreamError: { error: 'ClientError', message, status: 400 } },
	]);
}

suite('deployed full-text fields and native search', (ctx: ContextWithHarper) => {
	let authorization: string;

	async function request(path: string, options: RequestInit = {}, expectedStatus = 200) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			...options,
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json', ...options.headers },
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		assert.strictEqual(response.status, expectedStatus, `${options.method ?? 'GET'} ${path}: ${text}`);
		return text ? JSON.parse(text) : undefined;
	}

	async function operation(body: Record<string, unknown>) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		assert.strictEqual(response.status, 200, `operation ${body.operation}: ${text}`);
		return JSON.parse(text);
	}

	async function search(target: ReturnType<typeof query>, auth = authorization, expectedStatus = 200) {
		const records = await request(
			'/SearchProduct/',
			{ method: 'POST', headers: { Authorization: auth }, body: JSON.stringify(target) },
			expectedStatus
		);
		if (expectedStatus === 200) {
			assert.ok(Array.isArray(records), 'search must return an array');
			assert.ok(
				records.every((record) => typeof record.id === 'string'),
				`search returned an invalid record: ${JSON.stringify(records)}`
			);
		}
		return records;
	}

	async function waitForReady(table: string) {
		const deadline = Date.now() + 30_000;
		let state: string;
		do {
			const description = await operation({ operation: 'describe_table', schema: 'data', table });
			state = description.full_text_indexes[0].readiness.state;
			if (state === 'ready') return;
			assert.notStrictEqual(state, 'unavailable', `${table} full-text index is unavailable`);
			await delay(50);
		} while (Date.now() < deadline);
		assert.strictEqual(state, 'ready', `${table} full-text index did not become ready`);
	}

	async function waitForIds(target: ReturnType<typeof query>, expected: string[]) {
		const deadline = Date.now() + 30_000;
		let actual: string[] = [];
		do {
			actual = ids(await search(target));
			if (JSON.stringify(actual) === JSON.stringify([...expected].sort())) return;
			await delay(50);
		} while (Date.now() < deadline);
		assert.deepStrictEqual(actual, [...expected].sort(), 'full-text results did not converge');
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		await operation({
			operation: 'insert',
			schema: 'data',
			table: 'Product',
			records: [
				{ id: 'one', title: 'Waterproof Trail Running Shoes', tags: ['outdoor', 'trail'], owner: READER.username },
				{ id: 'two', title: 'Waterproof Road Shoes', tags: ['outdoor', 'road'], owner: READER.username },
				{ id: 'three', title: 'Wireless Headphones', tags: ['electronics'], owner: READER.username },
				{ id: 'rank-title', title: 'Orchard', description: 'Garden', owner: READER.username },
				{ id: 'rank-description', title: 'Garden', description: 'Orchard', owner: READER.username },
				{ id: 'private', title: 'Private nebula', description: 'classified', owner: 'another-user' },
				...PAGE_IDS.map((id, index) => ({
					id,
					title: 'Pagination telescope',
					category: index % 2 ? 'odd' : 'even',
					owner: READER.username,
				})),
			],
		});
		await operation({
			operation: 'insert',
			schema: 'data',
			table: 'ProductOrder',
			records: [
				{ id: 'order-one', productId: 'one' },
				{ id: 'order-private', productId: 'private' },
			],
		});
		await waitForReady('Product');
		await waitForIds(query('waterproof'), ['one', 'two']);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('adopts host query capacity and fuzzy controls through two-worker HTTP and operations search', async () => {
		const fixtureIds = [
			'capacity-late',
			...Array.from({ length: 135 }, (_, i) => `fuzzy-control-${String(i).padStart(3, '0')}`),
		];
		try {
			await operation({
				operation: 'insert',
				schema: 'data',
				table: 'Product',
				records: [
					{ id: 'capacity-late', title: 'qword064' },
					...Array.from({ length: 135 }, (_, i) => ({
						id: `fuzzy-control-${String(i).padStart(3, '0')}`,
						title: 'catalog',
					})),
				],
			});
			const late = await request('/SearchProduct/', {
				method: 'POST',
				body: JSON.stringify(
					query(Array.from({ length: 65 }, (_, i) => `qword${String(i).padStart(3, '0')}`).join(' '), {
						fields: ['title'],
					})
				),
			});
			assert.deepStrictEqual(ids(late), ['capacity-late']);
			const result = await operation({
				operation: 'search_by_conditions',
				schema: 'data',
				table: 'Product',
				...query('catxxog', { comparator: 'matches_fuzzy', fuzzyDistance: 2, fields: ['title'] }, { limit: 140 }),
			});
			assert.strictEqual(result.length, 135);
			const misses = await operation({
				operation: 'search_by_conditions',
				schema: 'data',
				table: 'Product',
				...query('catxxog', { comparator: 'matches_fuzzy', fuzzyDistance: 1, fields: ['title'] }),
			});
			assert.deepStrictEqual(misses, []);
			const traversed = await request('/SearchProduct/', {
				method: 'POST',
				body: JSON.stringify(
					query(
						'catxxog',
						{ comparator: 'matches_fuzzy_prefix', fuzzyDistance: 2, fields: ['title'], includeHighlights: true },
						{ limit: 130, offset: 2 }
					)
				),
			});
			assert.strictEqual(traversed.length, 130);
			assert(
				traversed.every((record) => record.id.startsWith('fuzzy-control-') && record.$highlights?.title?.length > 0)
			);
			for (const controls of [{ fuzzyDistance: '2' }, { fuzzyTranspositions: 'false' }]) {
				const response = await fetch(ctx.harper.operationsAPIURL, {
					method: 'POST',
					headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
					body: JSON.stringify({
						operation: 'search_by_conditions',
						schema: 'data',
						table: 'Product',
						...query('catalog', { comparator: 'matches_fuzzy', ...controls }),
					}),
					signal: AbortSignal.timeout(45000),
				});
				assert.strictEqual(response.status, 400, await response.text());
			}
		} finally {
			await operation({
				operation: 'delete',
				schema: 'data',
				table: 'Product',
				ids: fixtureIds,
			});
		}
	});

	test('enforces compiled clause capacity independently of per-leaf analyzed terms through both public paths', async () => {
		const target = (count: number) => ({
			operator: 'or',
			conditions: Array.from({ length: count }, () => query('waterproof', { fields: ['title'] }).conditions[0]),
		});
		// Native accounting charges each OR child plus its single-field term: 256 * 2 = 512.
		for (const count of [129, 256, 257]) {
			const clauses = count * 2;
			const expectedStatus = clauses <= 512 ? 200 : 400;
			const targetQuery = target(count);
			await assert.doesNotReject(async () => {
				const records = await search(targetQuery, authorization, expectedStatus);
				if (expectedStatus === 200) assert.deepStrictEqual(ids(records), ['one', 'two']);
			}, `HTTP compiled-clause boundary: ${clauses} clauses, expected ${expectedStatus}`);
			await assert.doesNotReject(
				async () => {
					if (expectedStatus === 400)
						await assertOperationsQueryRejection(
							ctx.harper.operationsAPIURL,
							authorization,
							targetQuery,
							"Full-text query on 'catalogSearch' is invalid; check its syntax and storage.fullText.query limits"
						);
					else {
						const records = await operation({
							operation: 'search_by_conditions',
							schema: 'data',
							table: 'Product',
							...targetQuery,
						});
						assert.deepStrictEqual(ids(records), ['one', 'two']);
					}
				},
				`Operations compiled-clause boundary: ${clauses} clauses, expected rejection: ${expectedStatus === 400}`
			);
		}
		assert.deepStrictEqual(ids(await search(query('waterproof'))), ['one', 'two']);
		assert.deepStrictEqual(
			ids(
				await operation({ operation: 'search_by_conditions', schema: 'data', table: 'Product', ...query('waterproof') })
			),
			['one', 'two']
		);
	});

	test('loads the pinned native package and exposes a ready index without a stored virtual attribute', async () => {
		const info = await runtimeInfo();
		const packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, '../..', 'package.json'), 'utf8'));
		assert.strictEqual(info.packageVersion, packageJson.optionalDependencies['@harperfast/fulltext']);
		assert.strictEqual(info.mutationBatchApiVersion, 5);
		assert.strictEqual(info.nativeAbiVersion, 13);
		assert.strictEqual(info.queryApiVersion, 7);
		assert.ok(info.queryClassIsolationMinimumSearchThreads > 0);
		const description = await operation({ operation: 'describe_table', schema: 'data', table: 'Product' });
		const index = description.full_text_indexes.find(({ name }) => name === 'catalogSearch');
		assert.strictEqual(index.readiness.state, 'ready');
		assert.deepStrictEqual(
			index.fields.map(({ name }) => name),
			['title', 'description', 'tags', 'content']
		);
		assert.ok(!description.attributes.some(({ attribute }) => attribute === 'catalogSearch'));
		const { Product } = await request('/FullTextState/');
		assert.deepStrictEqual(Product.fields, ['catalogSearch']);
		assert.ok(!Product.attributes.includes('catalogSearch'));
		assert.ok(!Object.hasOwn(Product.properties, 'catalogSearch'));
		const openapi = await request('/openapi');
		assert.ok(openapi.paths['/Product/']);
		assert.ok(!Object.hasOwn(openapi.components.schemas.Product.properties, 'catalogSearch'));
		assert.ok(!JSON.stringify(openapi).includes('"type":"FullText"'));
		const record = await request('/Product/one');
		assert.strictEqual(record.title, 'Waterproof Trail Running Shoes');
		assert.ok(!Object.hasOwn(record, 'catalogSearch'));
	});

	test('returns exact query-mode matches from Table.search and the REST parser', async () => {
		const cases: [string, string, string[]][] = [
			['matches', 'trail headphones', ['one', 'three']],
			['matches_all', 'waterproof shoes', ['one', 'two']],
			['matches_phrase', 'trail running', ['one']],
			['matches_prefix', 'waterproof trai', ['one']],
			['matches_fuzzy', 'waterprof', ['one', 'two']],
			['matches_fuzzy_prefix', 'waterproof tral', ['one']],
		];
		for (const [comparator, value, expected] of cases) {
			const results = await search(query(value, { comparator }));
			assert.deepStrictEqual(ids(results), expected, comparator);
			const rest = await request(
				`/Product/?catalogSearch=${comparator}=${encodeURIComponent(value)}&select(id,title,$score)`
			);
			assert.deepStrictEqual(ids(rest), expected, `REST ${comparator}`);
			assert.ok(rest.every(({ $score }) => typeof $score === 'number'));
		}
		assert.deepStrictEqual(ids(await search(query('electronics', { fields: ['tags'] }))), ['three']);
		const ranked = await search(query('orchard', {}, { select: ['id', '$score'] }));
		assert.deepStrictEqual(
			ranked.map(({ id }) => id),
			['rank-title', 'rank-description']
		);
		assert.ok(ranked[0].$score > ranked[1].$score);
	});

	test('preserves literal search text in REST full-text comparators', async () => {
		const values = ['null', 'number:1', 'boolean:true', 'date:2026-09-28', 'string:null', 'status:ready'];
		await request(
			'/Product/literal-text',
			{ method: 'PUT', body: JSON.stringify({ title: values.join(' '), owner: READER.username }) },
			204
		);
		await waitForIds(query('null'), ['literal-text']);
		for (const value of values) {
			const structured = await search(query(value, { comparator: 'matches_phrase' }));
			assert.deepStrictEqual(ids(structured), ['literal-text'], value);
			for (const text of [value, encodeURIComponent(value)]) {
				const rest = await request(`/Product/?catalogSearch=matches_phrase=${text}&select(id,title)`);
				assert.deepStrictEqual(ids(rest), ids(structured), `REST ${text}`);
			}
		}
	});

	test('returns opt-in highlights and score metadata consistently through both public paths', async () => {
		const target = query(
			'trail running',
			{ comparator: 'matches_phrase', includeHighlights: true },
			{
				select: ['id', 'title', '$score', '$highlights'],
			}
		);
		const [record] = await search(target);
		assert.strictEqual(typeof record.$score, 'number');
		assert.deepStrictEqual(record.$highlights.title[0].spans, [{ start: 11, end: 24 }]);
		assert.ok(record.$highlights.title.length <= 2);
		const [rest] = await request(
			'/Product/?catalogSearch=matches_phrase=trail%20running&select(id,title,$score,$highlights)'
		);
		assert.deepStrictEqual(rest, record);
		const [withoutHighlights] = await search(query('trail running', { comparator: 'matches_phrase' }));
		assert.ok(!Object.hasOwn(withoutHighlights, '$highlights'));
	});

	test('searches text/plain Blob sources and returns bounded opt-in fragments', async () => {
		await request('/WriteSearchBlob/', {
			method: 'POST',
			body: JSON.stringify({ id: 'blob', text: 'A luminous constellation lights the sky. '.repeat(12) }),
		});
		const target = query(
			'constellation',
			{ fields: ['content'], includeHighlights: true },
			{
				select: ['id', '$score', '$highlights'],
			}
		);
		await waitForIds(target, ['blob']);
		const [record] = await search(target);
		assert.strictEqual(typeof record.$score, 'number');
		assert.ok(record.$highlights.content.length > 0);
		for (const value of record.$highlights.content) {
			assert.ok(value.fragments.length > 0 && value.fragments.length <= 2);
			assert.ok(value.fragments.every(({ text }) => text.length <= 80));
			assert.ok(value.spans.length > 0);
		}
	});

	test('filters and pages beyond a native 256-candidate page without duplicates or missing ids', async () => {
		const target = query('pagination');
		const all = await search(target);
		assert.deepStrictEqual(ids(all), PAGE_IDS);
		const page = await search({ ...target, offset: 250, limit: 35 });
		assert.deepStrictEqual(
			page.map(({ id }) => id),
			all.slice(250, 285).map(({ id }) => id)
		);
		const filtered = await search({
			...target,
			operator: 'and',
			conditions: [...target.conditions, { attribute: 'category', comparator: 'equals', value: 'even' }],
		});
		assert.deepStrictEqual(
			ids(filtered),
			PAGE_IDS.filter((_, index) => index % 2 === 0)
		);
		const rest = await request('/Product/?catalogSearch=matches=pagination&limit(250,285)&select(id,title)');
		assert.deepStrictEqual(
			rest.map(({ id }) => id),
			page.map(({ id }) => id)
		);
	});

	test('rejects removed paging functions before a collection delete can run', async () => {
		for (const option of ['continuation()', 'continuation(token)', 'closeContinuation()']) {
			for (const method of ['GET', 'DELETE']) {
				const response = await fetch(`${ctx.harper.httpURL}/Product/?catalogSearch=matches=pagination&${option}`, {
					method,
					headers: { Authorization: authorization },
					signal: AbortSignal.timeout(45000),
				});
				assert.strictEqual(response.ok, false);
				assert.strictEqual((await response.json()).code, 'SyntaxViolation');
			}
		}
		assert.deepStrictEqual(ids(await search(query('pagination'))), PAGE_IDS);
	});

	test('fills REST autocomplete pages after structured filtering and beyond the first native batch', async () => {
		const all = await search(query('pagination'));
		const expected = all
			.filter(({ category }) => category === 'even')
			.slice(0, 100)
			.map(({ id }) => id);
		for (const comparator of ['matches_prefix', 'matches_fuzzy_prefix']) {
			const results = await request(
				`/Product/?catalogSearch=${comparator}=pagin&category=even&limit(100)&select(id,title)`
			);
			assert.deepStrictEqual(
				results.map(({ id }) => id),
				expected
			);
			const larger = await request(`/Product/?catalogSearch=${comparator}=pagin&limit(150)&select(id,title)`);
			assert.deepStrictEqual(
				larger.map(({ id }) => id),
				all.slice(0, 150).map(({ id }) => id)
			);
		}
	});

	test('preserves source permissions and row filters for non-admin searches', async () => {
		await operation({
			operation: 'add_role',
			role: 'fulltext_reader',
			permission: {
				super_user: false,
				data: {
					tables: {
						Product: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: ['id', 'title', 'description', 'tags', 'content', 'owner', 'category'].map(
								(name) => ({
									attribute_name: name,
									read: name !== 'description' && name !== 'content',
									insert: false,
									update: false,
								})
							),
						},
						ProductOrder: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: ['id', 'productId'].map((attribute_name) => ({
								attribute_name,
								read: true,
								insert: false,
								update: false,
							})),
						},
					},
				},
			},
		});
		await operation({ operation: 'add_user', ...READER, role: 'fulltext_reader', active: true });
		await operation({
			operation: 'add_role',
			role: 'fulltext_denied',
			permission: {
				super_user: false,
				data: {
					tables: { Product: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] } },
				},
			},
		});
		await operation({
			operation: 'add_user',
			username: 'fulltext_denied',
			password: READER.password,
			role: 'fulltext_denied',
			active: true,
		});
		const deniedAuth = `Basic ${Buffer.from(`fulltext_denied:${READER.password}`).toString('base64')}`;
		await search(query('waterproof'), deniedAuth, 403);
		await request('/Product/?catalogSearch=matches=waterproof', { headers: { Authorization: deniedAuth } }, 403);

		await search(query('waterproof'), READER_AUTH, 403);
		await request(
			'/Product/?catalogSearch=matches=waterproof&select(id,$score)',
			{
				headers: { Authorization: READER_AUTH },
			},
			403
		);
		const allowed = await search(
			query(
				'waterproof',
				{ fields: ['title'], includeHighlights: true },
				{
					select: ['id', 'title', '$score', '$highlights'],
				}
			),
			READER_AUTH
		);
		assert.deepStrictEqual(ids(allowed), ['one', 'two']);
		const restAllowed = await request('/Product/', {
			method: 'QUERY',
			headers: { Authorization: READER_AUTH },
			body: JSON.stringify(
				query(
					'waterproof',
					{ fields: ['title'], includeHighlights: true },
					{ select: ['id', 'title', '$score', '$highlights'] }
				)
			),
		});
		assert.deepStrictEqual(restAllowed, allowed);
		const restHidden = await request('/Product/', {
			method: 'QUERY',
			headers: { Authorization: READER_AUTH },
			body: JSON.stringify(query('nebula', { fields: ['title'] }, { select: ['id', 'title'] })),
		});
		assert.deepStrictEqual(restHidden, []);
		assert.ok(allowed.every(({ $score, $highlights }) => typeof $score === 'number' && $highlights.title));
		assert.deepStrictEqual(await search(query('nebula', { fields: ['title'] }, { select: ['id'] }), READER_AUTH), []);
		assert.deepStrictEqual(ids(await search(query('nebula'))), ['private']);
		const ordinaryRelationship = await request('/ProductOrder/', {
			method: 'QUERY',
			headers: { Authorization: READER_AUTH },
			body: JSON.stringify({
				conditions: [
					{ attribute: ['product', 'title'], comparator: 'equals', value: 'Waterproof Trail Running Shoes' },
				],
				select: ['id'],
			}),
		});
		assert.deepStrictEqual(ordinaryRelationship, [{ id: 'order-one' }]);
		await request(
			'/ProductOrder/',
			{
				method: 'QUERY',
				headers: { Authorization: READER_AUTH },
				body: JSON.stringify({
					conditions: [{ attribute: ['product', 'catalogSearch'], comparator: 'matches', value: 'classified' }],
					select: ['id'],
				}),
			},
			400
		);
	});

	test('rejects writes, projection, sorting, and scalar comparisons against a full-text field', async () => {
		await request('/Product/one', { method: 'PATCH', body: JSON.stringify({ catalogSearch: 'shadow' }) }, 400);
		await request(
			'/Product/shadow',
			{ method: 'PUT', body: JSON.stringify({ title: 'Shadow', catalogSearch: 'shadow' }) },
			400
		);
		await request('/Product/?select(catalogSearch)', {}, 400);
		await request('/Product/?sort(catalogSearch)', {}, 400);
		await request('/Product/?catalogSearch=equals=shadow', {}, 400);
	});

	test('converges after public insert, update and delete, including concurrent writes and searches', async () => {
		await request(
			'/Product/mutation',
			{
				method: 'PUT',
				body: JSON.stringify({ title: 'Transient comet', owner: READER.username }),
			},
			204
		);
		await waitForIds(query('transient'), ['mutation']);
		await request(
			'/Product/mutation',
			{ method: 'PATCH', body: JSON.stringify({ title: 'Persistent asteroid' }) },
			204
		);
		await waitForIds(query('transient'), []);
		await waitForIds(query('asteroid'), ['mutation']);
		const [duringWrite] = await Promise.all([
			search(query('pagination')),
			request('/Product/concurrent', { method: 'PUT', body: JSON.stringify({ title: 'Pagination telescope' }) }, 204),
		]);
		assert.ok(duringWrite.length >= PAGE_IDS.length && duringWrite.length <= PAGE_IDS.length + 1);
		assert.strictEqual(new Set(ids(duringWrite)).size, duringWrite.length);
		assert.deepStrictEqual(
			ids(duringWrite).filter((id) => id !== 'concurrent'),
			PAGE_IDS
		);
		await waitForIds(query('pagination'), [...PAGE_IDS, 'concurrent']);
		await request('/Product/mutation', { method: 'DELETE' });
		await waitForIds(query('asteroid'), []);
	});

	test('upgrades a real 0.5 checkpoint on two workers and recovers after an old-engine refusal', async () => {
		const records = [
			{ id: 'upgrade-added', title: 'added waterproof' },
			{ id: 'upgrade-ad', title: 'ad' },
			{ id: 'upgrade-deleted', title: 'removed migrationwitness' },
		];
		for (const record of records) {
			await request(`/LifecycleProduct/${record.id}`, { method: 'PUT', body: JSON.stringify(record) }, 204);
		}
		await waitForReady('LifecycleProduct');
		const searchLifecycle = (text: string) =>
			request('/LifecycleProduct/', { method: 'QUERY', body: JSON.stringify(query(text)) });
		assert.deepStrictEqual(ids(await searchLifecycle('added')), ['upgrade-added']);
		assert.deepStrictEqual(ids(await searchLifecycle('ad')), ['upgrade-ad']);
		const before = (await request('/FullTextState/')).LifecycleProduct;
		const previousLogPath = join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
		const previousLogLength = (await readFile(previousLogPath, 'utf8')).length;
		await killHarper(ctx);
		assert.ok(ctx.harper.process.exitCode !== null || ctx.harper.process.signalCode !== null);
		const digest = (value: string) => createHash('sha256').update(value).digest('hex');
		const configuration = {
			path: join(before.storePath, `${digest('LifecycleProduct/catalogSearch')}.fulltext`),
			indexId: 'fulltext:LifecycleProduct/catalogSearch',
			generation: digest(`${before.tableId}:${before.generations.catalogSearch}`),
			fields: [{ name: 'title', weight: 3 }],
			analyzer: 'english@2',
			stopWords: true,
			positions: true,
			surfaceTerms: true,
			synonyms: [],
			limits: {
				indexingThreads: 2,
				searchThreads: 2,
				writerMemoryBytes: 64 * 1024 * 1024,
				maxQueuedCommands: 16,
				maxQueuedBytes: 64 * 1024 * 1024,
				maxBatchBytes: 8 * 1024 * 1024,
			},
		};
		const checkpoint = native.inspectNativeFullTextIndex(configuration);
		assert.strictEqual(checkpoint.state, 'checkpointed', 'seed must replace the actual declared index');
		const reader = await native.openNativeFullTextReader(configuration);
		const documents = [];
		try {
			for (const record of records) {
				const hits = (await reader.search({ text: record.title, mode: 'all', exactTotal: true })).hits;
				assert.strictEqual(hits.length, 1, record.id);
				documents.push({ id: hits[0].id, version: hits[0].version, fields: { title: record.title } });
			}
		} finally {
			await reader.close();
		}
		await native.resetNativeFullTextIndex({ path: configuration.path, indexId: configuration.indexId });
		const seeded = previousFullTextProcess(
			'seed',
			configuration,
			[...documents, { id: 'native-only-ghost', version: '1', fields: { title: 'migrationghost' } }],
			checkpoint.committedPayload
		);
		assert.deepStrictEqual(seeded.inspection, checkpoint);
		assert.deepStrictEqual(seeded.ghostIds, ['native-only-ghost']);
		assert.deepStrictEqual(native.inspectNativeFullTextIndex(configuration), {
			state: 'incompatible',
			code: 'E_IDENTITY_MISMATCH',
		});
		await startHarper(ctx, OPTIONS);
		const deadline = Date.now() + 30_000;
		let ready = false;
		do {
			let response: Response;
			let body: string;
			try {
				response = await fetch(`${ctx.harper.httpURL}/LifecycleProduct/?catalogSearch=matches=ad`, {
					headers: { Authorization: authorization },
					signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
				});
				body = await response.text();
			} catch (error) {
				if (error.name === 'TimeoutError')
					assert.fail('upgraded public search did not become ready before the deadline');
				assert.ok(!response || response.status === 200, String(error));
				assert.ok(
					error.name === 'TypeError' && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code),
					String(error.cause ?? error)
				);
				await delay(25);
				continue;
			}
			assert.ok(response.status === 200 || response.status === 503, body);
			if (response.status === 200) {
				const records = JSON.parse(body);
				assert.ok(Array.isArray(records));
				assert.deepStrictEqual(ids(records), ['upgrade-ad'], 'no request may expose the old stemming');
				ready = true;
			} else assert.ok(body.length > 0);
			if (!ready) await delay(25);
		} while (!ready && Date.now() < deadline);
		assert.ok(ready, 'upgraded public search did not become ready before the deadline');
		await waitForReady('LifecycleProduct');
		const mismatch = /fulltext:LifecycleProduct\/catalogSearch.*is incompatible \(E_IDENTITY_MISMATCH\); rebuilding/;
		const logPath = join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
		const logDeadline = Date.now() + 10_000;
		let upgradeLog: string;
		do {
			upgradeLog = (await readFile(previousLogPath, 'utf8')).slice(previousLogLength);
			if (logPath !== previousLogPath) upgradeLog += await readFile(logPath, 'utf8');
			if (mismatch.test(upgradeLog)) break;
			await delay(25);
		} while (Date.now() < logDeadline);
		assert.match(upgradeLog, mismatch);
		assert.deepStrictEqual(ids(await searchLifecycle('added')), ['upgrade-added']);
		assert.deepStrictEqual(await searchLifecycle('migrationghost'), []);
		await request('/LifecycleProduct/upgrade-deleted', { method: 'DELETE' });
		assert.deepStrictEqual(await searchLifecycle('migrationwitness'), []);
		await request(
			'/LifecycleProduct/upgrade-added',
			{
				method: 'PATCH',
				body: JSON.stringify({ title: 'added waterproof recovered' }),
			},
			204
		);
		assert.deepStrictEqual(ids(await searchLifecycle('recovered')), ['upgrade-added']);
		const after = (await request('/FullTextState/')).LifecycleProduct;
		assert.strictEqual(after.tableId, before.tableId);
		assert.deepStrictEqual(after.generations, before.generations);
		await killHarper(ctx);
		const refused = previousFullTextProcess('inspect', configuration);
		assert.deepStrictEqual(refused.inspection, { state: 'incompatible', code: 'E_IDENTITY_MISMATCH' });
		assert.strictEqual(refused.openError, 'E_IDENTITY_MISMATCH');
		assert.strictEqual(previousFullTextProcess('reset', configuration).resetError, 'E_INDEX_CORRUPT');
		assert.strictEqual(native.inspectNativeFullTextIndex(configuration).state, 'checkpointed');
		await startHarper(ctx, OPTIONS);
		await waitForReady('LifecycleProduct');
		assert.deepStrictEqual(ids(await searchLifecycle('recovered')), ['upgrade-added']);
		assert.deepStrictEqual(ids(await searchLifecycle('ad')), ['upgrade-ad']);
		assert.deepStrictEqual(await searchLifecycle('migrationwitness'), []);
		assert.deepStrictEqual(await searchLifecycle('migrationghost'), []);
		await waitForReady('Product');
		await waitForIds(query('waterproof'), ['one', 'two']);
	});

	test('preserves index generation and physical paths and protects declarations after restart', async () => {
		await request(
			'/LifecycleProduct/lifecycle',
			{ method: 'PUT', body: JSON.stringify({ title: 'Original constellation' }) },
			204
		);
		await waitForReady('LifecycleProduct');
		const lifecycleQuery = query('constellation');
		await request('/LifecycleProduct/', { method: 'QUERY', body: JSON.stringify(lifecycleQuery) });
		const beforeRestart = await request('/FullTextState/');
		assert.strictEqual(typeof beforeRestart.LifecycleProduct.generations.catalogSearch, 'string');
		await killHarper(ctx);
		const beforePaths = (await readdir(beforeRestart.LifecycleProduct.storePath))
			.filter((name) => name.endsWith('.fulltext'))
			.sort();
		assert.strictEqual(beforePaths.length, 2);
		await startHarper(ctx, OPTIONS);
		await waitForReady('LifecycleProduct');
		const lifecycle = await request('/LifecycleProduct/', { method: 'QUERY', body: JSON.stringify(lifecycleQuery) });
		assert.deepStrictEqual(ids(lifecycle), ['lifecycle']);
		const afterRestart = await request('/FullTextState/');
		assert.strictEqual(afterRestart.LifecycleProduct.tableId, beforeRestart.LifecycleProduct.tableId);
		assert.deepStrictEqual(afterRestart.LifecycleProduct.generations, beforeRestart.LifecycleProduct.generations);
		assert.strictEqual(afterRestart.LifecycleProduct.storePath, beforeRestart.LifecycleProduct.storePath);
		assert.deepStrictEqual(
			(await readdir(afterRestart.LifecycleProduct.storePath)).filter((name) => name.endsWith('.fulltext')).sort(),
			beforePaths
		);
		assert.deepStrictEqual(afterRestart.Product.generations, beforeRestart.Product.generations);
		assert.deepStrictEqual(afterRestart.LifecycleProduct.fields, ['catalogSearch']);
		await waitForReady('Product');
		await waitForIds(query('waterproof'), ['one', 'two']);
		for (const table of ['Product', 'LifecycleProduct']) {
			await request(
				`/${table}/shadow`,
				{ method: 'PUT', body: JSON.stringify({ title: 'Shadow', catalogSearch: 'shadow' }) },
				400
			);
		}
	});

	test('rebuilds changed sources under a renamed field and retires removed index storage', async () => {
		await request(
			'/LifecycleProduct/lifecycle',
			{ method: 'PATCH', body: JSON.stringify({ description: 'Replacement galaxy' }) },
			204
		);
		const previous = (await request('/FullTextState/')).LifecycleProduct;
		const nativePaths = async () =>
			(await readdir(previous.storePath)).filter((name) => name.endsWith('.fulltext')).sort();
		const previousPaths = await nativePaths();
		assert.strictEqual(previousPaths.length, 2);
		const schemaPath = join(ctx.harper.dataRootDir, 'components', 'full-text-search', 'schema.graphql');
		const fieldDeclaration = 'catalogSearch: FullText @fullText(fields: [{ name: "title", weight: 3 }])';
		const replacementDeclaration =
			'replacementSearch: FullText @fullText(fields: [{ name: "description", weight: 3 }])';
		await killHarper(ctx);
		const schema = await readFile(schemaPath, 'utf8');
		assert.ok(schema.includes(fieldDeclaration));
		const sourceDeclaration = replacementDeclaration.replace('replacementSearch:', 'catalogSearch:');
		await writeFile(schemaPath, schema.replace(fieldDeclaration, sourceDeclaration));
		await startHarper(ctx, OPTIONS);
		await waitForReady('LifecycleProduct');
		const changedSource = (await request('/FullTextState/')).LifecycleProduct;
		assert.deepStrictEqual(changedSource.fields, ['catalogSearch']);
		assert.notStrictEqual(changedSource.generations.catalogSearch, previous.generations.catalogSearch);
		assert.deepStrictEqual(await nativePaths(), previousPaths, 'source rebuild keeps its index-name-derived path');
		const sourceRecords = await request('/LifecycleProduct/', {
			method: 'QUERY',
			body: JSON.stringify(query('galaxy')),
		});
		assert.deepStrictEqual(ids(sourceRecords), ['lifecycle']);
		const formerSourceRecords = await request('/LifecycleProduct/', {
			method: 'QUERY',
			body: JSON.stringify(query('constellation')),
		});
		assert.deepStrictEqual(formerSourceRecords, []);
		await killHarper(ctx);
		await writeFile(schemaPath, schema.replace(fieldDeclaration, replacementDeclaration));
		await startHarper(ctx, OPTIONS);
		await waitForReady('LifecycleProduct');
		const replacementQuery = query('galaxy', { attribute: 'replacementSearch' });
		const records = await request('/LifecycleProduct/', { method: 'QUERY', body: JSON.stringify(replacementQuery) });
		assert.deepStrictEqual(ids(records), ['lifecycle']);
		const oldSource = await request('/LifecycleProduct/', {
			method: 'QUERY',
			body: JSON.stringify(query('constellation', { attribute: 'replacementSearch' })),
		});
		assert.deepStrictEqual(oldSource, []);
		const renamed = (await request('/FullTextState/')).LifecycleProduct;
		assert.strictEqual(renamed.tableId, previous.tableId);
		assert.deepStrictEqual(renamed.fields, ['replacementSearch']);
		assert.strictEqual(renamed.generations.catalogSearch, undefined);
		assert.strictEqual(typeof renamed.generations.replacementSearch, 'string');
		assert.notStrictEqual(renamed.generations.replacementSearch, changedSource.generations.catalogSearch);
		let renamedPaths: string[] = [];
		const renameDeadline = Date.now() + 30_000;
		do {
			renamedPaths = await nativePaths();
			if (renamedPaths.length === 2 && renamedPaths.filter((path) => previousPaths.includes(path)).length === 1) break;
			await delay(50);
		} while (Date.now() < renameDeadline);
		assert.strictEqual(renamedPaths.length, 2);
		const unaffectedPaths = renamedPaths.filter((path) => previousPaths.includes(path));
		assert.strictEqual(unaffectedPaths.length, 1, 'rename must retire the previous active directory');

		await killHarper(ctx);
		await writeFile(schemaPath, schema.replace(fieldDeclaration, ''));
		await startHarper(ctx, OPTIONS);
		const description = await operation({ operation: 'describe_table', schema: 'data', table: 'LifecycleProduct' });
		assert.strictEqual(description.full_text_indexes, undefined);
		const removed = (await request('/FullTextState/')).LifecycleProduct;
		assert.deepStrictEqual(removed.fields, []);
		assert.deepStrictEqual(removed.generations, {});
		let remainingPaths: string[] = [];
		const removalDeadline = Date.now() + 30_000;
		do {
			remainingPaths = await nativePaths();
			if (JSON.stringify(remainingPaths) === JSON.stringify(unaffectedPaths)) break;
			await delay(50);
		} while (Date.now() < removalDeadline);
		assert.deepStrictEqual(remainingPaths, unaffectedPaths, 'removed declaration must retire its active directory');
		await waitForReady('Product');
		await waitForIds(query('waterproof'), ['one', 'two']);
	});
	test(
		'applies full-text request limits through set_configuration and worker restart',
		{ skip: process.platform === 'win32' ? 'HTTP worker restart on Windows: HarperFast/harper#549' : false },
		async () => {
			async function restartWorkers() {
				const { job_id } = await operation({ operation: 'restart_service', service: 'http_workers' });
				assert(job_id);
				const deadline = Date.now() + 60000;
				let status;
				do {
					let job;
					try {
						[job] = await operation({ operation: 'get_job', id: job_id });
					} catch (error) {
						const code = (error as any)?.cause?.code ?? (error as any)?.code;
						if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(code)) throw error;
						assert.strictEqual(
							ctx.harper.process.exitCode,
							null,
							`Harper exited during worker restart: ${ctx.harper.process.exitCode}`
						);
						assert.strictEqual(
							ctx.harper.process.signalCode,
							null,
							`Harper stopped during worker restart: ${ctx.harper.process.signalCode}`
						);
					}
					status = job?.status;
					if (status === 'COMPLETE' || status === 'ERROR') break;
					await delay(25);
				} while (Date.now() < deadline);
				assert.strictEqual(status, 'COMPLETE');
				await waitForReady('Product');
			}
			async function assertBudget(name: string) {
				let status: number;
				let body: string;
				const deadline = Date.now() + 10000;
				do {
					const response = await fetch(`${ctx.harper.httpURL}/SearchProduct/`, {
						method: 'POST',
						headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
						body: JSON.stringify(query('shoe', {}, { limit: 2 })),
						signal: AbortSignal.timeout(5000),
					});
					status = response.status;
					body = await response.text();
					if (status === 400 && body.includes(name)) break;
					await delay(25);
				} while (Date.now() < deadline);
				assert.strictEqual(status, 400, body);
				assert.ok(body.includes(name), body);
			}
			const original = (await operation({ operation: 'get_configuration' })).storage.fullText;
			assert.ok(original, 'Installed configuration must include full-text defaults');
			try {
				await operation({
					operation: 'set_configuration',
					storage_fullText_maxRawHitsPerRequest: 500,
					storage_fullText_maxResultsPerRequest: 1,
					storage_fullText_requestBudgetMilliseconds: 1000,
				});
				const updated = (await operation({ operation: 'get_configuration' })).storage.fullText;
				assert.strictEqual(updated.maxRawHitsPerRequest, 500);
				assert.strictEqual(updated.maxResultsPerRequest, 1);
				assert.strictEqual(updated.requestBudgetMilliseconds, 1000);
				await restartWorkers();
				await assertBudget('maxResultsPerRequest');
				await operation({
					operation: 'set_configuration',
					storage_fullText_maxRawHitsPerRequest: 1,
					storage_fullText_maxResultsPerRequest: 500,
				});
				await restartWorkers();
				await assertBudget('maxRawHitsPerRequest');
			} finally {
				if (ctx.harper.process.exitCode === null && ctx.harper.process.signalCode === null) {
					await operation({
						operation: 'set_configuration',
						storage_fullText_maxRawHitsPerRequest: original.maxRawHitsPerRequest,
						storage_fullText_maxResultsPerRequest: original.maxResultsPerRequest,
						storage_fullText_requestBudgetMilliseconds: original.requestBudgetMilliseconds,
					});
					await restartWorkers();
				}
			}
		}
	);
});

suite('deployed full-text default query policy', (ctx: ContextWithHarper) => {
	let authorization: string;

	async function search(target: ReturnType<typeof query>, operations: boolean, expectedStatus = 200) {
		const response = await fetch(operations ? ctx.harper.operationsAPIURL : `${ctx.harper.httpURL}/SearchProduct/`, {
			method: 'POST',
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
			body: JSON.stringify(
				operations ? { operation: 'search_by_conditions', schema: 'data', table: 'Product', ...target } : target
			),
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		assert.strictEqual(response.status, expectedStatus, text);
		return JSON.parse(text);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: 2 } }, env: OPTIONS.env });
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		const response = await fetch(`${ctx.harper.httpURL}/Product/default-policy`, {
			method: 'PUT',
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Waterproof shoes' }),
			signal: AbortSignal.timeout(45_000),
		});
		assert.strictEqual(response.status, 204, await response.text());
		const deadline = Date.now() + 30_000;
		let state: string;
		do {
			const description = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'describe_table', schema: 'data', table: 'Product' }),
				signal: AbortSignal.timeout(45_000),
			});
			const body = await description.text();
			assert.strictEqual(description.status, 200, body);
			state = JSON.parse(body).full_text_indexes[0].readiness.state;
			if (state === 'ready') return;
			assert.notStrictEqual(state, 'unavailable', 'Product full-text index is unavailable');
			await delay(50);
		} while (Date.now() < deadline);
		assert.strictEqual(state, 'ready', 'Product full-text index did not become ready');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('rejects distance two by default and recovers with valid fuzzy and ordinary searches', async () => {
		for (const operations of [false, true]) {
			const rejected = query('waterprof', { comparator: 'matches_fuzzy', fuzzyDistance: 2, fields: ['title'] });
			if (operations)
				await assertOperationsQueryRejection(
					ctx.harper.operationsAPIURL,
					authorization,
					rejected,
					'Full-text fuzzy distance exceeds storage.fullText.query.maxFuzzyDistance'
				);
			else await search(rejected, false, 400);
			assert.deepStrictEqual(
				ids(
					await search(
						query('waterprof', { comparator: 'matches_fuzzy', fuzzyDistance: 1, fields: ['title'] }),
						operations
					)
				),
				['default-policy']
			);
			assert.deepStrictEqual(ids(await search(query('waterproof'), operations)), ['default-policy']);
		}
	});
});
