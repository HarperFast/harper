/**
 * Caching integration tests.
 *
 * Exercises `sourcedFrom()` and `allowStaleWhileRevalidate()` end-to-end through a
 * live Harper instance.  A lightweight HTTP origin server is started in-process so
 * every fetch can be counted without mocking internals.
 *
 * Scenarios:
 *
 *   1. **Cache miss → origin fetch → cached** — first GET triggers one origin
 *      request; second GET is served from cache with no additional origin hit.
 *
 *   2. **404 on origin → 404 from Harper** — when the origin returns 404 the
 *      resource does the same.
 *
 *   3. **DELETE invalidates cache → re-fetch** — after an explicit DELETE the next
 *      GET must go back to the origin.
 *
 *   4. **allowStaleWhileRevalidate** — a stale record is returned immediately while
 *      a background revalidation fires; the subsequent GET reflects the refreshed
 *      value without an additional origin hit.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

// ---------------------------------------------------------------------------
// Mock origin server helpers
// ---------------------------------------------------------------------------

interface MockOrigin {
	url: string;
	close(): Promise<void>;
	fetchCount(key: string): number;
	resetCounts(): void;
	setData(key: string, value: unknown): void;
	deleteData(key: string): void;
}

async function startMockOrigin(): Promise<MockOrigin> {
	const fetchCounts = new Map<string, number>();
	const data = new Map<string, unknown>();

	const server: Server = createServer((req, res) => {
		const key = req.url?.slice(1) ?? '';
		fetchCounts.set(key, (fetchCounts.get(key) ?? 0) + 1);
		const value = data.get(key);
		if (value !== undefined) {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=10' });
			res.end(JSON.stringify(value));
		} else {
			res.writeHead(404);
			res.end();
		}
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${addr.port}`;

	return {
		url,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
		fetchCount: (key) => fetchCounts.get(key) ?? 0,
		resetCounts: () => fetchCounts.clear(),
		setData: (key, value) => data.set(key, value),
		deleteData: (key) => data.delete(key),
	};
}

// ---------------------------------------------------------------------------
// Component definition
// ---------------------------------------------------------------------------

const SCHEMA_GRAPHQL = `
type CachedProduct @table(database: "cachingtest") @sealed @export {
	id: ID! @primaryKey
	name: String
	price: Float
}

type StaleProduct @table(database: "cachingtest") @sealed @export {
	id: ID! @primaryKey
	name: String
	revision: Int
}
`.trim();

// resources.js is evaluated by Harper's component loader at boot.  The loader
// provides `Resource` and `databases` as globals — no imports needed.
//
// CachedProduct: plain sourcedFrom with a short TTL so we can exercise
//   cache-miss and invalidation in fast wall-clock time.
//
// StaleProduct: same source wiring but the class overrides
//   allowStaleWhileRevalidate() to always return true, enabling SWR behaviour.
function buildResourcesJs(originUrl: string): string {
	return [
		`const { CachedProduct, StaleProduct } = databases.cachingtest;`,
		``,
		`// Source for CachedProduct — forwards reads to the mock origin.`,
		`// Implements delete() so REST DELETE on the table can propagate`,
		`// (clears the local cache entry without touching the origin).`,
		`export class ProductSource extends Resource {`,
		`\tasync get() {`,
		`\t\tconst id = this.getId();`,
		`\t\tconst response = await fetch(${JSON.stringify(originUrl)} + '/' + id);`,
		`\t\tif (!response.ok) {`,
		`\t\t\tconst err = new Error('Origin returned ' + response.status + ' for ' + id);`,
		`\t\t\terr.statusCode = response.status;`,
		`\t\t\tthrow err;`,
		`\t\t}`,
		`\t\treturn response.json();`,
		`\t}`,
		`\tdelete() {`,
		`\t\t// allow DELETE to clear the cached entry`,
		`\t}`,
		`}`,
		``,
		// 30 s expiration: long enough that the non-expiry tests never race the TTL,
		// even on slow CI runners.
		`CachedProduct.sourcedFrom(ProductSource, { expiration: 30 });`,
		``,
		`// Source for StaleProduct — same fetch logic.`,
		`export class StaleProdSource extends Resource {`,
		`\tasync get() {`,
		`\t\tconst id = this.getId();`,
		`\t\tconst response = await fetch(${JSON.stringify(originUrl)} + '/' + id);`,
		`\t\tif (!response.ok) {`,
		`\t\t\tconst err = new Error('Origin returned ' + response.status + ' for ' + id);`,
		`\t\t\terr.statusCode = response.status;`,
		`\t\t\tthrow err;`,
		`\t\t}`,
		`\t\treturn response.json();`,
		`\t}`,
		`}`,
		``,
		`// Wire stale-while-revalidate directly on StaleProduct by overriding the method`,
		`// on the table class after calling sourcedFrom, so /StaleProduct/* routes use SWR.`,
		`// expiration (100 ms) < eviction (10 s): stale entries linger in the DB long`,
		`// enough for SWR to serve them while background revalidation runs.`,
		`StaleProduct.sourcedFrom(StaleProdSource, { expiration: 0.1, eviction: 10 });`,
		`StaleProduct.prototype.allowStaleWhileRevalidate = function(_entry, _id) { return true; };`,
		``,
	].join('\n');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Caching: sourcedFrom and allowStaleWhileRevalidate', (ctx: any) => {
	let origin: MockOrigin;
	let client: any;

	before(async () => {
		origin = await startMockOrigin();

		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'cachingtest' })
			.expect((r: any) => {
				const text = JSON.stringify(r.body);
				ok(
					text.includes('Successfully added project') || text.includes('Project already exists'),
					`add_component failed: ${r.text}`
				);
			});

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'cachingtest',
				file: 'schema.graphql',
				payload: SCHEMA_GRAPHQL,
			})
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: schema.graphql'), r.text))
			.expect(200);

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'cachingtest',
				file: 'resources.js',
				payload: buildResourcesJs(origin.url),
			})
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: resources.js'), r.text))
			.expect(200);

		await restartHttpWorkers(client, '/openapi');
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await origin.close();
		}
	});

	// -------------------------------------------------------------------------
	// Test 1: cache miss → origin fetch → cache populated → second GET no re-fetch
	// -------------------------------------------------------------------------
	test('cache miss fetches from origin; second GET is served from cache', { timeout: 15000 }, async () => {
		const id = 'prod-1';
		origin.setData(id, { id, name: 'Widget', price: 9.99 });
		origin.resetCounts();

		const baseUrl = ctx.harper.httpURL;
		const authHeader = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		// First GET: cache miss → origin should be hit once
		const r1 = await fetch(`${baseUrl}/CachedProduct/${id}`, { headers: { Authorization: authHeader } });
		strictEqual(r1.status, 200, 'First GET should succeed');
		const body1 = await r1.json();
		strictEqual(body1.name, 'Widget');
		strictEqual(body1.price, 9.99);
		strictEqual(origin.fetchCount(id), 1, 'Origin should have been called once after cache miss');

		// Second GET: should be served from cache — no additional origin hit
		const r2 = await fetch(`${baseUrl}/CachedProduct/${id}`, { headers: { Authorization: authHeader } });
		strictEqual(r2.status, 200, 'Second GET should succeed');
		const body2 = await r2.json();
		strictEqual(body2.name, 'Widget');
		strictEqual(origin.fetchCount(id), 1, 'Origin should not be called again on cache hit');
	});

	// -------------------------------------------------------------------------
	// Test 2: cache miss returns 404 when origin 404s
	// -------------------------------------------------------------------------
	test('cache miss propagates origin 404 to the client', { timeout: 10000 }, async () => {
		const id = 'nonexistent-product';
		// Do not seed origin data — it will return 404
		origin.resetCounts();

		const baseUrl = ctx.harper.httpURL;
		const authHeader = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		const r = await fetch(`${baseUrl}/CachedProduct/${id}`, { headers: { Authorization: authHeader } });
		strictEqual(r.status, 404, 'Should return 404 when origin returns 404');
		strictEqual(origin.fetchCount(id), 1, 'Origin should have been called once');
	});

	// -------------------------------------------------------------------------
	// Test 3: explicit DELETE removes cached record → next GET re-fetches
	// -------------------------------------------------------------------------
	test('DELETE invalidates cache; subsequent GET re-fetches from origin', { timeout: 15000 }, async () => {
		const id = 'prod-delete';
		origin.setData(id, { id, name: 'Gadget', price: 19.99 });
		origin.resetCounts();

		const baseUrl = ctx.harper.httpURL;
		const authHeader = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		// Populate cache
		const r1 = await fetch(`${baseUrl}/CachedProduct/${id}`, { headers: { Authorization: authHeader } });
		strictEqual(r1.status, 200);
		strictEqual(origin.fetchCount(id), 1, 'Should fetch from origin on first GET');

		// Invalidate via DELETE
		const rDel = await fetch(`${baseUrl}/CachedProduct/${id}`, {
			method: 'DELETE',
			headers: { Authorization: authHeader },
		});
		ok(rDel.status === 200 || rDel.status === 204, `DELETE should succeed, got ${rDel.status}`);

		// Next GET must go back to the origin
		const r2 = await fetch(`${baseUrl}/CachedProduct/${id}`, { headers: { Authorization: authHeader } });
		strictEqual(r2.status, 200);
		const body2 = await r2.json();
		strictEqual(body2.name, 'Gadget');
		strictEqual(origin.fetchCount(id), 2, 'Origin should be called again after cache invalidation');
	});

	// -------------------------------------------------------------------------
	// Test 4: allowStaleWhileRevalidate — stale returned immediately, revalidated in bg
	// -------------------------------------------------------------------------
	test(
		'allowStaleWhileRevalidate serves stale immediately and revalidates in background',
		{ timeout: 20000 },
		async () => {
			const id = 'stale-1';

			// Revision 1 in origin
			origin.setData(id, { id, name: 'Stale Widget', revision: 1 });
			origin.resetCounts();

			const baseUrl = ctx.harper.httpURL;
			const authHeader = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

			// Prime the cache with revision 1
			const r1 = await fetch(`${baseUrl}/StaleProduct/${id}`, { headers: { Authorization: authHeader } });
			strictEqual(r1.status, 200);
			const body1 = await r1.json();
			strictEqual(body1.revision, 1, 'Should get revision 1 on first fetch');
			strictEqual(origin.fetchCount(id), 1, 'Origin called once to prime cache');

			// Update origin to revision 2 and wait for TTL to expire (expiration: 0.05 s = 50 ms)
			origin.setData(id, { id, name: 'Fresh Widget', revision: 2 });
			await delay(250); // wait longer than the 100 ms TTL so the entry is stale but not evicted
			origin.resetCounts();

			// GET while stale: allowStaleWhileRevalidate should return the stale value immediately
			// and kick off a background revalidation
			const r2 = await fetch(`${baseUrl}/StaleProduct/${id}`, { headers: { Authorization: authHeader } });
			strictEqual(r2.status, 200, 'Stale GET should succeed');
			const body2 = await r2.json();
			// The stale value (revision 1) should be served immediately
			strictEqual(body2.revision, 1, 'Stale value should be returned immediately');

			// Background revalidation must start: poll until the mock origin has received
			// the fetch.  Asserting synchronously here is racy because the HTTP round-trip
			// can complete before the background task executes.
			const bgDeadline = Date.now() + 5000;
			while (origin.fetchCount(id) === 0 && Date.now() < bgDeadline) {
				await delay(25);
			}
			ok(origin.fetchCount(id) >= 1, 'Background revalidation should have started');

			// Wait for the background revalidation to complete, then re-fetch.
			// Poll at 25 ms — shorter than the 100 ms TTL so the freshly-written entry
			// does not expire again before we read it.
			let freshBody: any;
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				await delay(25);
				const r3 = await fetch(`${baseUrl}/StaleProduct/${id}`, { headers: { Authorization: authHeader } });
				freshBody = await r3.json();
				if (freshBody.revision === 2) break;
			}
			strictEqual(freshBody?.revision, 2, 'Cache should reflect the fresh value after background revalidation');
			// Only one origin fetch should have occurred for the full revalidation cycle
			strictEqual(origin.fetchCount(id), 1, 'Only one origin fetch should have occurred for revalidation');
		}
	);
});
