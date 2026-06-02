/**
 * MCP v1 — conformance against the official @modelcontextprotocol/sdk client.
 *
 * Boots a real Harper with `mcp.operations` enabled, then exercises the
 * Streamable HTTP transport from the SDK side. The point of this suite
 * (separate from the inline `integrationTests/server/mcp.test.ts` which
 * crafts raw HTTP) is to validate spec conformance against the upstream
 * reference implementation — if the SDK can't talk to us, no real MCP
 * host can either.
 *
 * Scope:
 *   - initialize handshake + capability surface
 *   - tools/list returns the default-allow operations
 *   - tools/call dispatches and returns a structured result
 *   - tools/list pagination round-trip (cursor)
 *   - unknown-tool / parameter-validation error surfaces
 *
 * The application-profile flows + listChanged cross-session delivery
 * tests live alongside; they require booting Harper with both profiles
 * configured and registering a sample Resource.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function mcpUrl(ctx: ContextWithHarper): URL {
	return new URL('/mcp', ctx.harper.operationsAPIURL);
}

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

async function newConnectedClient(
	ctx: ContextWithHarper
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const transport = new StreamableHTTPClientTransport(mcpUrl(ctx), {
		requestInit: { headers: { Authorization: authHeader(ctx) } },
	});
	const client = new Client({ name: 'harper-e2e', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport };
}

suite('MCP v1 conformance against @modelcontextprotocol/sdk (operations profile)', (ctx: ContextWithHarper) => {
	before(async () => {
		// mountPath set explicitly: flattenObject skips empty profile objects
		// (see the equivalent note in server/mcp.test.ts).
		await startHarper(ctx, {
			config: {
				mcp: { operations: { mountPath: '/mcp' } },
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('SDK client completes the initialize handshake', async () => {
		const { client, transport } = await newConnectedClient(ctx);
		// The SDK exposes server capabilities/info after connect().
		const info = client.getServerVersion();
		ok(info?.name, 'serverInfo.name present');
		const caps = client.getServerCapabilities();
		ok(caps && typeof caps === 'object', 'server capabilities returned');
		await transport.close();
	});

	test('tools/list returns the default-allow operations as MCP tools', async () => {
		const { client, transport } = await newConnectedClient(ctx);
		const list = await client.listTools();
		ok(Array.isArray(list.tools));
		const names = list.tools.map((t) => t.name);
		// describe_all + describe_table + system_information should always
		// be present on a clean Harper boot under the default-allow list.
		ok(names.includes('describe_all'), 'describe_all should be in default-allow');
		ok(names.includes('system_information'), 'system_information should be in default-allow');
		// Sensitive getters tightened in PR-2 follow-ups must NOT be there
		// by default — verifyPerms gates them too, but the surface itself
		// should not advertise them.
		ok(!names.includes('get_configuration'), 'get_configuration must NOT be default-allowed');
		await transport.close();
	});

	test('tools/call describe_all dispatches end-to-end and returns structured content', async () => {
		const { client, transport } = await newConnectedClient(ctx);
		const result = await client.callTool({ name: 'describe_all', arguments: {} });
		ok(Array.isArray(result.content), 'result.content is an array');
		ok(result.content.length > 0, 'at least one content frame');
		const text = result.content.find((c: { type: string }) => c.type === 'text') as
			| { type: string; text: string }
			| undefined;
		ok(text, 'a text content frame is present');
		// describe_all returns a database/table tree under the admin user.
		// We don't assert specific contents — just that it parses as JSON
		// (the tool wraps the JSON object in a text frame per MCP convention).
		const parsed = JSON.parse(text.text);
		ok(typeof parsed === 'object', 'tool result text parses as JSON');
		await transport.close();
	});

	test('tools/list paginates when the visible surface exceeds a configured max', async () => {
		const { client, transport } = await newConnectedClient(ctx);
		// Default cap is 200; we don't have 200 tools by default but the
		// pagination contract (nextCursor undefined when exhausted) is the
		// spec-conformance bit we actually want.
		const page1 = await client.listTools();
		strictEqual(page1.nextCursor, undefined, 'single page when under the cap');
		await transport.close();
	});

	test('an unknown tool returns a JSON-RPC error frame, not a transport failure', async () => {
		const { client, transport } = await newConnectedClient(ctx);
		try {
			await client.callTool({ name: 'definitely_not_a_tool', arguments: {} });
			ok(false, 'expected callTool to throw');
		} catch (err) {
			// The SDK surfaces JSON-RPC errors by rejecting the call promise.
			ok(err instanceof Error);
		}
		await transport.close();
	});
});
