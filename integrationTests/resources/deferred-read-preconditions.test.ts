import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const STARTUP_LAST_MODIFIED = new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toUTCString();

suite('Deferred collection read preconditions', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let base: string;
	let auth: string;
	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'deferred-read-preconditions'), { env: {} });
		base = ctx.harper.httpURL;
		auth = createApiClient(ctx.harper).headers.Authorization;
	});
	after(async () => {
		await teardownHarper(ctx);
	});

	const request = (method: string, path: string, headers: Record<string, string> = {}) =>
		fetch(`${base}/${path}`, {
			method,
			headers: { Authorization: auth, Accept: 'application/x-ndjson', ...headers },
			signal: AbortSignal.timeout(15_000),
		});

	for (const path of ['DeferredStream/', 'DeferredEnvelope/']) {
		test(`${path} GET and HEAD carry the validators its stream startup set`, async () => {
			const read = await request('GET', path);
			strictEqual(read.status, 200);
			const etag = read.headers.get('etag');
			ok(etag, 'GET carries an ETag');
			strictEqual(read.headers.get('last-modified'), STARTUP_LAST_MODIFIED);
			strictEqual((await read.text()).trim().split('\n').length, 2);
			const head = await request('HEAD', path);
			strictEqual(head.status, 200);
			strictEqual(head.headers.get('etag'), etag);
			strictEqual(head.headers.get('last-modified'), STARTUP_LAST_MODIFIED);
			strictEqual(await head.text(), '');
			for (const method of ['GET', 'HEAD']) {
				const cached = await request(method, path, { 'If-None-Match': etag });
				strictEqual(cached.status, 304, `${method} If-None-Match`);
				strictEqual(cached.headers.get('etag'), etag);
				strictEqual(await cached.text(), '');
				const notModified = await request(method, path, { 'If-Modified-Since': STARTUP_LAST_MODIFIED });
				strictEqual(notModified.status, 304, `${method} If-Modified-Since`);
				await notModified.text();
				const matched = await request(method, path, { 'If-Match': etag });
				strictEqual(matched.status, 200, `${method} If-Match`);
				await matched.text();
				const stale = await request(method, path, { 'If-Match': '"stale"' });
				strictEqual(stale.status, 412, `${method} If-Match mismatch`);
				await stale.text();
			}
		});
	}

	test('HEAD answers 403 like GET when an async allowRead denies a collection read', async () => {
		for (const accept of ['application/json', 'application/x-ndjson']) {
			for (const method of ['GET', 'HEAD']) {
				for (const headers of [{}, { 'If-None-Match': '*' }, { 'If-Match': '"probe"' }]) {
					const response = await request(method, 'RestrictedItem/', { Accept: accept, ...headers });
					strictEqual(response.status, 403, `${method} ${accept} ${JSON.stringify(headers)}`);
					await response.text();
				}
			}
		}
	});
});
