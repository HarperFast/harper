/**
 * HTTP preconditions (HarperFast/harper#900): stale mutations must be rejected without writes,
 * and simultaneous conditional requests must produce one winner across four HTTP workers.
 * Real requests cover body deserialization, validators, HEAD, transaction commit and lock release.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

suite('HTTP conditional requests', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let base: string;
	let auth: string;
	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'record-lock-concurrency'), {
			config: { threads: { count: 4 } },
			env: {},
		});
		base = ctx.harper.httpURL;
		auth = createApiClient(ctx.harper).headers.Authorization;
	});
	after(async () => teardownHarper(ctx));

	const request = (method: string, id: string, body?: object, headers: Record<string, string> = {}) =>
		fetch(`${base}/ConditionalCounter/${id}`, {
			method,
			headers: { 'Authorization': auth, 'Content-Type': 'application/json', ...headers },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(15_000),
		});

	async function parallel(method: string, id: string, headers: Record<string, string>) {
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => (release = resolve));
		const attempts = Array.from({ length: 16 }, async (_, n) => {
			await barrier;
			const response = await request(method, id, { n }, headers);
			const text = await response.text();
			return { n, status: response.status, worker: response.headers.get('X-Test-Worker'), text };
		});
		release();
		const results = await Promise.all(attempts);
		ok(
			new Set(results.map(({ worker }) => worker).filter(Boolean)).size > 1,
			`expected multiple workers: ${JSON.stringify(results)}`
		);
		const winners = results.filter(({ status }) => status >= 200 && status < 300);
		strictEqual(winners.length, 1, JSON.stringify(results));
		strictEqual(results.filter(({ status }) => status === 412).length, 15, JSON.stringify(results));
		const stored = await request('GET', id);
		strictEqual(((await stored.json()) as { n: number }).n, winners[0].n);
	}

	test('one update wins when all workers receive the same If-Match', async () => {
		ok((await request('PUT', 'race', { n: -1 })).ok);
		const read = await request('GET', 'race');
		const etag = read.headers.get('etag');
		ok(etag);
		await read.text();
		await parallel('PATCH', 'race', { 'If-Match': etag });
	});

	test('one create wins with If-None-Match wildcard', async () => {
		await parallel('PUT', 'create-once', { 'If-None-Match': '*' });
	});

	test('GET and HEAD return an empty 304 carrying ETag, including a weak list', async () => {
		const read = await request('GET', 'race');
		const etag = read.headers.get('etag');
		ok(etag);
		await read.text();
		for (const method of ['GET', 'HEAD']) {
			const cached = await request(method, 'race', undefined, { 'If-None-Match': `"other", W/${etag}` });
			strictEqual(cached.status, 304);
			strictEqual(cached.headers.get('etag'), etag);
			strictEqual(await cached.text(), '');
		}
	});

	test('matching If-None-Match rejects each mutation with 412 and preserves ETag', async () => {
		for (const method of ['PUT', 'PATCH', 'DELETE']) {
			const id = `reject-${method}`;
			ok((await request('PUT', id, { n: 1 })).ok);
			const before = await request('GET', id);
			const etag = before.headers.get('etag');
			ok(etag);
			await before.text();
			const rejected = await request(method, id, method === 'DELETE' ? undefined : { n: 2 }, { 'If-None-Match': etag });
			strictEqual(rejected.status, 412, await rejected.text());
			const after = await request('GET', id);
			strictEqual(after.headers.get('etag'), etag);
			strictEqual(((await after.json()) as { n: number }).n, 1);
			const accepted = await request(method, id, method === 'DELETE' ? undefined : { n: 3 }, { 'If-Match': etag });
			ok(accepted.ok, `${accepted.status}: ${await accepted.text()}`);
		}
	});
});
