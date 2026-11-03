import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'pk-filter-invalidated-reads');

suite('primary-key filtered reads over invalidated cache rows', (ctx: ContextWithHarper) => {
	let request: (path: string, init?: RequestInit) => Promise<Response>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: 1 } } });
		const { admin, httpURL } = ctx.harper;
		const authorization = 'Basic ' + Buffer.from(`${admin.username}:${admin.password}`).toString('base64');
		request = (path, init = {}) => fetch(`${httpURL}${path}`, { ...init, headers: { authorization, ...init.headers } });
		for (const [id, body, rank] of [
			['a', 'zzz', 30],
			['b', 'aaa', 10],
			['c', 'mmm', 20],
		] as const) {
			const response = await request(`/CachedRow/${id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id, body, rank }),
			});
			ok(response.status < 300, `seeding ${id} failed: ${response.status} ${await response.text()}`);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function query(path: string) {
		const response = await request(path);
		const body = await response.text();
		strictEqual(response.status, 200, `${path}: ${body}`);
		return JSON.parse(body) as any[];
	}

	async function rowState(id: string) {
		return (await (await request(`/RowState/${id}`)).json()) as { loads: number; exists: boolean; hasRecord: boolean };
	}

	async function waitForState(id: string, matches: (state: Awaited<ReturnType<typeof rowState>>) => boolean) {
		for (let attempt = 0; attempt < 250; attempt++) {
			const state = await rowState(id);
			if (matches(state)) return state;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`${id} never reached the expected stored state`);
	}

	async function invalidate(id: string) {
		const response = await request('/InvalidateRow/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id }),
		});
		strictEqual(response.status, 200, await response.text());
		return (await waitForState(id, (state) => state.exists && !state.hasRecord)).loads;
	}

	test('sorts primary-key in and ne results', async () => {
		deepStrictEqual(
			(await query('/CachedRow/?id=in=(a,b,c)&sort(+body)')).map((row) => row.id),
			['b', 'c', 'a']
		);
		deepStrictEqual(
			(await query('/CachedRow/?id=ne=none&sort(+rank)')).map((row) => row.id),
			['b', 'c', 'a']
		);
	});

	for (const path of [
		'/CachedRow/?id=in=(a,c)',
		'/CachedRow/?id=in=(a,c)&sort(-id)',
		'/CachedRow/?id=ne=b',
		'/CachedRow/?id=in=(a,c)&id=ne=b',
	]) {
		test(`revalidates an invalidated row for ${path}`, async () => {
			const loadsBefore = await invalidate('c');
			const rows = await query(path);
			deepStrictEqual(rows.map((row) => [row.id, row.body]).sort(), [
				['a', 'zzz'],
				['c', 'fresh c'],
			]);
			strictEqual((await rowState('c')).loads, loadsBefore + 1);
			// the cache fill commits behind the response; the next case starts from a complete record
			await waitForState('c', (state) => state.hasRecord);
		});
	}
});
