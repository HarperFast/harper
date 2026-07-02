/**
 * #1513 — config-shaping env vars delivered via a component's loadEnv (.env) must be applied
 * before the root config is composed. The fixture component delivers
 * `HARPER_CONFIG={"mcp":{"application":{"mountPath":"/mcp"}}}` ONLY through its .env file
 * (the test passes no mcp config and no HARPER_CONFIG process env var), so /mcp mounting
 * proves the pre-config env pass picked it up. Before the fix this 404'd: the config was
 * composed and memoized before loadEnv ran.
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

suite('loadEnv-delivered HARPER_CONFIG shapes the composed config (#1513)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('mcp.application delivered only via the component .env mounts /mcp', async () => {
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
		strictEqual(res.status, 200, `expected /mcp mounted via .env-delivered HARPER_CONFIG: ${res.status} ${text}`);
	});
});
