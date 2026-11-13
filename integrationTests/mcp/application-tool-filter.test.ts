/**
 * MCP application profile — `mcp.application.allow`/`deny` and `generatedTools` (#4345), read from
 * the root config of a booted server rather than injected into the registry: the config keys must
 * reach the tool rebuild under the names the validator accepts.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, rejects } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/custom-resources');

async function newAppClient(
	ctx: ContextWithHarper
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const basic = Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.httpURL), {
		requestInit: { headers: { Authorization: `Basic ${basic}` } },
	});
	const client = new Client({ name: 'harper-tool-filter-e2e', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport };
}

async function listedNames(client: Client): Promise<string[]> {
	const { tools } = await client.listTools();
	return tools.map((tool) => tool.name).sort();
}

suite('MCP application profile: generatedTools: false (#4345)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp', generatedTools: false } } },
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('lists only the custom tools and refuses a generated verb tool', async () => {
		const { client, transport } = await newAppClient(ctx);
		deepStrictEqual(await listedNames(client), ['wi_progress']);
		await rejects(client.callTool({ name: 'create_WorkItem', arguments: { state: 'open' } }), /Unknown tool/);
		await transport.close();
	});
});

suite('MCP application profile: allow and deny (#4345)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				mcp: {
					application: {
						mountPath: '/mcp',
						allow: ['*_WorkItem', 'wi_progress'],
						deny: ['delete_*', 'update_WorkItem'],
					},
				},
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('lists exactly the tools allow admits and deny does not remove', async () => {
		const { client, transport } = await newAppClient(ctx);
		deepStrictEqual(await listedNames(client), ['create_WorkItem', 'get_WorkItem', 'search_WorkItem', 'wi_progress']);
		await transport.close();
	});

	test('refuses a denied tool and one outside the allow list', async () => {
		const { client, transport } = await newAppClient(ctx);
		await rejects(client.callTool({ name: 'delete_WorkItem', arguments: { id: 'x' } }), /Unknown tool/);
		await rejects(client.callTool({ name: 'get_RedirectRule', arguments: { id: 'x' } }), /Unknown tool/);
		await transport.close();
	});
});
