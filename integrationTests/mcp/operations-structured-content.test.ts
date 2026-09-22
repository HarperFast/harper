/**
 * MCP operations profile — `structuredContent` must be a JSON object (#2746).
 *
 * MCP types `structuredContent` as a record. The reference client validates it
 * with `z.record(z.string(), z.unknown())` inside `Client.callTool`, so a tool
 * that answers with a bare array fails the ENTIRE call:
 *
 *   $ZodError: [ { "expected": "record", "code": "invalid_type",
 *       "path": [ "structuredContent" ],
 *       "message": "Invalid input: expected record, received array" } ]
 *
 * ...raised in the SDK's `shared/protocol.js` before the result is ever handed
 * back. Harper operations return arrays routinely — `sql` for a SELECT,
 * `search_by_value`, `list_roles`, `list_users`, `get_job` — and those were
 * being placed in `structuredContent` verbatim, so every one of them was
 * uncallable from a spec-compliant host.
 *
 * This suite deliberately drives the real `@modelcontextprotocol/sdk` client
 * rather than crafting raw JSON-RPC: a raw POST happily accepts the malformed
 * frame, which is exactly why the bug survived the existing coverage. The
 * assertions below are "the call resolves at all" first and shape second.
 *
 * MCP mounted via the config object (not .env): HARPER_SET_CONFIG's
 * flattenObject drops empty profile objects, so a non-empty mountPath is needed.
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual, strictEqual } from 'node:assert';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DATABASE = 'data';
const TABLE = 'mcp_struct_dog';
const ROWS = [
	{ id: '1', name: 'Harper', age: 5 },
	{ id: '2', name: 'Penny', age: 7 },
];

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

async function opsAsAdmin(ctx: ContextWithHarper, body: object): Promise<any> {
	const res = await fetch(new URL('', ctx.harper.operationsAPIURL), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

interface SdkToolResult {
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
}

function textFrame(result: SdkToolResult): string {
	return (result.content ?? []).map((c) => c.text ?? '').join('');
}

/**
 * Asserts the framing contract for a payload the operation returns as an array:
 * the call survives the SDK's own validation, `structuredContent` is a record
 * wrapping the rows under `results`, and the text frame still carries the array
 * verbatim so nothing is lost for clients that read `content`.
 */
function assertArrayFraming(result: SdkToolResult, label: string): unknown[] {
	strictEqual(result.isError, undefined, `${label} should not be an error result: ${textFrame(result)}`);
	const structured = result.structuredContent as Record<string, unknown> | undefined;
	ok(structured && typeof structured === 'object', `${label}: structuredContent present`);
	ok(!Array.isArray(structured), `${label}: structuredContent must be a record, not an array`);
	ok(Array.isArray(structured.results), `${label}: rows travel under 'results'`);
	const fromText = JSON.parse(textFrame(result));
	ok(Array.isArray(fromText), `${label}: text frame keeps the raw array`);
	deepStrictEqual(structured.results, fromText, `${label}: wrapper wraps exactly the text-frame payload`);
	return structured.results as unknown[];
}

suite('MCP operations profile — structuredContent is a spec-legal record (#2746)', (ctx: ContextWithHarper) => {
	let client: Client;
	let transport: StreamableHTTPClientTransport;

	before(async () => {
		await startHarper(ctx, {
			config: {
				mcp: {
					operations: {
						mountPath: '/mcp',
						// An explicit allow list REPLACES the default, so the default-allow
						// array operations exercised below are listed alongside `sql`.
						allow: ['sql', 'search_by_value', 'list_roles', 'describe_all'],
					},
				},
			},
			env: {},
		});

		await opsAsAdmin(ctx, {
			operation: 'create_table',
			database: DATABASE,
			table: TABLE,
			primary_key: 'id',
		});
		await opsAsAdmin(ctx, { operation: 'insert', database: DATABASE, table: TABLE, records: ROWS });

		transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.operationsAPIURL), {
			requestInit: { headers: { Authorization: authHeader(ctx) } },
		});
		client = new Client({ name: 'mcp-structured-content', version: '1.0.0' }, { capabilities: {} });
		await client.connect(transport);
	});

	after(async () => {
		await transport?.close();
		await teardownHarper(ctx);
	});

	test('sql SELECT returns rows without tripping the SDK client result validation', async () => {
		// Before the fix this threw $ZodError("expected record, received array")
		// inside callTool — the rows never reached this line.
		const result = (await client.callTool({
			name: 'sql',
			arguments: { sql: `SELECT id, name FROM ${DATABASE}.${TABLE} ORDER BY id` },
		})) as SdkToolResult;

		const rows = assertArrayFraming(result, 'sql');
		strictEqual(rows.length, ROWS.length, `expected ${ROWS.length} rows, got ${JSON.stringify(rows)}`);
		deepStrictEqual(
			rows.map((r) => (r as { name?: string }).name).sort(),
			['Harper', 'Penny'],
			'the wrapped rows are the real SELECT result'
		);
	});

	test('search_by_value returns records without tripping the SDK client result validation', async () => {
		const result = (await client.callTool({
			name: 'search_by_value',
			arguments: {
				database: DATABASE,
				table: TABLE,
				search_attribute: 'name',
				search_value: 'Harper',
				get_attributes: ['*'],
			},
		})) as SdkToolResult;

		const rows = assertArrayFraming(result, 'search_by_value');
		strictEqual(rows.length, 1);
	});

	test('list_roles — an array operation on the DEFAULT allow surface — is callable', async () => {
		// Not only opted-in operations were affected: `list_*` is default-allowed
		// and array-shaped, so a clean Harper boot was already serving broken frames.
		const result = (await client.callTool({ name: 'list_roles', arguments: {} })) as SdkToolResult;
		const roles = assertArrayFraming(result, 'list_roles');
		ok(roles.length > 0, 'a booted Harper always has at least the super_user role');
	});

	test('an object-returning operation keeps its payload unwrapped', async () => {
		// The wrapper is for arrays only — describe_all is keyed by database name
		// and must not gain a `results` level.
		const result = (await client.callTool({ name: 'describe_all', arguments: {} })) as SdkToolResult;
		strictEqual(result.isError, undefined, textFrame(result));
		const structured = result.structuredContent as Record<string, unknown> | undefined;
		ok(structured && typeof structured === 'object', 'structuredContent present');
		ok(!Array.isArray(structured), 'structuredContent is a record');
		ok(DATABASE in structured, `describe_all keeps its database tree at the top level: ${Object.keys(structured)}`);
		deepStrictEqual(structured, JSON.parse(textFrame(result)), 'object payloads pass through untouched');
	});
});
