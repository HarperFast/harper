/**
 * #1583 — the static plugin served nothing when `urlPath` was configured: the routing chain
 * strips the mount prefix from req.pathname while the file map was keyed by the full entry
 * URL path, and a slash-less `urlPath` (e.g. 'assets') never matched the route at all.
 *
 * The fixture is the issue's minimal repro: `static: { files: 'web/**', urlPath: 'assets' }`.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/static-urlpath.test.ts"
 */
import { suite, test, before, after } from 'node:test';
<<<<<<< HEAD
<<<<<<< HEAD
import { strictEqual, ok } from 'node:assert';
=======
import { strictEqual, ok } from 'node:assert/strict';
>>>>>>> 21d022b54 (Fix static plugin serving nothing when urlPath is configured (#1583))
=======
import { strictEqual, ok } from 'node:assert';
>>>>>>> a2e9a63f1 (fix(lint): import from node:assert, not node:assert/strict)
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-urlpath');

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
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> aae9a110d (Preserve query strings on static trailing-slash redirects)

	test('preserves the query string on trailing-slash redirects', async () => {
		const root = await fetch(new URL('/assets?foo=bar', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(root.status, 301);
		strictEqual(root.headers.get('location'), '/assets/?foo=bar');
		const dir = await fetch(new URL('/assets/docs?foo=bar', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(dir.status, 301);
		strictEqual(dir.headers.get('location'), '/assets/docs/?foo=bar');
	});
<<<<<<< HEAD
=======
>>>>>>> 21d022b54 (Fix static plugin serving nothing when urlPath is configured (#1583))
=======
>>>>>>> aae9a110d (Preserve query strings on static trailing-slash redirects)
});
