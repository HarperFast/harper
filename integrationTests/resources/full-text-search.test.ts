/**
 * Published fulltext 0.3.0 through deployed field declarations, Table.search and REST:
 * query modes, authorization, pagination, mutations, and durable syntax migration.
 * https://github.com/HarperFast/harper/pull/2855
 */
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
import { runtimeInfo } from '@harperfast/fulltext/native';

const FIXTURE_PATH = resolve(import.meta.dirname, 'full-text-search');
const OPTIONS = { config: { threads: { count: 2 } }, env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' } };
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
		await waitForReady('Product');
		await waitForIds(query('waterproof'), ['one', 'two']);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('loads published 0.3.0 and exposes a ready index without a stored virtual attribute', async () => {
		const info = await runtimeInfo();
		assert.strictEqual(info.packageVersion, '0.3.0');
		assert.strictEqual(info.queryApiVersion, 2);
		assert.ok(info.queryClassIsolationMinimumSearchThreads > 0);
		const description = await operation({ operation: 'describe_table', schema: 'data', table: 'Product' });
		const index = description.full_text_indexes.find(({ name }) => name === 'catalogSearch');
		assert.strictEqual(index.readiness.state, 'ready');
		assert.strictEqual(index.field, true);
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

	test('preserves generation across legacy-to-field migration and protects declarations after restart', async () => {
		await request('/LegacyProduct/legacy', { method: 'PUT', body: JSON.stringify({ title: 'Legacy migration' }) }, 204);
		await waitForReady('LegacyProduct');
		const legacyQuery = query('migration');
		await request('/LegacyProduct/', { method: 'QUERY', body: JSON.stringify(legacyQuery) });
		const beforeRestart = await request('/FullTextState/');
		assert.strictEqual(typeof beforeRestart.LegacyProduct.generations.catalogSearch, 'string');
		await killHarper(ctx);
		const beforePaths = (await readdir(beforeRestart.LegacyProduct.storePath))
			.filter((name) => name.endsWith('.fulltext'))
			.sort();
		assert.strictEqual(beforePaths.length, 2);
		const deployedSchemaPath = join(ctx.harper.dataRootDir, 'components', 'full-text-search', 'schema.graphql');
		const schema = await readFile(deployedSchemaPath, 'utf8');
		const legacyDeclaration = '@fullText(name: "catalogSearch", fields: [{ name: "title", weight: 3 }])';
		assert.ok(schema.includes(legacyDeclaration));
		await writeFile(
			deployedSchemaPath,
			schema
				.replace(legacyDeclaration, '')
				.replace(
					/(type LegacyProduct[\s\S]*title: String)/,
					'$1\n\tcatalogSearch: FullText @fullText(fields: [{ name: "title", weight: 3 }])'
				)
		);
		await startHarper(ctx, OPTIONS);
		await waitForReady('LegacyProduct');
		const legacy = await request('/LegacyProduct/', { method: 'QUERY', body: JSON.stringify(legacyQuery) });
		assert.deepStrictEqual(ids(legacy), ['legacy']);
		const afterRestart = await request('/FullTextState/');
		assert.strictEqual(afterRestart.LegacyProduct.tableId, beforeRestart.LegacyProduct.tableId);
		assert.deepStrictEqual(afterRestart.LegacyProduct.generations, beforeRestart.LegacyProduct.generations);
		assert.strictEqual(afterRestart.LegacyProduct.storePath, beforeRestart.LegacyProduct.storePath);
		assert.deepStrictEqual(
			(await readdir(afterRestart.LegacyProduct.storePath)).filter((name) => name.endsWith('.fulltext')).sort(),
			beforePaths
		);
		assert.deepStrictEqual(afterRestart.Product.generations, beforeRestart.Product.generations);
		assert.deepStrictEqual(afterRestart.LegacyProduct.fields, ['catalogSearch']);
		await waitForReady('Product');
		await waitForIds(query('waterproof'), ['one', 'two']);
		for (const table of ['Product', 'LegacyProduct']) {
			await request(
				`/${table}/shadow`,
				{ method: 'PUT', body: JSON.stringify({ title: 'Shadow', catalogSearch: 'shadow' }) },
				400
			);
		}
	});
});
