/**
 * MCP application profile — a generated verb must honor the `outputSchema` it advertised.
 *
 * The SDK client caches that schema from `tools/list` and validates every later result
 * against it, so `{ results: [...] }` — legal as a bare CallToolResult — still fails with
 * InvalidParams (-32602). Driving `listTools()` before `callTool()` is load-bearing: it is
 * the only order in which that validator exists.
 *
 * MCP mounted via the config object (not .env): HARPER_SET_CONFIG's flattenObject drops
 * empty profile objects, so a non-empty mountPath is needed.
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

			// The load-bearing step: this is what builds the SDK's per-tool output validator.
			const list = await client.listTools();
			advertisedGetSchema = list.tools.find((t) => t.name === 'get_Listing')?.outputSchema;
		});

		after(async () => {
			await transport?.close();
			await teardownHarper(ctx);
		});

		test('get_Listing advertises an object outputSchema requiring the primary key', async () => {
			// The premise of the whole suite — if this stops holding, the assertions below
			// are vacuous rather than failing.
			const schema = advertisedGetSchema as
				{ type?: string; required?: string[]; additionalProperties?: boolean } | undefined;
			ok(schema, 'get_Listing advertises an outputSchema');
			strictEqual(schema.type, 'object', 'MCP requires outputSchema to describe an object');
			ok(schema.required?.includes('id'), `the derived schema requires the primary key: ${JSON.stringify(schema)}`);
			strictEqual(schema.additionalProperties, false, 'and forbids extra properties');
		});

		test('an array from get_ comes back as a clean contract error, not a -32602 throw', async () => {
			// Before the review fix this rejected inside callTool with
			// "Structured content does not match the tool's output schema" — the caller got an
			// exception rather than a result, on a client that had merely listed the tools first.
			const result = (await client.callTool({ name: 'get_Listing', arguments: { id: 'a' } })) as SdkToolResult;

			strictEqual(result.isError, true, 'the mismatch is reported as a tool error');
			strictEqual(result.structuredContent, undefined, 'no structuredContent that violates the advertised schema');
			const payload = JSON.parse(textFrame(result));
			strictEqual(payload.kind, 'harper_error');
			strictEqual(payload.tool, 'get_Listing');
			match(payload.message, /outputSchema/, 'the message names the real problem');
			match(payload.message, /static outputSchemas\.get/, 'and the remedy the author should apply');
		});

		test('the same client can still call a conforming verb afterwards', async () => {
			// The error is per-call, not a poisoned session: search_ advertises no outputSchema
			// and keeps its `{ rows }` envelope, and the validator cached above does not touch it.
			const result = (await client.callTool({ name: 'search_Listing', arguments: {} })) as SdkToolResult;
			strictEqual(result.isError, undefined, textFrame(result));
			const structured = result.structuredContent as { rows?: unknown[] } | undefined;
			ok(structured && Array.isArray(structured.rows), `search_ keeps its rows envelope: ${textFrame(result)}`);
		});
	}
);
