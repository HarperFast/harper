/**
 * Static plugin `urlPath` mount coverage. One suite per mount shape — a mount lives in the
 * fixture app's config.yaml and an app has a single `static` block, so each shape needs its
 * own fixture/instance:
 *
 * - Subpath mount (#1583): the plugin served nothing when `urlPath` was configured — the
 *   routing chain strips the mount prefix from req.pathname while the file map was keyed by
 *   the full entry URL path, and a slash-less `urlPath` (e.g. 'assets') never matched the
 *   route at all. Fixture: `static: { files: 'web/**', urlPath: 'assets' }`.
 * - Root mount (#1766): `urlPath: '/'` matched only the exact path '/' — normalizeUrlPath
 *   kept '/' as a truthy route constraint, so the handler became a sub-route whose
 *   segment-boundary check ('/' + '/' = '//') never matched any sub-path; every asset 404'd.
 *   Fixture: `static: { files: 'web/**', urlPath: '/' }`.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/static-urlpath.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-urlpath');
const ROOT_FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-root-urlpath');

suite('static plugin with urlPath (#1583)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('serves a file under the configured urlPath', async () => {
		const res = await fetch(new URL('/assets/test.css', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /assets/test.css to serve: ${res.status} ${text}`);
		ok(text.includes('teal'), 'served the fixture css content');
	});

	test('does not serve the file at the unprefixed path', async () => {
		const res = await fetch(new URL('/test.css', ctx.harper.httpURL));
		strictEqual(res.status, 404);
	});

	test('serves a directory index under the urlPath', async () => {
		const res = await fetch(new URL('/assets/docs/', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /assets/docs/ to serve index.html: ${res.status} ${text}`);
		ok(text.includes('docs index'));
	});

	test('redirects a directory request to the trailing-slash path including the mount prefix', async () => {
		const res = await fetch(new URL('/assets/docs', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(res.status, 301);
		strictEqual(res.headers.get('location'), '/assets/docs/');
	});

	test('serves the root index at the trailing-slash mount path', async () => {
		const res = await fetch(new URL('/assets/', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /assets/ to serve the root index: ${res.status} ${text}`);
		ok(text.includes('root index'));
	});

	test('redirects the no-slash mount root to the trailing-slash form', async () => {
		const res = await fetch(new URL('/assets', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(res.status, 301);
		strictEqual(res.headers.get('location'), '/assets/');
	});

	test('preserves the query string on trailing-slash redirects', async () => {
		const root = await fetch(new URL('/assets?foo=bar', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(root.status, 301);
		strictEqual(root.headers.get('location'), '/assets/?foo=bar');
		const dir = await fetch(new URL('/assets/docs?foo=bar', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(dir.status, 301);
		strictEqual(dir.headers.get('location'), '/assets/docs/?foo=bar');
	});
});

suite('static plugin with root urlPath (#1766)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, ROOT_FIXTURE_PATH);
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
