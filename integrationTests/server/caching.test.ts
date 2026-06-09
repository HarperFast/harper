/**
 * Integration tests for Harper caching patterns: sourcedFrom,
 * allowStaleWhileRevalidate, and replicationSource.
 *
 * GitHub: https://github.com/HarperFast/harper/issues/1189
 *
 * Spins up a fake HTTP source server inside the test, deploys a GraphQL
 * schema and a resources.js wiring via the operations API, and exercises
 * the full cache lifecycle end-to-end:
 *
 *   1. sourcedFrom(customSource) — cache miss triggers a source fetch; the
 *      resolved value is stored and served from cache on the second request
 *      without re-calling the source.
 *
 *   2. sourcedFrom(source, { replicationSource: true }) — source fetch occurs
 *      on cache miss; subsequent requests are served from cache.
 *      (Peer replication between cluster nodes is multi-node behavior outside
 *       the scope of a single-node integration test; only the single-node
 *       cache-populate path is verified here.)
 *
 *   3. allowStaleWhileRevalidate() — an expired cache entry is returned
 *      immediately (stale), while a background source fetch updates the stored
 *      value; the next request receives the refreshed value.
 *
 *   4. Composite cache key (deviceType prefix in ID) — requests whose IDs
 *      encode different device types produce independent cache entries and do
 *      not cross-contaminate each other.
 *
 *   5. Explicit cache invalidation via HTTP DELETE — a DELETE on a cached
 *      entry causes the next GET to re-fetch from the origin source.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Fake source server
// ---------------------------------------------------------------------------

interface FakeSource {
	url: string;
	callCount: (tableId: string, id: string) => number;
	reset: () => void;
	close: () => Promise<void>;
}

async function startFakeSource(): Promise<FakeSource> {
	const calls = new Map<string, number>();
	const key = (t: string, i: string) => `${t}::${i}`;

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		// GET /record/:tableId/:id  — returns { id, value:'v{n}', callCount:n }
		const recordMatch = req.url?.match(/^\/record\/([^/]+)\/([^/]+)$/);
		if (req.method === 'GET' && recordMatch) {
			const tableId = decodeURIComponent(recordMatch[1]);
			const id = decodeURIComponent(recordMatch[2]);
			const k = key(tableId, id);
			const count = (calls.get(k) ?? 0) + 1;
			calls.set(k, count);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ id, value: `v${count}`, callCount: count }));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${addr.port}`;

	return {
		url: baseUrl,
		callCount: (tableId, id) => calls.get(key(tableId, id)) ?? 0,
		reset: () => calls.clear(),
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

// ---------------------------------------------------------------------------
// Schema and resources
// ---------------------------------------------------------------------------

const SCHEMA_GRAPHQL = [
	'type BasicCacheEntry @table(database: "cachetest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tvalue: String',
	'\tcallCount: Int',
	'}',
	'',
	'type SWRCacheEntry @table(database: "cachetest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tvalue: String',
	'\tcallCount: Int',
	'}',
	'',
	'type ReplicationCacheEntry @table(database: "cachetest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tvalue: String',
	'\tcallCount: Int',
	'}',
	'',
	'type CompositeKeyEntry @table(database: "cachetest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tvalue: String',
	'\tdeviceType: String',
	'}',
	'',
].join('\n');

// resources.js runs inside Harper's process and calls the fake source server
// via the CACHE_TEST_SOURCE_URL environment variable injected at start time.
const RESOURCES_JS = [
	'const SOURCE_URL = process.env.CACHE_TEST_SOURCE_URL;',
	'',
	'const { BasicCacheEntry, SWRCacheEntry, ReplicationCacheEntry, CompositeKeyEntry } = databases.cachetest;',
	'',
	'// --- BasicCacheEntry: plain sourcedFrom (30 s TTL — should not expire during tests)',
	'export class BasicSource extends Resource {',
	'\tasync get() {',
	'\t\tconst id = this.getId();',
	'\t\tconst resp = await fetch(`${SOURCE_URL}/record/basic/${encodeURIComponent(String(id))}`);',
	'\t\tif (!resp.ok) return undefined;',
	'\t\treturn resp.json();',
	'\t}',
	'\t// no-op delete: allows HTTP DELETE to invalidate the local cache entry',
	'\tasync delete() {}',
	'}',
	'BasicCacheEntry.sourcedFrom(BasicSource, { expiration: 30 });',
	'',
	'// --- SWRCacheEntry: allowStaleWhileRevalidate + short TTL for the SWR test',
	'export class SWRSource extends Resource {',
	'\tasync get() {',
	'\t\tconst id = this.getId();',
	'\t\tconst resp = await fetch(`${SOURCE_URL}/record/swr/${encodeURIComponent(String(id))}`);',
	'\t\tif (!resp.ok) return undefined;',
	'\t\treturn resp.json();',
	'\t}',
	'}',
	'SWRCacheEntry.prototype.allowStaleWhileRevalidate = function() { return true; };',
	'SWRCacheEntry.sourcedFrom(SWRSource, { expiration: 0.05, eviction: 5.0 });',
	'',
	'// --- ReplicationCacheEntry: sourcedFrom with replicationSource:true',
	'//     In a single-node environment the option is stored in sourceOptions but does',
	'//     not alter the populate-on-miss behavior; peer replication requires a cluster.',
	'export class ReplicationSource extends Resource {',
	'\tasync get() {',
	'\t\tconst id = this.getId();',
	'\t\tconst resp = await fetch(`${SOURCE_URL}/record/replica/${encodeURIComponent(String(id))}`);',
	'\t\tif (!resp.ok) return undefined;',
	'\t\treturn resp.json();',
	'\t}',
	'}',
	'ReplicationCacheEntry.sourcedFrom(ReplicationSource, { replicationSource: true, expiration: 30 });',
	'',
	'// --- CompositeKeyEntry: ID encodes "deviceType:recordId" for cross-device partitioning',
	'export class CompositeKeySource extends Resource {',
	'\tasync get() {',
	'\t\tconst rawId = String(this.getId());',
	'\t\tconst colonIdx = rawId.indexOf(":");',
	'\t\tconst deviceType = colonIdx >= 0 ? rawId.slice(0, colonIdx) : "unknown";',
	'\t\tconst resp = await fetch(`${SOURCE_URL}/record/composite/${encodeURIComponent(rawId)}`);',
	'\t\tif (!resp.ok) return undefined;',
	'\t\tconst data = await resp.json();',
	'\t\treturn { ...data, deviceType };',
	'\t}',
	'}',
	'CompositeKeyEntry.sourcedFrom(CompositeKeySource, { expiration: 30 });',
	'',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll `condition()` (sync or async) until truthy or timeout. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000, intervalMs = 25): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error('waitFor timed out');
		await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('cache patterns: sourcedFrom, allowStaleWhileRevalidate, replicationSource', (ctx: any) => {
	let fake: FakeSource;
	let client: any;

	before(async () => {
		fake = await startFakeSource();

		await startHarper(ctx, {
			config: { logging: { auditLog: true } },
			env: { CACHE_TEST_SOURCE_URL: fake.url },
		});
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'cachetest' })
			.expect((r: any) => {
				const text = JSON.stringify(r.body);
				ok(text.includes('Successfully added project') || text.includes('Project already exists'), r.text);
			});

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'cachetest',
				file: 'schema.graphql',
				payload: SCHEMA_GRAPHQL,
			})
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: schema.graphql'), r.text))
			.expect(200);

		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'cachetest',
				file: 'resources.js',
				payload: RESOURCES_JS,
			})
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: resources.js'), r.text))
			.expect(200);

		await restartHttpWorkers(client, '/openapi');
		fake.reset();
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await fake.close();
		}
	});

	// -----------------------------------------------------------------------
	// 1. sourcedFrom — basic cache miss → store → hit
	// -----------------------------------------------------------------------

	test('sourcedFrom: cache miss calls source; second request served from cache', async () => {
		fake.reset();
		const id = 'basic-hit-test';

		// First GET: cache miss — source must be called and value returned.
		const first = await request(ctx.harper.httpURL)
			.get(`/BasicCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect(200);
		const firstBody = first.body as { id: string; value: string; callCount: number };
		strictEqual(firstBody.id, id);
		strictEqual(firstBody.value, 'v1', 'first GET should return first source response');
		strictEqual(fake.callCount('basic', id), 1, 'source should be called once on cache miss');

		// Second GET: cache hit — source must NOT be called again.
		const second = await request(ctx.harper.httpURL)
			.get(`/BasicCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect(200);
		const secondBody = second.body as { id: string; value: string };
		strictEqual(secondBody.id, id);
		strictEqual(secondBody.value, 'v1', 'second GET should return cached value without re-fetching');
		strictEqual(fake.callCount('basic', id), 1, 'source should not be called again on cache hit');
	});

	// -----------------------------------------------------------------------
	// 2. sourcedFrom with replicationSource: true
	// -----------------------------------------------------------------------

	test('sourcedFrom with replicationSource:true — source called on miss, cached on hit (single-node)', async () => {
		fake.reset();
		const id = 'replica-hit-test';

		// Cache miss: source must be called.
		const first = await request(ctx.harper.httpURL)
			.get(`/ReplicationCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect(200);
		const firstBody = first.body as { id: string; value: string };
		strictEqual(firstBody.id, id);
		strictEqual(firstBody.value, 'v1', 'first GET should return source response');
		strictEqual(fake.callCount('replica', id), 1, 'source should be called once on cache miss');

		// Cache hit: source must NOT be called again.
		const second = await request(ctx.harper.httpURL)
			.get(`/ReplicationCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect(200);
		const secondBody = second.body as { value: string };
		strictEqual(secondBody.value, 'v1', 'second GET should return cached value');
		strictEqual(fake.callCount('replica', id), 1, 'source should not be re-called on cache hit');
	});

	// -----------------------------------------------------------------------
	// 3. allowStaleWhileRevalidate — stale → immediate return + background refresh
	// -----------------------------------------------------------------------

	test('allowStaleWhileRevalidate: stale value returned immediately; background refresh updates cache', async () => {
		fake.reset();
		const id = 'swr-test';

		// Prime the cache: first GET triggers a source fetch (v1).
		const prime = await request(ctx.harper.httpURL)
			.get(`/SWRCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect(200);
		strictEqual((prime.body as { value: string }).value, 'v1', 'primed cache should hold v1');
		strictEqual(fake.callCount('swr', id), 1, 'source should be called once to prime');

		// Wait for the 50 ms TTL to expire (SWRCacheEntry.sourcedFrom has expiration: 0.05 s).
		// Use 120 ms to allow for CI jitter; eviction is 5 s so the record stays in the DB.
		await new Promise<void>((resolve) => setTimeout(resolve, 120));

		// GET while entry is stale: SWR must return the stale v1 immediately and fire
		// a background revalidation.
		const stale = await request(ctx.harper.httpURL)
			.get(`/SWRCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect(200);
		strictEqual(
			(stale.body as { value: string }).value,
			'v1',
			'stale GET should return the cached (stale) value, not wait for the fresh fetch'
		);

		// Wait for the background revalidation to complete (source is called a second time).
		await waitFor(() => fake.callCount('swr', id) >= 2, 3000);
		strictEqual(fake.callCount('swr', id), 2, 'background refresh should call the source exactly once more');

		// Next GET should return the freshly revalidated value (v2).
		let freshBody: { value: string } | undefined;
		await waitFor(async () => {
			const resp = await request(ctx.harper.httpURL)
				.get(`/SWRCacheEntry/${encodeURIComponent(id)}`)
				.set(client.headers);
			freshBody = resp.body as { value: string };
			return freshBody.value === 'v2';
		}, 3000);
		strictEqual(freshBody!.value, 'v2', 'GET after background refresh should return fresh value v2');
	});

	// -----------------------------------------------------------------------
	// 4. Composite cache key — deviceType prefix in ID partitions cache entries
	// -----------------------------------------------------------------------

	test('composite cache key: different deviceType prefixes produce independent cache entries', async () => {
		fake.reset();
		const mobileId = 'mobile:listing-99';
		const desktopId = 'desktop:listing-99';

		// Fetch the mobile-keyed entry.
		const mobileResp = await request(ctx.harper.httpURL)
			.get(`/CompositeKeyEntry/${encodeURIComponent(mobileId)}`)
			.set(client.headers)
			.expect(200);
		const mobileBody = mobileResp.body as { id: string; deviceType: string; value: string };
		strictEqual(mobileBody.id, mobileId, 'mobile entry id should match composite key');
		strictEqual(mobileBody.deviceType, 'mobile', 'deviceType should be extracted from the composite ID');
		strictEqual(mobileBody.value, 'v1', 'first mobile fetch should be v1 from source');
		strictEqual(fake.callCount('composite', mobileId), 1, 'source called once for mobile entry');

		// Fetch the desktop-keyed entry — must call source independently.
		const desktopResp = await request(ctx.harper.httpURL)
			.get(`/CompositeKeyEntry/${encodeURIComponent(desktopId)}`)
			.set(client.headers)
			.expect(200);
		const desktopBody = desktopResp.body as { id: string; deviceType: string; value: string };
		strictEqual(desktopBody.id, desktopId, 'desktop entry id should match composite key');
		strictEqual(desktopBody.deviceType, 'desktop', 'deviceType should be extracted from the composite ID');
		strictEqual(desktopBody.value, 'v1', 'first desktop fetch should be v1 from source');
		strictEqual(fake.callCount('composite', desktopId), 1, 'source called once for desktop entry');

		// Re-fetch both entries — both should hit the cache (no new source calls).
		await request(ctx.harper.httpURL)
			.get(`/CompositeKeyEntry/${encodeURIComponent(mobileId)}`)
			.set(client.headers)
			.expect(200);
		await request(ctx.harper.httpURL)
			.get(`/CompositeKeyEntry/${encodeURIComponent(desktopId)}`)
			.set(client.headers)
			.expect(200);

		strictEqual(fake.callCount('composite', mobileId), 1, 'mobile entry served from cache on second GET');
		strictEqual(fake.callCount('composite', desktopId), 1, 'desktop entry served from cache on second GET');

		// The two IDs are distinct keys; mobile source call count must not bleed into desktop.
		ok(fake.callCount('composite', mobileId) !== fake.callCount('composite', 'desktop:listing-99-other'), true);
	});

	// -----------------------------------------------------------------------
	// 5. Explicit cache invalidation via HTTP DELETE
	// -----------------------------------------------------------------------

	test('DELETE invalidates cache entry; next GET re-fetches from source', async () => {
		fake.reset();
		const id = 'invalidate-test';

		// Prime the cache.
		const prime = await request(ctx.harper.httpURL)
			.get(`/BasicCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect(200);
		strictEqual((prime.body as { value: string }).value, 'v1', 'primed cache should hold v1');
		strictEqual(fake.callCount('basic', id), 1, 'source called once to prime');

		// DELETE the cached entry to invalidate it.
		await request(ctx.harper.httpURL)
			.delete(`/BasicCacheEntry/${encodeURIComponent(id)}`)
			.set(client.headers)
			.expect((r: any) => ok([200, 204].includes(r.status), `unexpected DELETE status ${r.status}: ${r.text}`));

		// GET after invalidation: cache miss — source must be called again.
		// Poll briefly since the DELETE → re-fetch path may be slightly async.
		let postDeleteBody: { value: string } | undefined;
		await waitFor(async () => {
			const resp = await request(ctx.harper.httpURL)
				.get(`/BasicCacheEntry/${encodeURIComponent(id)}`)
				.set(client.headers);
			if (resp.status !== 200) return false;
			postDeleteBody = resp.body as { value: string };
			return postDeleteBody.value === 'v2';
		}, 3000);

		strictEqual(postDeleteBody!.value, 'v2', 'GET after DELETE should return freshly fetched value v2');
		strictEqual(fake.callCount('basic', id), 2, 'source should be called again after cache invalidation');
	});
});
