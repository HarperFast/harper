/**
 * `http.securityHeaders` integration tests.
 *
 * Verifies the config-driven universal response headers end-to-end across the response
 * paths of the Harper-native request handler on app ports: the normal 200 writeHead path,
 * the 404 (`status === -1` cascade) path, the `handlesHeaders` static-file path (where the
 * `send()` stream writes its own headers), the thrown-error path, and app-wins precedence
 * (a route-set header is never overridden by config). Also verifies the feature is fully
 * opt-in: absent config adds no headers.
 *
 * Scope note: `universalHeaders` is per-thread module state populated by the http
 * component's `handleApplication`, which the componentLoader only runs on worker threads
 * (`resources.isWorker` gate). The operations API runs on the main thread, where that never
 * happens, so ops responses don't carry these headers in normal mode (with `threads: 0`
 * they would — benign). See DESIGN.md "`universalHeaders` (`http.securityHeaders`)".
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { join } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'security-headers-app');
const REQUEST_TIMEOUT_MS = 5000;

function authHeader(ctx: ContextWithHarper) {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

function appRequest(ctx: ContextWithHarper, path: string, withAuth = true) {
	return fetch(`${ctx.harper.httpURL}${path}`, {
		headers: withAuth ? { Authorization: authHeader(ctx) } : {},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

suite('http.securityHeaders (config-driven response headers)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE, {
			config: {
				http: {
					securityHeaders: {
						'X-Frame-Options': 'SAMEORIGIN',
						'X-Content-Type-Options': 'nosniff',
					},
				},
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('headers appear on a normal 200 REST response', async () => {
		const response = await appRequest(ctx, '/Echo/');
		strictEqual(response.status, 200);
		strictEqual(response.headers.get('x-frame-options'), 'SAMEORIGIN');
		strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
	});

	test('headers appear on a 404 (unhandled-cascade) response', async () => {
		const response = await appRequest(ctx, '/does-not-exist/');
		ok(response.status >= 400, `expected a client/not-found response, got ${response.status}`);
		strictEqual(response.headers.get('x-frame-options'), 'SAMEORIGIN');
		strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
	});

	test('headers appear on a static-file (handlesHeaders) response', async () => {
		const response = await appRequest(ctx, '/index.html', false);
		strictEqual(response.status, 200);
		ok((await response.text()).includes('static content'));
		strictEqual(response.headers.get('x-frame-options'), 'SAMEORIGIN');
		strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
	});

	test('headers appear on a thrown-error response', async () => {
		const response = await appRequest(ctx, '/Boom/');
		strictEqual(response.status, 500);
		strictEqual(response.headers.get('x-frame-options'), 'SAMEORIGIN');
		strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
	});

	test('app-set header wins over the configured value', async () => {
		const response = await appRequest(ctx, '/FrameDeny/');
		strictEqual(response.status, 200);
		strictEqual(response.headers.get('x-frame-options'), 'DENY');
		// the other configured header still applies as a default
		strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
	});
});

suite('http.securityHeaders absent (opt-in, no behavior change)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('no security headers are added when http.securityHeaders is not configured', async () => {
		const response = await appRequest(ctx, '/Echo/');
		strictEqual(response.status, 200);
		strictEqual(response.headers.get('x-frame-options'), null);
		strictEqual(response.headers.get('x-content-type-options'), null);
	});
});
