/**
 * early-hints component integration test.
 *
 * Deploys early-hints and verifies hint lookup, versioning,
 * Safari mode, CRUD on SiteImages, multiple hints, same-origin URL
 * conversion, empty hints handling, and response length limits.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const q = (url: string) => encodeURIComponent(url);

suite('Component: early-hints', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);

		// Deploying the component runs its `npm install`, which on CI intermittently hits transient
		// registry network errors (ECONNRESET / ETIMEDOUT / "Failed to install dependencies"). Retry
		// the deploy a few times on such transient failures before giving up.
		//
		// Separately, `restart: true` makes Harper restart right after accepting the deploy, which on
		// a slow runner can delay or drop the HTTP *response* — surfacing as a fetch
		// `HeadersTimeoutError`. That is not a deploy failure: the readiness polling below (which waits
		// for the /hints endpoint + seed data) is the authoritative success check. So after retries are
		// exhausted we tolerate a missing/failed response and let the poll decide, rather than failing
		// the whole suite in `before`.
		const isTransientDeployError = (e: unknown) => {
			const err = e as any;
			// Check message + code, the nested `cause` (undici fetch errors wrap the real
			// ECONNRESET/timeout there), and the stringified error — a code-only error whose
			// message omits the code, or an undefined message (String(e) === "[object Object]"),
			// would otherwise slip past a message-only check.
			const haystack = [err?.message, err?.code, err?.cause?.message, err?.cause?.code, String(err)]
				.filter(Boolean)
				.join(' ');
			return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|Failed to install dependencies|network/i.test(haystack);
		};
		const DEPLOY_ATTEMPTS = 3;
		let deployBody: any;
		for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS; attempt++) {
			try {
				deployBody = await sendOperation(ctx.harper, {
					operation: 'deploy_component',
					project: 'early-hints',
					package: join(__dirname, '../fixtures/template-early-hints-2.0.0.tgz'),
					restart: true,
				});
				break;
			} catch (e: any) {
				if (attempt < DEPLOY_ATTEMPTS && isTransientDeployError(e)) {
					console.log(
						`[early-hints] deploy attempt ${attempt}/${DEPLOY_ATTEMPTS} hit a transient install/network error; retrying`,
						e
					);
					await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
					continue;
				}
				// Non-transient, or retries exhausted: log the full error (so a genuine failure — bad
				// package, invalid operation, sustained registry outage — is debuggable when the
				// readiness poll later times out) and fall through to the poll.
				console.log('[early-hints] deploy response not received; relying on readiness poll', e);
				break;
			}
		}
		if (deployBody) {
			strictEqual(deployBody.message, 'Successfully deployed: early-hints, restarting Harper');
			ok(typeof deployBody.deployment_id === 'string', `expected deployment_id, got ${deployBody.deployment_id}`);
		}

		// poll until /hints endpoint is registered and seed data is loaded
		const seedDeadline = Date.now() + 60_000;
		while (true) {
			try {
				const check = await fetch(`${ctx.harper.httpURL}/site-images/`);
				if (check.status === 200) {
					const data = await check.json();
					console.log(
						`[early-hints poll seed] status=200 isArray=${Array.isArray(data)} length=${Array.isArray(data) ? data.length : 'n/a'}`
					);
					if (Array.isArray(data) && data.length >= 3) break;
				} else {
					console.log(`[early-hints poll seed] unexpected status: ${check.status}`);
				}
			} catch (e: any) {
				console.log(`[early-hints poll seed] waiting for server... (${e.message})`);
			}
			if (Date.now() > seedDeadline) throw new Error('Timed out waiting for early-hints seed data');
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));

		const readyDeadline = Date.now() + 60_000;
		while (true) {
			try {
				const check = await fetch(`${ctx.harper.httpURL}/site-images/`);
				if (check.status === 200) {
					console.log('[early-hints poll ready] Server is ready.');
					break;
				} else {
					console.log(`[early-hints poll ready] unexpected status: ${check.status}`);
				}
			} catch (e: any) {
				console.log(`[early-hints poll ready] worker still restarting... (${e.message})`);
			}
			if (Date.now() > readyDeadline) throw new Error('Timed out waiting for Harper to be ready after restart');
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('missing q param returns 400', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/hints`);
		strictEqual(res.status, 400);
		const body = await res.json();
		ok(body.error.includes('Missing URL'), `expected missing URL error, got: ${body.error}`);
	});

	test('unknown URL returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.doesnotexist.com/')}`);
		strictEqual(res.status, 404);
		const body = await res.json();
		ok(body.error.includes('No early hints'), `expected no hints error, got: ${body.error}`);
	});

	test('valid URL returns 200 with link header format', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/')}`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(typeof body === 'string', `expected string, got ${typeof body}`);
		match(body, /^<.*rel=preload;as=image;crossorigin>$/);
	});

	test('explicit v=1 returns same result as default', async () => {
		const defaultRes = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/')}`);
		const defaultBody = await defaultRes.json();

		const v1Res = await fetch(`${ctx.harper.httpURL}/hints?v=1&q=${q('https://www.harper.fast/')}`);
		strictEqual(v1Res.status, 200);
		const v1Body = await v1Res.json();

		strictEqual(v1Body, defaultBody);
	});

	test('v=2 with no data returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/hints?v=2&q=${q('https://www.harper.fast/')}`);
		strictEqual(res.status, 404);
	});

	test('safari mode s=1 returns preconnect hints', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/hints?s=1&q=${q('https://www.harper.fast/')}`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(typeof body === 'string', `expected string, got ${typeof body}`);
		match(body, /rel=preconnect/);
		ok(!body.includes('rel=preload'), 'safari mode should return preconnect, not preload');
	});

	test('different pages return different hints', async () => {
		const homeRes = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/')}`);
		const homeBody = await homeRes.json();

		const companyRes = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/company')}`);
		const companyBody = await companyRes.json();

		ok(homeBody !== companyBody, 'expected different hints for different pages');
	});

	test('SiteImages CRUD', async () => {
		// create
		const createRes = await fetch(`${ctx.harper.httpURL}/site-images/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				cacheKey: '1|https://www.harper.fast/test-page',
				hintsVersion: 1,
				pageUrl: 'https://www.harper.fast/test-page',
				hints: ['https://cdn.example.com/test-hero.png'],
			}),
		});
		ok(createRes.status < 300, `create failed: ${createRes.status}`);

		// read via /hints
		const hintsRes = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/test-page')}`);
		strictEqual(hintsRes.status, 200);
		const hintsBody = await hintsRes.json();
		ok(hintsBody.includes('test-hero.png'), `expected test-hero.png in response, got: ${hintsBody}`);

		// delete
		const deleteRes = await fetch(`${ctx.harper.httpURL}/site-images/${q('1|https://www.harper.fast/test-page')}`, {
			method: 'DELETE',
		});
		strictEqual(deleteRes.status, 200);

		// confirm deleted
		const deletedRes = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/test-page')}`);
		strictEqual(deletedRes.status, 404);
	});

	test('multiple hints returned comma-joined', async () => {
		await fetch(`${ctx.harper.httpURL}/site-images/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				cacheKey: '1|https://www.harper.fast/multi',
				hintsVersion: 1,
				pageUrl: 'https://www.harper.fast/multi',
				hints: ['https://cdn.example.com/img1.png', 'https://cdn.example.com/img2.png'],
			}),
		});

		const res = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/multi')}`);
		strictEqual(res.status, 200);
		const body = await res.json();
		const parts = body.split(',');
		strictEqual(parts.length, 2, `expected 2 comma-separated hints, got ${parts.length}`);

		// cleanup
		await fetch(`${ctx.harper.httpURL}/site-images/${q('1|https://www.harper.fast/multi')}`, { method: 'DELETE' });
	});

	test('same-origin URL converted to relative path', async () => {
		await fetch(`${ctx.harper.httpURL}/site-images/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				cacheKey: '1|https://www.harper.fast/relative',
				hintsVersion: 1,
				pageUrl: 'https://www.harper.fast/relative',
				hints: ['https://www.harper.fast/images/hero.png'],
			}),
		});

		const res = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/relative')}`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(body.includes('</images/hero.png;'), `expected relative path, got: ${body}`);
		ok(!body.includes('https://www.harper.fast'), `should not contain full origin, got: ${body}`);

		// cleanup
		await fetch(`${ctx.harper.httpURL}/site-images/${q('1|https://www.harper.fast/relative')}`, { method: 'DELETE' });
	});

	test('empty hints array returns 404', async () => {
		await fetch(`${ctx.harper.httpURL}/site-images/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				cacheKey: '1|https://www.harper.fast/empty',
				hintsVersion: 1,
				pageUrl: 'https://www.harper.fast/empty',
				hints: [],
			}),
		});

		const res = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/empty')}`);
		strictEqual(res.status, 404);

		// cleanup
		await fetch(`${ctx.harper.httpURL}/site-images/${q('1|https://www.harper.fast/empty')}`, { method: 'DELETE' });
	});

	test('response stays within 1024 char limit', async () => {
		const longHints = Array.from(
			{ length: 8 },
			(_, i) =>
				`https://cdn.example.com/image-with-a-really-long-name-that-keeps-going-${String(i).padStart(4, '0')}.png`
		);

		await fetch(`${ctx.harper.httpURL}/site-images/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				cacheKey: '1|https://www.harper.fast/long',
				hintsVersion: 1,
				pageUrl: 'https://www.harper.fast/long',
				hints: longHints,
			}),
		});

		const res = await fetch(`${ctx.harper.httpURL}/hints?q=${q('https://www.harper.fast/long')}`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(body.length <= 1024, `response ${body.length} chars exceeds 1024 limit`);

		// cleanup
		await fetch(`${ctx.harper.httpURL}/site-images/${q('1|https://www.harper.fast/long')}`, { method: 'DELETE' });
	});
});
