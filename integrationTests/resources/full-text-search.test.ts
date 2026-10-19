import { NO_FULL_WORKER_COVERAGE } from '../database/recordCachingWorkers.ts';
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

	test('loads the pinned native package and exposes a ready index without a stored virtual attribute', async () => {
		const info = await runtimeInfo();
		const packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, '../..', 'package.json'), 'utf8'));
		assert.strictEqual(info.packageVersion, packageJson.optionalDependencies['@harperfast/fulltext']);
		assert.strictEqual(info.mutationBatchApiVersion, 5);
		assert.strictEqual(info.queryApiVersion, 4);
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

	test('rejects continuation on mutating REST methods without changing records or consuming the token', async () => {
		const base = '/Product/?catalogSearch=matches=pagination&limit(75)&select(id,title)';
		const firstResponse = await fetch(`${ctx.harper.httpURL}${base}&continuation()`, {
			headers: { Authorization: authorization },
			signal: AbortSignal.timeout(15000),
		});
		assert.strictEqual(firstResponse.status, 200);
		const first: { id: string }[] = await firstResponse.json();
		const token = firstResponse.headers.get('harper-continuation');
		assert(token);
		await request(`${base}&continuation()`, { method: 'OPTIONS' }, 204);
		await request(
			`${base}&continuation()`,
			{
				method: 'DELETE',
				headers: { Authorization: `Basic ${Buffer.from('fulltext-missing-user:wrong').toString('base64')}` },
			},
			401
		);
		try {
			for (const method of ['DELETE', 'PUT', 'PATCH', 'POST']) {
				for (const continuation of [`continuation(${encodeURIComponent(token)})`, 'continuation()']) {
					await request(`${base}&${continuation}`, { method }, 400);
				}
			}
			assert.deepStrictEqual(
				ids(await request('/Product/?catalogSearch=matches=pagination&select(id,title)')),
				PAGE_IDS
			);
			const resumed = await request(`${base}&continuation(${encodeURIComponent(token)})`);
			assert.strictEqual(resumed.length, 75);
			assert(!resumed.some(({ id }) => first.some((record) => record.id === id)));
		} finally {
			await request(`${base}&continuation(${encodeURIComponent(token)})&closeContinuation()`);
		}
	});

	test('continues REST snapshot pages across HTTP workers and exposes opaque page headers', async () => {
		const headPage = async (continuation: string, credential = authorization, status = 400) => {
			const response = await fetch(
				`${ctx.harper.httpURL}/Product/?catalogSearch=matches=pagination&limit(75)&select(id,title)&${continuation}`,
				{ method: 'HEAD', headers: { Authorization: credential }, signal: AbortSignal.timeout(15000) }
			);
			assert.strictEqual(response.status, status);
			assert.strictEqual(response.headers.get('harper-continuation'), null);
		};
		await headPage('continuation()', `Basic ${Buffer.from('fulltext-missing-user:wrong').toString('base64')}`, 401);
		await headPage('continuation()');
		const getPage = async (token?: string) => {
			const continuation = token ? `continuation(${encodeURIComponent(token)})` : 'continuation()';
			const response = await fetch(
				`${ctx.harper.httpURL}/Product/?catalogSearch=matches=pagination&limit(75)&select(id,title)&${continuation}`,
				{
					headers: { Authorization: authorization, Connection: 'close' },
					signal: AbortSignal.timeout(15000),
				}
			);
			const text = await response.text();
			assert.strictEqual(response.status, 200, text);
			assert.strictEqual(response.headers.get('cache-control'), 'no-store');
			assert(response.headers.get('access-control-expose-headers')?.includes('Harper-Continuation'));
			return {
				records: JSON.parse(text),
				token: response.headers.get('harper-continuation'),
				complete: response.headers.get('harper-continuation-complete'),
				expires: response.headers.get('harper-continuation-expires'),
				worker: response.headers.get('fulltext-test-worker'),
			};
		};
		const first = await getPage();
		assert.strictEqual(first.records.length, 75);
		assert.strictEqual(first.complete, 'false');
		assert(first.token);
		assert(Number(first.expires) > Date.now());
		assert(first.worker);
		await headPage(`continuation(${encodeURIComponent(first.token)})`);
		let second = await getPage(first.token);
		for (let attempt = 0; !NO_FULL_WORKER_COVERAGE && second.worker === first.worker && attempt < 30; attempt++)
			second = await getPage(first.token);
		if (!NO_FULL_WORKER_COVERAGE)
			assert.notStrictEqual(second.worker, first.worker, 'must exercise a resume on a different HTTP worker');
		const seen = [...first.records, ...second.records];
		let token = second.token;
		while (token) {
			const page = await getPage(token);
			seen.push(...page.records);
			token = page.token;
			if (!token) {
				assert.strictEqual(page.complete, 'true');
				assert.strictEqual(page.expires, null);
			}
		}
		assert.deepStrictEqual(ids(seen), PAGE_IDS);
		assert.strictEqual(new Set(ids(seen)).size, PAGE_IDS.length);
	});

	test('bounds concurrent retained searches and recovers capacity after close', async () => {
		const base = `${ctx.harper.httpURL}/Product/?catalogSearch=matches=pagination&limit(1)&select(id)`;
		const headers = { Authorization: authorization, Connection: 'close' };
		const open = async () => {
			const response = await fetch(`${base}&continuation()`, { headers, signal: AbortSignal.timeout(15000) });
			return {
				status: response.status,
				text: await response.text(),
				token: response.headers.get('harper-continuation'),
			};
		};
		const close = async (token: string) => {
			const response = await fetch(`${base}&continuation(${encodeURIComponent(token)})&closeContinuation()`, {
				headers,
				signal: AbortSignal.timeout(15000),
			});
			assert.strictEqual(response.status, 200, await response.text());
		};
		const held: string[] = [];
		try {
			const results = await Promise.all(Array.from({ length: 16 }, open));
			for (const result of results) if (result.status === 200 && result.token) held.push(result.token);
			assert.strictEqual(held.length, 4);
			const denied = results.filter(({ status }) => status !== 200);
			assert.strictEqual(denied.length, 12);
			for (const result of denied) {
				assert.strictEqual(result.status, 503, result.text);
				assert.match(result.text, /storage.fullText.maxCursors/);
			}
			assert.strictEqual((await request('/Product/?catalogSearch=matches=pagination&limit(1)')).length, 1);
			const released = held.pop()!;
			await close(released);
			const replacement = await open();
			assert.strictEqual(replacement.status, 200, replacement.text);
			assert(replacement.token);
			held.push(replacement.token);
		} finally {
			await Promise.all(held.map(close));
		}
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
		const continuationQuery = query(
			'pagination',
			{ fields: ['title'], includeHighlights: true },
			{
				select: ['id', 'title', '$score', '$highlights'],
				limit: 25,
			}
		);
		const startResponse = await fetch(`${ctx.harper.httpURL}/Product/`, {
			method: 'QUERY',
			headers: { 'Authorization': READER_AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...continuationQuery, continuation: true }),
			signal: AbortSignal.timeout(15000),
		});
		assert.strictEqual(startResponse.status, 200, await startResponse.clone().text());
		const started = await startResponse.json();
		assert.strictEqual(started.length, 25);
		assert(started.every((record) => record.$highlights.title));
		const continuationToken = startResponse.headers.get('harper-continuation');
		assert(continuationToken);
		await request(
			'/Product/',
			{
				method: 'QUERY',
				headers: { Authorization: authorization },
				body: JSON.stringify({ ...continuationQuery, continuation: continuationToken }),
			},
			410
		);
		await operation({ operation: 'alter_user', username: READER.username, role: 'fulltext_denied' });
		await request(
			'/Product/',
			{
				method: 'QUERY',
				headers: { Authorization: READER_AUTH },
				body: JSON.stringify({ ...continuationQuery, continuation: continuationToken }),
			},
			403
		);
		await operation({ operation: 'alter_user', username: READER.username, role: 'fulltext_reader' });
		const afterRestore = await request('/Product/', {
			method: 'QUERY',
			headers: { Authorization: READER_AUTH },
			body: JSON.stringify({ ...continuationQuery, continuation: continuationToken, closeContinuation: true }),
		});
		assert.deepStrictEqual(afterRestore, []);

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
});
