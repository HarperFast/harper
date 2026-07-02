/**
 * `http.securityHeaders` integration tests.
 *
 * Verifies the config-driven universal response headers feature end-to-end: headers
 * configured under `http.securityHeaders` are appended to REST/app HTTP responses, and the
 * feature is fully opt-in (absent config means no extra headers, no behavior change).
 *
 * Scope note: `universalHeaders` is applied in the Harper-native request handler
 * (`onRequest` in server/http.ts). The operations API is served directly by its own Fastify
 * `http.Server` instance (registered as a raw listener rather than a function middleware —
 * see `httpServer()`'s branch for non-function listeners in server/http.ts), so it never
 * flows through `onRequest` and does not currently receive `universalHeaders`. These tests
 * cover the REST/app path, which is the intended scope for security headers like
 * X-Frame-Options.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const REQUEST_TIMEOUT_MS = 5000;

suite('http.securityHeaders (config-driven response headers)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
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

	test('configured security headers appear on plain REST responses (including 404s)', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/does-not-exist/`, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		ok(response.status >= 400, `expected a client/not-found response, got ${response.status}`);
		strictEqual(response.headers.get('x-frame-options'), 'SAMEORIGIN');
		strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
	});
});

suite('http.securityHeaders absent (opt-in, no behavior change)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('no security headers are added when http.securityHeaders is not configured', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/does-not-exist/`, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		ok(response.status >= 400, `expected a client/not-found response, got ${response.status}`);
		strictEqual(response.headers.get('x-frame-options'), null);
		strictEqual(response.headers.get('x-content-type-options'), null);
	});
});
