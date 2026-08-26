/**
 * Canary-only copy of the fetch-based static cache-header test from before harper#2029.
 *
 * Keep this outside integrationTests so the supported matrix continues using the bounded
 * node:http client. The Node 26 canary invokes it explicitly because global fetch is the
 * bundled-undici path whose regression keeps the default Node 26 matrix pinned at 26.5.0.
 */
import { after, before, suite, test } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../../integrationTests/apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../../integrationTests/fixtures/static-cache-headers');
const PROJECT = 'static-cache-headers';
const FETCH_STALL_THRESHOLD_MS = 2_000;

suite('Node 26 fetch canary: static plugin cache-header options', (context: ContextWithHarper) => {
	let client: any;
	let maxFetchDurationMs = 0;

	before(async () => {
		await setupHarperWithFixture(context, FIXTURE_PATH);
		client = createApiClient(context.harper);
	});

	after(async () => {
		await teardownHarper(context);
	});

	async function getPath(path: string): Promise<Response> {
		const startedAt = performance.now();
		const response = await fetch(new URL(path, context.harper.httpURL));
		const durationMs = performance.now() - startedAt;
		maxFetchDurationMs = Math.max(maxFetchDurationMs, durationMs);
		if (durationMs >= FETCH_STALL_THRESHOLD_MS) {
			throw new Error(
				`harper#2025 fetch discriminator: GET ${path} took ${Math.round(durationMs)}ms ` +
					`(threshold ${FETCH_STALL_THRESHOLD_MS}ms)`
			);
		}
		assert.strictEqual(response.status, 200);
		await response.text();
		return response;
	}

	async function getCss(): Promise<Response> {
		return getPath('/test.css');
	}

	async function setStaticConfig(yaml: string): Promise<void> {
		await client.req().send({ operation: 'set_component_file', project: PROJECT, file: 'config.yaml', payload: yaml });
	}

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
			const response = await getCss();
			last = response.headers.get('cache-control');
			if (last === expected) return response;
			if (++sinceResend >= 10) {
				sinceResend = 0;
				await setStaticConfig(yaml);
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
		}
		throw new Error(
			`Cache-Control never became ${JSON.stringify(expected)}; last seen: ${JSON.stringify(last)}; ` +
				`slowest fetch: ${Math.round(maxFetchDurationMs)}ms`
		);
	}

	test('default: public, max-age=0 with ETag/Last-Modified', async () => {
		const response = await getCss();
		assert.strictEqual(response.headers.get('cache-control'), 'public, max-age=0');
		assert.ok(response.headers.get('etag'), 'should emit an ETag');
		assert.ok(response.headers.get('last-modified'), 'should emit Last-Modified');
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
		const yaml =
			'static:\n' +
			"  files: 'web/**'\n" +
			'  maxAge: 1y\n' +
			'  immutable: true\n' +
			'  cacheOverrides:\n' +
			"    'index.html': { cacheControl: 'public, max-age=0, stale-while-revalidate=60' }\n" +
			'    "*.css": { maxAge: 60 }\n';
		await applyAndWaitForCacheControl(yaml, 'public, max-age=60, immutable');
		const index = await getPath('/');
		assert.strictEqual(index.headers.get('cache-control'), 'public, max-age=0, stale-while-revalidate=60');
	});
});
