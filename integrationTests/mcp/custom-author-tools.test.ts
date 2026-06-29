/**
 * MCP application profile — component-author opt-ins (#1448).
 *
 * `static mcpTools` (#622) and `static mcpPrompts` (#1349 §3.5) declared on a
 * component-exported Resource that extends an exported `@table` must register
 * end-to-end on a *booted* server, not just in unit tests that inject the
 * resource registry directly.
 *
 * The regression: the MCP application scanner runs at component-load time and on
 * schema-change events, both of which fire before the component's JS resource
 * subclass (the object carrying the author statics) is registered by the
 * jsResource plugin. Without a rebuild after that registration the custom tools
 * never surface — `tools/list` shows only the auto-generated CRUD verbs and a
 * `tools/call` for the custom tool returns `-32601 Unknown tool`.
 *
 * Boots the `custom-resources` fixture, whose `WorkItem extends tables.WorkItem`
 * declares a `wi_progress` custom tool (method `mcpProgress`) and a `wi_triage`
 * prompt, and drives the application endpoint with the official MCP SDK client.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/custom-resources');

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

async function newAppClient(
	ctx: ContextWithHarper
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.httpURL), {
		requestInit: { headers: { Authorization: authHeader(ctx) } },
	});
	const client = new Client({ name: 'harper-custom-tools-e2e', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport };
}

suite('MCP application profile: component-author static mcpTools/mcpPrompts (#1448)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' } } },
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('tools/list exposes the author-declared custom tool alongside the CRUD verbs', async () => {
		const { client, transport } = await newAppClient(ctx);
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		ok(names.includes('wi_progress'), `expected the custom 'wi_progress' tool, got: ${names.join(', ')}`);
		// Sanity: the auto-generated CRUD verbs still register too (the rebuild is additive).
		ok(
			names.some((n) => /^create_WorkItem/.test(n)),
			`expected create_WorkItem to remain, got: ${names.join(', ')}`
		);
		await transport.close();
	});

	test('tools/call invokes the custom method and returns its structured result', async () => {
		const { client, transport } = await newAppClient(ctx);
		const result = await client.callTool({ name: 'wi_progress', arguments: { id: 'wi-1448' } });
		ok(!result.isError, `wi_progress should succeed: ${JSON.stringify(result)}`);
		const structured = result.structuredContent as { id?: string; state?: string; percent?: number } | undefined;
		strictEqual(structured?.id, 'wi-1448');
		strictEqual(structured?.state, 'in_progress');
		await transport.close();
	});

	test('auto-generated CRUD tools honor the component subclass override (#1448 alignment)', async () => {
		// The rebuild binds the verb tools to the exported WorkItem subclass — the same object
		// REST routes to — so create_WorkItem now invokes its post() override (state:'pending'),
		// rather than the base table class's default insert it used before the registry settled.
		const { client, transport } = await newAppClient(ctx);
		const created = await client.callTool({ name: 'create_WorkItem', arguments: { state: 'open', payload: 'x' } });
		ok(!created.isError, `create_WorkItem should succeed: ${JSON.stringify(created)}`);
		strictEqual((created.structuredContent as { state?: string } | undefined)?.state, 'pending');
		await transport.close();
	});

	test('prompts/list and prompts/get expose the author-declared prompt', async () => {
		const { client, transport } = await newAppClient(ctx);
		const { prompts } = await client.listPrompts();
		const names = prompts.map((p) => p.name);
		ok(names.includes('wi_triage'), `expected the custom 'wi_triage' prompt, got: ${names.join(', ')}`);

		const got = await client.getPrompt({ name: 'wi_triage', arguments: { id: 'wi-1448' } });
		const rendered = JSON.stringify(got.messages);
		ok(rendered.includes('wi-1448'), `prompt should render the supplied argument, got: ${rendered}`);
		await transport.close();
	});
});
