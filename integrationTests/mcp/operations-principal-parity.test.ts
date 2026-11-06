/**
 * MCP operations-profile tools answer like the operations HTTP API for the same principal and body, over the
 * official SDK client. `operations-iterable-results.test.ts` pins result collection (#3754) and attribute denial
 * for the super user and a role with an operations allowlist; this file covers what it does not: a role with table
 * permissions and no allowlist is refused a full-text search over a source it cannot read, gets a `fields`-narrowed
 * full-text search without its read:false attribute (collected, not a serialization error), and is refused
 * `read_audit_log` on both surfaces; an all-sources role proves the narrowing is not over-redaction; `get_status`
 * returns the same keys on both surfaces.
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
	config: { threads: { count: 2 }, mcp: { operations: { mountPath: '/mcp' } } },
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const PASSWORD = 'McpParity-4418!';
const READER = 'mcp_parity_reader';
const ALL = 'mcp_parity_all';
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
function byId(records: any[]): any[] {
	return [...records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
function hasDenied(records: any[]): string[] {
	return records.filter((record) => Object.hasOwn(record, DENIED)).map(({ id }) => id);
}
function searchArgs(conditions: unknown[], get_attributes: unknown = ['*']) {
	return { database: 'data', table: 'Product', get_attributes, conditions };
}

suite('MCP operations tools answer like the operations HTTP API for the principal', (ctx: ContextWithHarper) => {
	let admin: string;
	let reader: string;
	let all: string;
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
		all = `Basic ${Buffer.from(`${ALL}:${PASSWORD}`).toString('base64')}`;
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

	test('M0c: a plain equals search as the reader with get_attributes * is delivered without the denied attribute', async () => {
		const args = searchArgs([{ attribute: 'category', comparator: 'equals', value: 'shoes' }]);
		const http = await expectOp({ operation: 'search_by_conditions', ...args }, reader, 200);
		assert.deepStrictEqual(ids(http.body), ['one', 'two']);
		assert.deepStrictEqual(hasDenied(http.body), [], `HTTP delivered ${DENIED}: ${http.text}`);
		const result = await mcpSearch('reader', args);
		assert.strictEqual(result.isError, false, `MCP equals search as the reader errored: ${result.text}`);
		assert.deepStrictEqual(byId(result.rows), byId(http.body), `MCP rows differ from HTTP: ${result.text}`);
	});

	test('M1 reader: a denied full-text source and an explicit denied attribute are refused with a permission error', async () => {
		await expectOp({ operation: 'search_by_conditions', ...searchArgs([ft(SENTINEL)], ['id']) }, reader, 403);
		const denied = await mcpSearch('reader', searchArgs([ft(SENTINEL)], ['id']));
		assert.strictEqual(denied.isError, true, `denied-source search answered: ${denied.text}`);
		assert.match(denied.text, DENIAL, denied.text);
		const explicitArgs = searchArgs([ft('waterproof', { fields: ['title'] })], ['id', DENIED]);
		await expectOp({ operation: 'search_by_conditions', ...explicitArgs }, reader, 403);
		const explicit = await mcpSearch('reader', explicitArgs);
		assert.strictEqual(explicit.isError, true, `explicit denied attribute answered: ${explicit.text}`);
		assert.match(explicit.text, DENIAL, explicit.text);
	});

	test('M2 reader: a full-text search narrowed to a readable field is collected and delivered without the denied attribute', async () => {
		const args = searchArgs([ft('waterproof', { fields: ['title'] })]);
		const http = await expectOp({ operation: 'search_by_conditions', ...args }, reader, 200);
		assert.deepStrictEqual(ids(http.body), ['one', 'two']);
		assert.deepStrictEqual(hasDenied(http.body), [], `HTTP delivered ${DENIED}: ${http.text}`);
		const narrowed = await mcpSearch('reader', args);
		assert.strictEqual(narrowed.isError, false, narrowed.text);
		assert.deepStrictEqual(byId(narrowed.rows), byId(http.body), `MCP rows differ from HTTP: ${narrowed.text}`);
	});

	test('M3 positive control: the all-sources role gets the sentinel rows WITH the attribute on both surfaces', async () => {
		const http = await expectOp({ operation: 'search_by_conditions', ...searchArgs([ft(SENTINEL)]) }, all, 200);
		assert.deepStrictEqual(hasDenied(http.body).sort(), ['hidden-desc', 'private']);
		const result = await mcpSearch('all', searchArgs([ft(SENTINEL)]));
		assert.strictEqual(result.isError, false, result.text);
		assert.deepStrictEqual(ids(result.rows), ['hidden-desc', 'private']);
		assert.deepStrictEqual(hasDenied(result.rows).sort(), ['hidden-desc', 'private']);
	});

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

	test('A4 get_status with no id: the MCP tool returns the same keys HTTP does', async () => {
		const http = await expectOp({ operation: 'get_status' }, admin, 200);
		const result = await mcp('admin', 'get_status', {});
		assert.strictEqual(result.isError, false, result.text);
		const keysOf = (v: any) => (Array.isArray(v) ? ['<array>'] : Object.keys(v ?? {}).sort());
		assert.ok(keysOf(http.body).length > 0, `HTTP get_status returned no keys: ${http.text}`);
		assert.deepStrictEqual(keysOf(result.parsed), keysOf(http.body), `MCP ${result.text} vs HTTP ${http.text}`);
	});
});
