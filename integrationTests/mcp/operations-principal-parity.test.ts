/**
 * MCP operations-profile tools answer like the operations HTTP API for the same principal and body:
 * the data (iterable results are collected before serialization, #3754) and the permission decision
 * (full-text sources and read:false attributes, resources/FULL_TEXT.md; reference/mcp/tools-and-resources.md
 * "attribute_permissions is enforced when the tool runs").
 *
 * `operations-iterable-results.test.ts` (#3754's own anchor) pins the collect step for the super user.
 * This file adds the legs it does not drive: a non-super_user role on every arm (denial parity on
 * `read_audit_log`; a denied full-text SOURCE refused before serialization; a multi-field index with one
 * denied field narrowed by `fields`; an all-sources role as the over-redaction control), `get_status` key
 * parity, and the official SDK client as the transport. Red before #3754: M0b, M2, M3 (`Can not serialize
 * async iterables…`), A2, A2b (`{}`), A3 (`[{}]`).
 *
 * Promoted from qa-explorer SQA-101 / SQA-104 (SP-74, SP-77).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-operations-principal');
const OPTIONS = {
	config: {
		threads: { count: 2 },
		mcp: { operations: { mountPath: '/mcp' } },
		analytics: { aggregatePeriod: 1 },
	},
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const PASSWORD = 'McpParity-4418!';
const READER = 'mcp_parity_reader'; // table read, `description` read:false, no operations allowlist
const ALL = 'mcp_parity_all'; // every source readable — positive control
const SOURCES = ['id', 'title', 'description', 'tags', 'category', 'owner'];
const DENIED = 'description';
const SENTINEL = 'classified';
const DENIAL = /permission|not allowed|not authorized|access|403|super/i;

function ids(records: any[]): string[] {
	return records.map(({ id }) => id).sort();
}
function ft(value: string, extra: Record<string, unknown> = {}) {
	return {
		attribute: 'catalogSearch',
		comparator: 'matches',
		value,
		maxIndexLagMilliseconds: 0,
		waitForIndexMilliseconds: 30_000,
		...extra,
	};
}
function hasDenied(records: any[]): string[] {
	return records.filter((record) => Object.hasOwn(record, DENIED)).map(({ id }) => id);
}
function searchArgs(conditions: unknown[], get_attributes: unknown = ['*']) {
	return { database: 'data', table: 'Product', get_attributes, conditions };
}
const sortedIds = (rows: any[]) => rows.map((r: any) => r.id).sort((a: number, b: number) => a - b);

suite('MCP operations tools answer like the operations HTTP API for the principal', (ctx: ContextWithHarper) => {
	let admin: string;
	let reader: string;
	const clients: Record<string, { client: Client; transport: StreamableHTTPClientTransport }> = {};

	async function op(body: Record<string, unknown>, auth = admin) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		let parsed: any = text;
		try {
			parsed = JSON.parse(text);
		} catch {}
		return { status: response.status, text, body: parsed };
	}
	async function expectOp(body: Record<string, unknown>, auth: string, status: number) {
		const result = await op(body, auth);
		assert.strictEqual(result.status, status, `${body.operation}: HTTP ${result.status} ${result.text}`);
		return result;
	}
	async function addRole(role: string, readable: (attribute: string) => boolean) {
		await expectOp(
			{
				operation: 'add_role',
				role,
				permission: {
					super_user: false,
					data: {
						tables: {
							Product: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: SOURCES.map((attribute_name) => ({
									attribute_name,
									read: readable(attribute_name),
									insert: false,
									update: false,
								})),
							},
						},
					},
				},
			},
			admin,
			200
		);
		await expectOp({ operation: 'add_user', username: role, password: PASSWORD, role, active: true }, admin, 200);
	}
	async function connectMcp(name: string, user: string, password: string) {
		const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.operationsAPIURL), {
			requestInit: { headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } },
		});
		const client = new Client({ name: 'mcp-parity', version: '1.0.0' }, { capabilities: {} });
		await client.connect(transport);
		clients[name] = { client, transport };
	}
	async function mcp(who: string, name: string, args: Record<string, unknown>) {
		const result: any = await clients[who].client.callTool({ name, arguments: args });
		const text = (result.content ?? []).map((c: any) => c.text ?? '').join('');
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		const rows = Array.isArray(parsed) ? parsed : result.structuredContent?.results;
		return { isError: Boolean(result.isError), text, parsed, rows };
	}
	const mcpSearch = (who: string, args: Record<string, unknown>) => mcp(who, 'search_by_conditions', args);

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		admin = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		reader = `Basic ${Buffer.from(`${READER}:${PASSWORD}`).toString('base64')}`;
		await expectOp(
			{
				operation: 'insert',
				schema: 'data',
				table: 'Product',
				records: [
					{
						id: 'one',
						title: 'Waterproof Trail Running Shoes',
						description: 'public note',
						category: 'shoes',
						owner: READER,
					},
					{ id: 'two', title: 'Waterproof Road Shoes', description: 'road note', category: 'shoes', owner: READER },
					{ id: 'three', title: 'Wireless Headphones', tags: ['electronics'], category: 'audio', owner: READER },
					{ id: 'nullcat', title: 'Uncategorized', description: 'no category', owner: READER },
					{
						id: 'hidden-desc',
						title: 'Garden',
						description: `${SENTINEL} sentinel`,
						category: 'garden',
						owner: READER,
					},
					{
						id: 'private',
						title: 'Private nebula',
						description: `${SENTINEL} waterproof`,
						category: 'garden',
						owner: 'another-user',
					},
				],
			},
			admin,
			200
		);
		await addRole(READER, (attribute) => attribute !== DENIED);
		await addRole(ALL, () => true);
		const deadline = Date.now() + 60_000;
		for (;;) {
			const description = await op({ operation: 'describe_table', schema: 'data', table: 'Product' });
			const state = description.body?.full_text_indexes?.[0]?.readiness?.state;
			if (state === 'ready') {
				const result = await op({ operation: 'search_by_conditions', ...searchArgs([ft(SENTINEL)], ['id']) });
				if (result.status === 200 && ids(result.body).join() === ['hidden-desc', 'private'].join()) break;
			}
			assert.ok(Date.now() < deadline, `index not ready / not converged: ${JSON.stringify(description.body)}`);
			await delay(100);
		}
		await connectMcp('admin', ctx.harper.admin.username, ctx.harper.admin.password);
		await connectMcp('reader', READER, PASSWORD);
		await connectMcp('all', ALL, PASSWORD);
	});

	after(async () => {
		for (const c of Object.values(clients)) await c.transport.close().catch(() => {});
		await teardownHarper(ctx);
	});

	// ---------- search_by_conditions: full-text sources and attribute permissions ----------

	test('M0 control: a plain equals search_by_conditions as super_user is answered over MCP as over HTTP', async () => {
		const equals = [{ attribute: 'category', comparator: 'equals', value: 'shoes' }];
		const http = await expectOp({ operation: 'search_by_conditions', ...searchArgs(equals, ['id']) }, admin, 200);
		assert.deepStrictEqual(ids(http.body), ['one', 'two']);
		const tools: any = await clients.admin.client.listTools();
		assert.ok(
			tools.tools.some((t: any) => t.name === 'search_by_conditions'),
			'tool listed for super_user'
		);
		const result = await mcpSearch('admin', searchArgs(equals, ['id']));
		assert.strictEqual(result.isError, false, `MCP search_by_conditions errored: ${result.text}`);
		assert.deepStrictEqual(ids(result.rows), ['one', 'two']);
	});

	test('M0b: the same full-text search as super_user is collected and delivered, not a serialization error', async () => {
		const http = await expectOp(
			{ operation: 'search_by_conditions', ...searchArgs([ft(SENTINEL)], ['id']) },
			admin,
			200
		);
		assert.deepStrictEqual(ids(http.body), ['hidden-desc', 'private']);
		const result = await mcpSearch('admin', searchArgs([ft(SENTINEL)], ['id']));
		assert.strictEqual(
			result.isError,
			false,
			`MCP full-text search_by_conditions as super_user errored: ${result.text}`
		);
		assert.deepStrictEqual(ids(result.rows), ['hidden-desc', 'private']);
	});

	test('M0c: a plain equals search as the reader with get_attributes * is delivered without the denied attribute', async () => {
		const result = await mcpSearch(
			'reader',
			searchArgs([{ attribute: 'category', comparator: 'equals', value: 'shoes' }])
		);
		assert.strictEqual(result.isError, false, `MCP equals search as the reader errored: ${result.text}`);
		assert.deepStrictEqual(ids(result.rows), ['one', 'two']);
		assert.deepStrictEqual(hasDenied(result.rows), [], `MCP delivered ${DENIED}: ${result.text}`);
	});

	test('M1 reader: a denied full-text source and an explicit denied attribute are refused with a permission error', async () => {
		const denied = await mcpSearch('reader', searchArgs([ft(SENTINEL)], ['id']));
		assert.strictEqual(denied.isError, true, `denied-source search answered: ${denied.text}`);
		assert.match(denied.text, DENIAL, denied.text);
		const explicit = await mcpSearch('reader', searchArgs([ft('waterproof', { fields: ['title'] })], ['id', DENIED]));
		assert.strictEqual(explicit.isError, true, `explicit denied attribute answered: ${explicit.text}`);
		assert.match(explicit.text, DENIAL, explicit.text);
	});

	test('M2 reader: a full-text search narrowed to a readable field is delivered without the denied attribute', async () => {
		const narrowed = await mcpSearch('reader', searchArgs([ft('waterproof', { fields: ['title'] })]));
		assert.strictEqual(narrowed.isError, false, narrowed.text);
		assert.deepStrictEqual(ids(narrowed.rows), ['one', 'two']);
		assert.deepStrictEqual(hasDenied(narrowed.rows), [], `MCP delivered ${DENIED}: ${narrowed.text}`);
	});

	test('M3 positive control: the all-sources role gets the sentinel rows WITH the attribute over MCP', async () => {
		const all = await mcpSearch('all', searchArgs([ft(SENTINEL)]));
		assert.strictEqual(all.isError, false, all.text);
		assert.deepStrictEqual(ids(all.rows), ['hidden-desc', 'private']);
		assert.deepStrictEqual(hasDenied(all.rows).sort(), ['hidden-desc', 'private']);
	});

	// ---------- read_audit_log / get_analytics / get_status: payload parity ----------

	test('A0 reader: read_audit_log is refused for a non-super_user role over MCP as over HTTP', async () => {
		const body = {
			operation: 'read_audit_log',
			schema: 'data',
			table: 'Product',
			search_type: 'hash_value',
			search_values: ['one'],
		};
		const http = await op(body, reader);
		assert.strictEqual(http.status, 403, `HTTP ${http.status} ${http.text}`);
		const { operation: _o, ...args } = body;
		const result = await mcp('reader', 'read_audit_log', args);
		assert.strictEqual(result.isError, true, `MCP answered the reader's read_audit_log: ${result.text}`);
		assert.match(result.text, DENIAL, result.text);
	});

	test('A1 control: read_audit_log search_type hash_value gives the MCP tool the same payload as HTTP', async () => {
		const body = {
			operation: 'read_audit_log',
			schema: 'data',
			table: 'Product',
			search_type: 'hash_value',
			search_values: ['one', 'two'],
		};
		const http = await expectOp(body, admin, 200);
		assert.ok(Array.isArray(http.body.one) && http.body.one.length >= 1, http.text);
		const { operation: _o, ...args } = body;
		const result = await mcp('admin', 'read_audit_log', args);
		assert.strictEqual(result.isError, false, result.text);
		assert.deepStrictEqual(Object.keys(result.parsed ?? {}).sort(), ['one', 'two'], result.text);
		assert.deepStrictEqual(
			result.parsed.one.map((e: any) => e.operation),
			http.body.one.map((e: any) => e.operation)
		);
	});

	test('A2 read_audit_log by timestamp (an async generator): the MCP tool delivers the entries HTTP streams', async () => {
		const body = {
			operation: 'read_audit_log',
			schema: 'data',
			table: 'Product',
			search_type: 'timestamp',
			search_values: [0, Date.now() + 60_000],
		};
		const http = await expectOp(body, admin, 200);
		assert.ok(Array.isArray(http.body) && http.body.length >= 1, `HTTP delivered no entries: ${http.text}`);
		const httpIds = http.body.flatMap((e: any) => e.ids).sort();
		assert.ok(httpIds.includes('one'), http.text);
		const { operation: _o, ...args } = body;
		const result = await mcp('admin', 'read_audit_log', args);
		assert.strictEqual(result.isError, false, result.text);
		assert.ok(Array.isArray(result.parsed), `MCP read_audit_log(timestamp) is not an array: ${result.text}`);
		assert.deepStrictEqual(result.parsed.flatMap((e: any) => e.ids).sort(), httpIds);
	});

	test('A2b read_audit_log with no search_type (the default branch): same payload over MCP as over HTTP', async () => {
		const body = { operation: 'read_audit_log', schema: 'data', table: 'Product' };
		const http = await op(body, admin);
		const { operation: _o, ...args } = body;
		const result = await mcp('admin', 'read_audit_log', args);
		if (http.status === 200) {
			assert.strictEqual(result.isError, false, result.text);
			assert.ok(Array.isArray(result.parsed), `MCP is not an array: ${result.text}`);
			assert.deepStrictEqual(
				result.parsed.flatMap((e: any) => e.ids).sort(),
				http.body.flatMap((e: any) => e.ids).sort()
			);
		} else {
			assert.strictEqual(result.isError, true, `HTTP ${http.status} but MCP answered: ${result.text}`);
		}
	});

	test('A3 get_analytics resource-usage over a bounded window (an async-mapped iterable): rows match HTTP', async () => {
		const deadline = Date.now() + 90_000;
		let rows: any[] = [];
		for (;;) {
			const http = await op({ operation: 'get_analytics', metric: 'resource-usage' }, admin);
			if (http.status === 200 && Array.isArray(http.body) && http.body.length >= 1) {
				rows = http.body;
				break;
			}
			assert.ok(
				Date.now() < deadline,
				`no resource-usage rows after 90 s: HTTP ${http.status} ${http.text.slice(0, 200)}`
			);
			await delay(500);
		}
		const times = rows.map((r) => r.id).sort((a, b) => a - b);
		// the stored key is [time, nodeId], so an `end_time` equal to the newest time excludes that row
		// (read.ts: `id between [start, end]`); pad the window by 1 ms on both ends (ids are ms floats)
		const body = {
			operation: 'get_analytics',
			metric: 'resource-usage',
			start_time: times[0] - 1,
			end_time: times[times.length - 1] + 1,
		};
		const http = await expectOp(body, admin, 200);
		assert.ok(http.body.length >= 1, http.text);
		for (const row of http.body) assert.strictEqual(row.metric, 'resource-usage', http.text.slice(0, 300));
		const { operation: _o, ...args } = body;
		const result = await mcp('admin', 'get_analytics', args);
		assert.strictEqual(result.isError, false, result.text);
		assert.ok(Array.isArray(result.parsed), `MCP get_analytics is not an array: ${result.text}`);
		assert.strictEqual(result.parsed.length, http.body.length, `row count: ${result.text.slice(0, 300)}`);
		for (const row of result.parsed)
			assert.strictEqual(row?.metric, 'resource-usage', `MCP row without metric: ${JSON.stringify(row)}`);
		assert.deepStrictEqual(sortedIds(result.parsed), sortedIds(http.body));
	});

	test('A4 get_status with no id: the MCP tool returns the same keys HTTP does', async () => {
		const http = await expectOp({ operation: 'get_status' }, admin, 200);
		const result = await mcp('admin', 'get_status', {});
		assert.strictEqual(result.isError, false, result.text);
		const keysOf = (v: any) => (Array.isArray(v) ? ['<array>'] : Object.keys(v ?? {}).sort());
		assert.deepStrictEqual(keysOf(result.parsed), keysOf(http.body), `MCP ${result.text} vs HTTP ${http.text}`);
	});
});
