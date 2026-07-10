/**
 * Static plugin cache-header options (`maxAge`, `immutable`, `cacheControl`).
 *
 * The plugin reads these options live from the component config on every request, so a single
 * instance covers all variants: assert the default, then rewrite config.yaml via
 * set_component_file and poll until the next request reflects the new policy.
 *
 * Run: npm run test:integration -- "integrationTests/components/static-cache-headers.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-cache-headers');
const PROJECT = 'static-cache-headers';

suite('static plugin cache-header options', (ctx: ContextWithHarper) => {
	let client: any;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function getPath(path: string): Promise<Response> {
		const res = await fetch(new URL(path, ctx.harper.httpURL));
		strictEqual(res.status, 200);
		await res.text(); // drain
		return res;
	}

	async function getCss(): Promise<Response> {
		return getPath('/test.css');
	}

	async function setStaticConfig(yaml: string): Promise<void> {
		await client.req().send({ operation: 'set_component_file', project: PROJECT, file: 'config.yaml', payload: yaml });
	}

	/**
	 * Set the config and poll until the served Cache-Control matches. The config is re-sent
	 * periodically during the poll: a config write landing milliseconds after the previous one can
	 * lose its chokidar change event (watcher re-establishment race — see #1747), and the reload
	 * plumbing is not what this suite tests; the header options are.
	 */
	async function applyAndWaitForCacheControl(
		yaml: string,
		expected: string | null,
		timeoutMs = 20_000
	): Promise<Response> {
		await setStaticConfig(yaml);
		const deadline = Date.now() + timeoutMs;
		let last: string | null = null;
		let sinceResend = 0;
		while (Date.now() < deadline) {
			const res = await getCss();
			last = res.headers.get('cache-control');
			if (last === expected) return res;
			if (++sinceResend >= 10) {
				sinceResend = 0;
				await setStaticConfig(yaml);
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		throw new Error(`Cache-Control never became ${JSON.stringify(expected)}; last seen: ${JSON.stringify(last)}`);
	}

	test('default: public, max-age=0 with ETag/Last-Modified', async () => {
		const res = await getCss();
		strictEqual(res.headers.get('cache-control'), 'public, max-age=0');
		ok(res.headers.get('etag'), 'should emit an ETag');
		ok(res.headers.get('last-modified'), 'should emit Last-Modified');
	});

	test('maxAge in seconds', async () => {
		await applyAndWaitForCacheControl("static:\n  files: 'web/**'\n  maxAge: 300\n", 'public, max-age=300');
	});

	test('maxAge as duration string + immutable', async () => {
		await applyAndWaitForCacheControl(
			"static:\n  files: 'web/**'\n  maxAge: 1d\n  immutable: true\n",
			'public, max-age=86400, immutable'
		);
	});

	test('cacheControl string overrides maxAge/immutable', async () => {
		await applyAndWaitForCacheControl(
			"static:\n  files: 'web/**'\n  maxAge: 300\n  cacheControl: 'public, max-age=60, s-maxage=3600'\n",
			'public, max-age=60, s-maxage=3600'
		);
	});

	test('cacheControl: false suppresses the header', async () => {
		await applyAndWaitForCacheControl("static:\n  files: 'web/**'\n  cacheControl: false\n", null);
	});

	test('cacheOverrides: per-file policy layered over the top-level defaults', async () => {
		// Long-lived immutable default (the hashed-asset case); index.html gets its own short,
		// revalidating window — Dawson's motivating example.
		const yaml =
			'static:\n' +
			"  files: 'web/**'\n" +
			'  maxAge: 1y\n' +
			'  immutable: true\n' +
			'  cacheOverrides:\n' +
			"    'index.html': { cacheControl: 'public, max-age=0, stale-while-revalidate=60' }\n" +
			'    "*.css": { maxAge: 60 }\n';
		// Poll on the css file until the override lands (confirms the config reload applied). The
		// '*.css' override sets only maxAge, so immutable is inherited from the top level — partial merge.
		await applyAndWaitForCacheControl(yaml, 'public, max-age=60, immutable');
		// index.html, matched by basename on the directory-index (`/`) serve, gets its full-string
		// override, which takes precedence over the inherited maxAge/immutable.
		const index = await getPath('/');
		strictEqual(index.headers.get('cache-control'), 'public, max-age=0, stale-while-revalidate=60');
	});
});
