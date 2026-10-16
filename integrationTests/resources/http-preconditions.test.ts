// https://github.com/HarperFast/harper/issues/900
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

// Bun accepts reusePort on Linux but does not reliably distribute loopback test traffic across the
// listeners, so Node/Linux supplies the multi-worker proof while Bun validates the concurrent
// precondition contract through whichever listener wins.
const MIN_OBSERVABLE_WORKERS = process.env.HARPER_RUNTIME === 'bun' ? 1 : 2;

for (const preconditionLocks of [true, false]) {
	suite(
		`HTTP conditional requests (locks ${preconditionLocks ? 'on by default' : 'off'})`,
		{ skip: process.platform === 'win32' },
		(ctx: ContextWithHarper) => {
			let base: string;
			let auth: string;
			let fixture: string;
			before(async () => {
				const source = resolve(import.meta.dirname, 'record-lock-concurrency');
				fixture = await mkdtemp(join(tmpdir(), 'http-preconditions-'));
				for (const file of ['resources.js', 'schema.graphql']) await copyFile(join(source, file), join(fixture, file));
				const config = await readFile(join(source, 'config.yaml'), 'utf8');
				ok(config.includes('rest: true'));
				const restConfig = preconditionLocks
					? 'rest:\n  lastModified: true'
					: 'rest:\n  preconditionLocks: false\n  lastModified: true';
				await writeFile(join(fixture, 'config.yaml'), config.replace('rest: true', restConfig));
				await setupHarperWithFixture(ctx, fixture, {
					config: { threads: { count: 4 } },
					env: {},
				});
				base = ctx.harper.httpURL;
				auth = createApiClient(ctx.harper).headers.Authorization;
			});
			after(async () => {
				try {
					await teardownHarper(ctx);
				} finally {
					if (fixture) await rm(fixture, { recursive: true, force: true });
				}
			});

			const request = (method: string, id: string, body?: object, headers: Record<string, string> = {}) =>
				fetch(`${base}/ConditionalCounter/${id}`, {
					method,
					headers: { 'Authorization': auth, 'Content-Type': 'application/json', ...headers },
					body: body ? JSON.stringify(body) : undefined,
					signal: AbortSignal.timeout(15_000),
				});

			async function parallel(method: string, id: string, headers: Record<string, string>) {
				const barrierDir = preconditionLocks ? undefined : await mkdtemp(join(fixture, 'barrier-'));
				const requestHeaders = barrierDir ? { ...headers, 'X-Test-Barrier': barrierDir } : headers;
				let release!: () => void;
				const barrier = new Promise<void>((resolve) => (release = resolve));
				const attempts = Array.from({ length: 16 }, async (_, n) => {
					await barrier;
					const response = await request(method, id, { n }, requestHeaders);
					const text = await response.text();
					return { n, status: response.status, worker: response.headers.get('X-Test-Worker'), text };
				});
				release();
				const results = await Promise.all(attempts);
				ok(
					new Set(results.map(({ worker }) => worker).filter(Boolean)).size >= MIN_OBSERVABLE_WORKERS,
					`expected at least ${MIN_OBSERVABLE_WORKERS} worker(s): ${JSON.stringify(results)}`
				);
				const winners = results.filter(({ status }) => status >= 200 && status < 300);
				const stored = await request('GET', id);
				const storedValue = (await stored.json()) as { n: number };
				if (preconditionLocks) {
					strictEqual(winners.length, 1, JSON.stringify(results));
					strictEqual(results.filter(({ status }) => status === 412).length, 15, JSON.stringify(results));
					strictEqual(storedValue.n, winners[0].n);
				} else {
					strictEqual(winners.length, 16, JSON.stringify(results));
					strictEqual(results.filter(({ status }) => status === 412).length, 0, JSON.stringify(results));
					ok(
						winners.some(({ n }) => n === storedValue.n),
						`expected stored value ${storedValue.n} in winners: ${JSON.stringify(results)}`
					);
				}
			}

			test(
				preconditionLocks
					? 'one update wins when all workers receive the same If-Match'
					: 'concurrent If-Match updates all succeed and converge when locks are off',
				async () => {
					ok((await request('PUT', 'race', { n: -1 })).ok);
					const read = await request('GET', 'race');
					const etag = read.headers.get('etag');
					ok(etag);
					await read.text();
					await parallel('PATCH', 'race', { 'If-Match': etag });
				}
			);

			test(
				preconditionLocks
					? 'one create wins with If-None-Match wildcard'
					: 'concurrent If-None-Match wildcard creates all succeed and converge when locks are off',
				async () => {
					await parallel('PUT', 'create-once', { 'If-None-Match': '*' });
				}
			);

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

			test('honors HTTP dates, including precedence and invalid-date handling', async () => {
				for (const method of ['PUT', 'PATCH', 'DELETE']) {
					const id = `dates-${method}`;
					ok((await request('PUT', id, { n: 1 })).ok);
					const before = await request('GET', id);
					const modified = before.headers.get('last-modified');
					ok(modified);
					await before.text();
					for (const readMethod of ['GET', 'HEAD']) {
						const cached = await request(readMethod, id, undefined, { 'If-Modified-Since': modified });
						strictEqual(cached.status, 304);
						strictEqual(cached.headers.get('last-modified'), modified);
						strictEqual(await cached.text(), '');
					}
					const rejected = await request(method, id, method === 'DELETE' ? undefined : { n: 2 }, {
						'If-Unmodified-Since': new Date(Date.parse(modified) - 1000).toUTCString(),
					});
					strictEqual(rejected.status, 412, await rejected.text());
					strictEqual(((await (await request('GET', id)).json()) as { n: number }).n, 1);
					const accepted = await request(method, id, method === 'DELETE' ? undefined : { n: 3 }, {
						'If-Unmodified-Since': modified,
					});
					ok(accepted.ok, `${accepted.status}: ${await accepted.text()}`);
				}
				const precedence = await request('GET', 'race', undefined, {
					'If-None-Match': '"other"',
					'If-Modified-Since': new Date(Date.now() + 86_400_000).toUTCString(),
				});
				strictEqual(precedence.status, 200, await precedence.text());
				const ignored = await request('PATCH', 'race', { n: 42 }, { 'If-Unmodified-Since': 'invalid' });
				ok(ignored.ok, `${ignored.status}: ${await ignored.text()}`);
				strictEqual(((await (await request('GET', 'race')).json()) as { n: number }).n, 42);
			});

			test('matching If-None-Match rejects each mutation with 412 and preserves ETag', async () => {
				for (const method of ['PUT', 'PATCH', 'DELETE']) {
					const id = `reject-${method}`;
					ok((await request('PUT', id, { n: 1 })).ok);
					const before = await request('GET', id);
					const etag = before.headers.get('etag');
					ok(etag);
					await before.text();
					const rejected = await request(method, id, method === 'DELETE' ? undefined : { n: 2 }, {
						'If-None-Match': etag,
					});
					strictEqual(rejected.status, 412, await rejected.text());
					const after = await request('GET', id);
					strictEqual(after.headers.get('etag'), etag);
					strictEqual(((await after.json()) as { n: number }).n, 1);
					const accepted = await request(method, id, method === 'DELETE' ? undefined : { n: 3 }, { 'If-Match': etag });
					ok(accepted.ok, `${accepted.status}: ${await accepted.text()}`);
				}
			});
		}
	);
}
