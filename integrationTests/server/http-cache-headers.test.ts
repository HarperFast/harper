/**
 * HTTP cache-header hardening and defaults (#1518, #1565).
 *
 * Covers the three tiers of Harper's Cache-Control/Vary policy:
 *
 *   1. `Vary: Origin` on CORS-enabled responses (reflected ACAO and preflight) so a shared
 *      cache/CDN cannot serve one origin's CORS headers to another (#1518).
 *   2. The identity floor: authenticated (and 401) responses get `Cache-Control: private,
 *      no-cache` + `Vary: Authorization` (+ `Cookie` with sessions) unless the app explicitly
 *      opted into shared caching with `public`/`s-maxage` (#1565).
 *   3. Declared shared-cache headers for anonymous reads: `@table(cacheControl: "...")` (or a
 *      resource `static cacheControl`), so CDNs like Akamai can cache public responses. The
 *      declaration is required — anonymous readability alone never emits shared-cache headers.
 *
 * The fixture app is installed before boot (so every thread, including main, processes the
 * schema), and `AUTHENTICATION_AUTHORIZELOCAL=false` keeps unauthenticated loopback requests
 * genuinely anonymous — overriding the harness's authorize-local default.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import request from 'supertest';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/http-cache-headers');

function varyTokens(res: any): string[] {
	const vary = res.headers['vary'] ?? '';
	return vary
		.toLowerCase()
		.split(',')
		.map((s: string) => s.trim())
		.filter(Boolean);
}

suite('HTTP cache headers (#1518, #1565)', (ctx: any) => {
	let client: any;
	let restURL: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				http: { cors: true, corsAccessList: ['*'] },
			},
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;

		// seed one record per table
		for (const [path, id] of [
			['/SecretDoc/', 'sec1'],
			['/LabeledDoc/', 'lab1'],
		]) {
			await request(restURL)
				.put(`${path}${id}`)
				.set(client.headers)
				.send({ id, value: 'seed' })
				.expect((r: any) => ok([200, 201, 204].includes(r.status), `seed PUT ${path}${id} → ${r.status}: ${r.text}`));
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── #1518: Vary: Origin ────────────────────────────────────────────────

	test('CORS GET with Origin: ACAO reflected and Vary includes Origin', async () => {
		const res = await request(restURL)
			.get('/SecretDoc/sec1')
			.set(client.headers)
			.set('Origin', 'https://a.example.com')
			.expect(200);
		strictEqual(res.headers['access-control-allow-origin'], 'https://a.example.com');
		ok(varyTokens(res).includes('origin'), `Vary should include Origin, got: ${res.headers['vary']}`);
	});

	test('OPTIONS preflight carries Vary: Origin', async () => {
		const res = await request(restURL)
			.options('/SecretDoc/sec1')
			.set('Origin', 'https://a.example.com')
			.set('Access-Control-Request-Method', 'GET');
		strictEqual(res.headers['access-control-allow-origin'], 'https://a.example.com');
		ok(varyTokens(res).includes('origin'), `preflight Vary should include Origin, got: ${res.headers['vary']}`);
	});

	test('CORS-enabled response without an Origin header still varies on Origin', async () => {
		// the no-Origin variant (no ACAO) is itself origin-dependent — a cache serving it to a
		// CORS request would break that request
		const res = await request(restURL).get('/SecretDoc/sec1').set(client.headers).expect(200);
		ok(varyTokens(res).includes('origin'), `Vary should include Origin, got: ${res.headers['vary']}`);
	});

	test('Vary appends to serializer tokens instead of clobbering them', async () => {
		const res = await request(restURL).get('/SecretDoc/sec1').set(client.headers).expect(200);
		const tokens = varyTokens(res);
		for (const expected of ['accept', 'accept-encoding', 'origin', 'authorization']) {
			ok(tokens.includes(expected), `Vary should include ${expected}, got: ${res.headers['vary']}`);
		}
	});

	// ── #1565: identity floor ──────────────────────────────────────────────

	test('authenticated read gets private, no-cache + Vary: Authorization, Cookie', async () => {
		const res = await request(restURL).get('/SecretDoc/sec1').set(client.headers).expect(200);
		strictEqual(res.headers['cache-control'], 'private, no-cache');
		const tokens = varyTokens(res);
		ok(tokens.includes('authorization'), `Vary should include Authorization, got: ${res.headers['vary']}`);
		ok(tokens.includes('cookie'), `Vary should include Cookie (sessions enabled), got: ${res.headers['vary']}`);
	});

	test('401 for anonymous access to a protected table carries the private floor', async () => {
		const res = await request(restURL).get('/SecretDoc/sec1').expect(401);
		strictEqual(res.headers['cache-control'], 'private, no-cache');
		ok(varyTokens(res).includes('authorization'), `Vary should include Authorization, got: ${res.headers['vary']}`);
	});

	test('401 with an app-set public Cache-Control is still forced private (no opt-in on rejection)', async () => {
		const res = await request(restURL).get('/PublicButDenied/x').set(client.headers).expect(401);
		strictEqual(res.headers['cache-control'], 'private, no-cache');
		ok(varyTokens(res).includes('authorization'), `Vary should include Authorization, got: ${res.headers['vary']}`);
	});

	test('authenticated read of a cacheControl-labeled table still gets the private floor', async () => {
		// the @table(cacheControl:) default applies to anonymous reads only; an authenticated
		// response must not inherit the shared-cache policy
		const res = await request(restURL).get('/PublicLabeled/lab1').set(client.headers).expect(200);
		strictEqual(res.headers['cache-control'], 'private, no-cache');
	});

	test('app-set public Cache-Control on an authenticated response is trusted (RFC 9111 opt-in)', async () => {
		const res = await request(restURL).get('/SelfCaching/x').set(client.headers).expect(200);
		strictEqual(res.headers['cache-control'], 'public, max-age=10');
		ok(!varyTokens(res).includes('authorization'), `opted-in response should not vary on Authorization`);
	});

	// ── #1565 converse: anonymous shared-cache defaults ────────────────────

	test('anonymous read emits @table(cacheControl:) declaration', async () => {
		const res = await request(restURL).get('/PublicLabeled/lab1').expect(200);
		strictEqual(res.headers['cache-control'], 'public, max-age=45');
		ok(!varyTokens(res).includes('authorization'), `anonymous response should not vary on Authorization`);
	});

	test('anonymous read of a caching table with a declared cacheControl emits it', async () => {
		const res = await request(restURL).get('/PublicCached/c1').expect(200);
		strictEqual(res.headers['cache-control'], 'public, s-maxage=120');
	});

	test('anonymous read of a caching table WITHOUT a declaration emits no Cache-Control', async () => {
		// shared-cache headers require the explicit declaration — a TTL alone is not an opt-in
		const res = await request(restURL).get('/PublicPlainCached/c1').expect(200);
		strictEqual(res.headers['cache-control'], undefined);
	});

	test('anonymous read with app-set Cache-Control keeps the app value', async () => {
		const res = await request(restURL).get('/SelfCaching/x').expect(200);
		strictEqual(res.headers['cache-control'], 'public, max-age=10');
	});

	test('describe_table surfaces cacheControl', async () => {
		const res = await client
			.req()
			.send({ operation: 'describe_table', database: 'data', table: 'LabeledDoc' })
			.expect(200);
		strictEqual(res.body.cacheControl, 'public, max-age=45');
	});
});
