/**
 * #1766 — a root mount (`urlPath: '/'`) matched only the exact path '/': normalizeUrlPath
 * kept '/' as a truthy route constraint, so the static handler became a sub-route whose
 * segment-boundary check ('/' + '/' = '//') never matched any sub-path — every asset 404'd.
 * The root mount now normalizes to "no path constraint" and joins the default chain.
 *
 * The fixture is the field repro: `static: { files: 'web/**', urlPath: '/' }`.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/static-root-urlpath.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-root-urlpath');

suite('static plugin with root urlPath (#1766)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('serves the root index at /', async () => {
		const res = await fetch(new URL('/', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected / to serve the root index: ${res.status} ${text}`);
		ok(text.includes('root index'));
	});

	test('serves a file at a root-mounted sub-path', async () => {
		const res = await fetch(new URL('/test.css', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /test.css to serve: ${res.status} ${text}`);
		ok(text.includes('teal'), 'served the fixture css content');
	});

	test('serves the index file by its full path', async () => {
		const res = await fetch(new URL('/index.html', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /index.html to serve: ${res.status} ${text}`);
		ok(text.includes('root index'));
	});

	test('serves a nested directory index', async () => {
		const res = await fetch(new URL('/docs/', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /docs/ to serve index.html: ${res.status} ${text}`);
		ok(text.includes('docs index'));
	});

	test('redirects a directory request to the trailing-slash path', async () => {
		const res = await fetch(new URL('/docs', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(res.status, 301);
		strictEqual(res.headers.get('location'), '/docs/');
	});

	test('preserves the query string on the trailing-slash redirect', async () => {
		const res = await fetch(new URL('/docs?foo=bar', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(res.status, 301);
		strictEqual(res.headers.get('location'), '/docs/?foo=bar');
	});

	test('falls through to a 404 for paths with no static entry', async () => {
		const res = await fetch(new URL('/no-such-file.js', ctx.harper.httpURL));
		strictEqual(res.status, 404);
	});
});
