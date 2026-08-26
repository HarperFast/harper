/**
 * Canary-only copy of the fetch-based static cache-header test from before harper#2029.
 *
 * Keep this outside integrationTests so the supported matrix continues using the bounded
 * node:http client. The Node 26 canary invokes it explicitly because global fetch is the
 * bundled-undici path whose regression keeps the default Node 26 matrix pinned at 26.5.0.
 */
import { after, before, suite, test, type TestContext } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../../integrationTests/apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../../integrationTests/fixtures/static-cache-headers');
const PROJECT = 'static-cache-headers';
const FETCH_STALL_THRESHOLD_MS = 2_000;
const FETCH_HARD_TIMEOUT_MS = 20_000;
const FETCH_DISCRIMINATOR = 'harper#2025 fetch discriminator:';

class FetchStallError extends Error {}

suite('Node 26 fetch canary: static plugin cache-header options', (context: ContextWithHarper) => {
	let client: any;
	let maxFetchDurationMs = 0;
	let defectReproduced = false;

	before(async () => {
		await setupHarperWithFixture(context, FIXTURE_PATH);
		client = createApiClient(context.harper);
	});

	after(async () => {
		await teardownHarper(context);
	});

	async function getPath(path: string): Promise<Response> {
		const startedAt = performance.now();
		let timeout: NodeJS.Timeout | undefined;
		const request = fetch(new URL(path, context.harper.httpURL)).then(async (response) => {
			if (response.status !== 200) {
				await response.body?.cancel();
				assert.strictEqual(response.status, 200);
			}
			await response.text();
			return response;
		});
		let response: Response;
		try {
			response = await Promise.race([
				request,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new FetchStallError(`${FETCH_DISCRIMINATOR} GET ${path} exceeded ${FETCH_HARD_TIMEOUT_MS}ms`)),
						FETCH_HARD_TIMEOUT_MS
					);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
		const durationMs = performance.now() - startedAt;
		maxFetchDurationMs = Math.max(maxFetchDurationMs, durationMs);
		if (durationMs >= FETCH_STALL_THRESHOLD_MS) {
			throw new FetchStallError(
				`${FETCH_DISCRIMINATOR} GET ${path} took ${Math.round(durationMs)}ms ` +
					`(threshold ${FETCH_STALL_THRESHOLD_MS}ms)`
			);
		}
		return response;
	}

	function canaryTest(name: string, body: () => Promise<void>): void {
		test(name, async (testContext: TestContext) => {
			if (defectReproduced) {
				testContext.skip('harper#2025 already reproduced');
				return;
			}
			try {
				await body();
			} catch (error) {
				if (!(error instanceof FetchStallError)) throw error;
				defectReproduced = true;
				console.error(error.message);
			}
		});
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

	canaryTest('default: public, max-age=0 with ETag/Last-Modified', async () => {
		const response = await getCss();
		assert.strictEqual(response.headers.get('cache-control'), 'public, max-age=0');
		assert.ok(response.headers.get('etag'), 'should emit an ETag');
		assert.ok(response.headers.get('last-modified'), 'should emit Last-Modified');
	});

	canaryTest('maxAge in seconds', async () => {
		await applyAndWaitForCacheControl("static:\n  files: 'web/**'\n  maxAge: 300\n", 'public, max-age=300');
	});

	canaryTest('maxAge as duration string + immutable', async () => {
		await applyAndWaitForCacheControl(
			"static:\n  files: 'web/**'\n  maxAge: 1d\n  immutable: true\n",
			'public, max-age=86400, immutable'
		);
	});

	canaryTest('cacheControl string overrides maxAge/immutable', async () => {
		await applyAndWaitForCacheControl(
			"static:\n  files: 'web/**'\n  maxAge: 300\n  cacheControl: 'public, max-age=60, s-maxage=3600'\n",
			'public, max-age=60, s-maxage=3600'
		);
	});

	canaryTest('cacheControl: false suppresses the header', async () => {
		await applyAndWaitForCacheControl("static:\n  files: 'web/**'\n  cacheControl: false\n", null);
	});

	canaryTest('cacheOverrides: per-file policy layered over the top-level defaults', async () => {
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
