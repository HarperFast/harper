/**
 * MCP application profile — a generated verb must honor the `outputSchema` it advertised.
 *
 * The SDK client caches that schema from `tools/list` and validates later results against it,
 * so `listTools()` before `callTool()` is load-bearing: it is the only order in which the
 * validator exists.
 *
 * MCP mounted via the config object: HARPER_SET_CONFIG's flattenObject drops empty profile
 * objects, so a non-empty mountPath is needed.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, match } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-array-result');

interface SdkToolResult {
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
}

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

function textFrame(result: SdkToolResult): string {
	return (result.content ?? []).map((c) => c.text ?? '').join('');
}

suite(
	'MCP application profile — generated verbs honor their advertised outputSchema (#2754)',
	(ctx: ContextWithHarper) => {
		let client: Client;
		let transport: StreamableHTTPClientTransport;
		let advertisedGetSchema: unknown;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { mcp: { application: { mountPath: '/mcp' } } },
				env: {},
			});

			transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.httpURL), {
				requestInit: { headers: { Authorization: authHeader(ctx) } },
			});
			client = new Client({ name: 'mcp-output-schema', version: '1.0.0' }, { capabilities: {} });
			await client.connect(transport);

			const list = await client.listTools();
			advertisedGetSchema = list.tools.find((t) => t.name === 'get_Listing')?.outputSchema;
		});

		after(async () => {
			await transport?.close();
			await teardownHarper(ctx);
		});

		test('get_Listing advertises an object outputSchema requiring the primary key', async () => {
			const schema = advertisedGetSchema as
				{ type?: string; required?: string[]; additionalProperties?: boolean } | undefined;
			ok(schema, 'get_Listing advertises an outputSchema');
			strictEqual(schema.type, 'object', 'MCP requires outputSchema to describe an object');
			ok(schema.required?.includes('id'), `the derived schema requires the primary key: ${JSON.stringify(schema)}`);
			strictEqual(schema.additionalProperties, false, 'and forbids extra properties');
		});

		test('an array from get_ comes back as a clean contract error, not a -32602 throw', async () => {
			const result = (await client.callTool({ name: 'get_Listing', arguments: { id: 'a' } })) as SdkToolResult;

			strictEqual(result.isError, true, 'the mismatch is reported as a tool error');
			strictEqual(result.structuredContent, undefined, 'no structuredContent that violates the advertised schema');
			const payload = JSON.parse(textFrame(result));
			strictEqual(payload.kind, 'harper_error');
			strictEqual(payload.tool, 'get_Listing');
			match(payload.message, /outputSchema/, 'the message names the real problem');
			match(payload.message, /static outputSchemas\.get/, 'and the remedy the author should apply');
		});

		test('a toJSON that yields an array is caught the same way, through the same sequence', async () => {
			// `Array.isArray` on the handler's value is false here; what reaches the wire is an
			// array all the same, so the advertised record schema is broken identically.
			const result = (await client.callTool({ name: 'get_Coded', arguments: { id: 'a' } })) as SdkToolResult;

			strictEqual(result.isError, true, `expected a contract error, got: ${textFrame(result)}`);
			strictEqual(result.structuredContent, undefined);
			const payload = JSON.parse(textFrame(result));
			strictEqual(payload.tool, 'get_Coded');
			match(payload.message, /static outputSchemas\.get/);
		});

		test('the same client can still call a conforming verb afterwards', async () => {
			const result = (await client.callTool({ name: 'search_Listing', arguments: {} })) as SdkToolResult;
			strictEqual(result.isError, undefined, textFrame(result));
			const structured = result.structuredContent as { rows?: unknown[] } | undefined;
			ok(structured && Array.isArray(structured.rows), `search_ keeps its rows envelope: ${textFrame(result)}`);
		});
	}
);
