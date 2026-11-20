/**
 * A sourcedFrom cache serves stale records over HTTP when allowStaleWhileRevalidate is defined on the
 * source class, both while the origin is slow and when it fails. https://github.com/HarperFast/harper/issues/1468
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

suite('sourcedFrom stale-while-revalidate hook on the source', (ctx: ContextWithHarper) => {
	let headers: Record<string, string>;

	async function request(path: string, method = 'GET', body?: unknown, timeout = 30_000) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});
		const text = await response.text();
		assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
		return text ? JSON.parse(text) : undefined;
	}
	const setOrigin = (state: { value?: string; mode?: string }) => request('/Origin/', 'POST', state);
	// a read that waited on the held origin would not answer within this
	const staleRead = () => request('/Quote/q', 'GET', undefined, 3_000);
	const expiry = () => delay(1_500);

	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'sourcedfrom-swr-on-source'), {
			config: { threads: { count: 1 } },
			harperBinPath: resolve('dist/bin/harper.js'),
		});
		headers = {
			'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			'Content-Type': 'application/json',
		};
	});

	after(async () => {
		await setOrigin({ mode: 'ok' }).catch(() => undefined);
		await teardownHarper(ctx);
	});

	test('serves the stale record while the origin is slow, then the refreshed one', async () => {
		assert.strictEqual((await request('/Quote/q')).value, 'v1');
		await expiry();
		await setOrigin({ value: 'v2', mode: 'hold' });
		assert.strictEqual((await staleRead()).value, 'v1');
		await setOrigin({ mode: 'ok' });
		await waitFor(async () => (await request('/Quote/q')).value === 'v2', {
			timeout: 10_000,
			message: 'the background refresh did not replace the stale record',
		});
	});

	test('serves the last good record when the origin fails', async () => {
		await expiry();
		await setOrigin({ value: 'v3', mode: 'fail' });
		assert.strictEqual((await staleRead()).value, 'v2');
		assert.strictEqual((await staleRead()).value, 'v2');
	});
});
