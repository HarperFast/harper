/**
 * #1513 — config-shaping env vars delivered via a component's loadEnv (.env) are NOT applied
 * (components must not shape instance-wide config); the failure mode being fixed is the
 * SILENCE. The fixture component delivers `HARPER_CONFIG={"mcp":{"application":{"mountPath":
 * "/mcp"}}}` ONLY through its .env file: /mcp staying unmounted proves the var was not
 * honored, and the boot log carries the actionable warning instead of nothing.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/load-env-config-shaping.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/load-env-config-shaping');

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('loadEnv-delivered HARPER_CONFIG warns and does not shape config (#1513)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('mcp.application delivered only via the component .env does NOT mount /mcp', async () => {
		const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json, text/event-stream',
				'authorization': basicAuth(ctx.harper.admin.username, ctx.harper.admin.password),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prepass-it', version: '0' } },
			}),
		});
		const text = await res.text();
		strictEqual(res.status, 404, `expected /mcp NOT mounted (.env config vars are not honored): ${res.status} ${text}`);
	});
});
