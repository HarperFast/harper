/**
 * early-hints component integration test.
 *
 * Deploys early-hints and verifies hint lookup, versioning,
 * Safari mode, CRUD on SiteImages, multiple hints, same-origin URL
 * conversion, empty hints handling, and response length limits.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const q = (url: string) => encodeURIComponent(url);

suite('Component: early-hints', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);

		const deployBody = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: 'early-hints',
			package: 'https://github.com/ldt1996/template-early-hints',
			restart: true,
		});
		deepStrictEqual(deployBody, { message: 'Successfully deployed: early-hints, restarting Harper' });

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
