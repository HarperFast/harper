/**
 * MCP application profile — row-level RBAC enforcement (#1487).
 *
 * Regression coverage for two authorization bypasses on the MCP CRUD verb tools:
 *
 *   - WRITE fail-open: a low-privilege user calling create_/update_/delete_<T>
 *     succeeded and the mutation persisted even though the Resource's
 *     allowCreate/allowUpdate/allowDelete row-level guard denied it.
 *   - READ row-level bypass: get_/search_<T> returned rows the Resource's
 *     allowRead guard should hide.
 *
 * Root cause (both): the verb-tool handlers dispatched on a Resource class
 * captured at tool-registration time, which was the base generated table class
 * (table-level RBAC only) rather than the component's exported subclass that
 * carries the per-record allow* overrides. The handlers now resolve the live
 * registry class at call time, matching what REST resolves.
 *
 * The fixture's `Doc` subclass restricts every verb to `owner === username`
 * (super users pass). A `qa_writer` role grants table-level CRUD so the only
 * thing standing between `lowuser` and another user's row is the per-record
 * guard — exactly what must hold.
 *
 * MCP mounted via the config object (not .env): HARPER_SET_CONFIG's
 * flattenObject drops empty profile objects, so a non-empty mountPath is needed.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-row-authz');

const LOWUSER = { username: 'mcp_authz_lowuser', password: 'LowPw-1487!' };
const ROLE = 'mcp_authz_writer';

const ADMIN_ROW = 'admin-row';
const LOWUSER_ROW = 'lowuser-row';

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

interface ToolResult {
	isError?: boolean;
	content?: Array<{ type: string; text: string }>;
}

/** Open an MCP application-profile client authenticated as the given user. */
async function appClient(
	ctx: ContextWithHarper,
	username: string,
	password: string
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.httpURL), {
		requestInit: { headers: { Authorization: basicAuth(username, password) } },
	});
	const client = new Client({ name: 'mcp-row-authz', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
	return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function resultText(result: ToolResult): string {
	return result.content?.map((c) => c.text ?? '').join('') ?? '';
}

/** Operations-API call as admin (super user) — the persistence oracle. */
async function opsAsAdmin(ctx: ContextWithHarper, body: object): Promise<any> {
	const res = await fetch(new URL('', ctx.harper.operationsAPIURL), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': basicAuth(ctx.harper.admin.username, ctx.harper.admin.password),
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Read a Doc row via the operations API (super user bypasses row-level guards). */
async function readDoc(ctx: ContextWithHarper, id: string): Promise<any | null> {
	const rows = await opsAsAdmin(ctx, {
		operation: 'search_by_value',
		schema: 'data',
		table: 'Doc',
		search_attribute: 'id',
		search_value: id,
		get_attributes: ['*'],
	});
	return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

suite('MCP application profile row-level RBAC (#1487)', (ctx: ContextWithHarper) => {
	let admin: { client: Client; transport: StreamableHTTPClientTransport };
	let low: { client: Client; transport: StreamableHTTPClientTransport };

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' } } },
			env: {},
		});

		// Grant table-level CRUD so the only barrier is the per-record allow* guard.
		await opsAsAdmin(ctx, {
			operation: 'add_role',
			role: ROLE,
			permission: {
				super_user: false,
				data: {
					tables: {
						Doc: { read: true, insert: true, update: true, delete: true, attribute_permissions: [] },
					},
				},
			},
		});
		await opsAsAdmin(ctx, {
			operation: 'add_user',
			role: ROLE,
			username: LOWUSER.username,
			password: LOWUSER.password,
			active: true,
		});

		await opsAsAdmin(ctx, {
			operation: 'insert',
			schema: 'data',
			table: 'Doc',
			records: [
				{ id: ADMIN_ROW, owner: ctx.harper.admin.username, payload: 'admin-original' },
				{ id: LOWUSER_ROW, owner: LOWUSER.username, payload: 'lowuser-original' },
			],
		});

		admin = await appClient(ctx, ctx.harper.admin.username, ctx.harper.admin.password);
		low = await appClient(ctx, LOWUSER.username, LOWUSER.password);
	});

	after(async () => {
		await admin?.transport.close();
		await low?.transport.close();
		await teardownHarper(ctx);
	});

	// ── WRITE: positive control — super user writes work and persist ──────────
	test('admin create/update/delete persist (write wiring works)', async () => {
		const id = 'admin-ctrl-row';
		const created = await callTool(admin.client, 'create_Doc', {
			id,
			owner: ctx.harper.admin.username,
			payload: 'ctrl',
		});
		ok(!created.isError, `admin create_Doc errored: ${resultText(created)}`);
		ok(await readDoc(ctx, id), 'admin create_Doc did not persist');

		const updated = await callTool(admin.client, 'update_Doc', {
			id,
			owner: ctx.harper.admin.username,
			payload: 'ctrl-updated',
		});
		ok(!updated.isError, `admin update_Doc errored: ${resultText(updated)}`);
		strictEqual((await readDoc(ctx, id))?.payload, 'ctrl-updated', 'admin update_Doc did not persist');

		const deleted = await callTool(admin.client, 'delete_Doc', { id });
		ok(!deleted.isError, `admin delete_Doc errored: ${resultText(deleted)}`);
		strictEqual(await readDoc(ctx, id), null, 'admin delete_Doc did not persist');
	});

	// ── WRITE: low-priv user is denied and nothing persists ───────────────────
	test('lowuser update_Doc on admin row is denied and does not persist', async () => {
		const result = await callTool(low.client, 'update_Doc', {
			id: ADMIN_ROW,
			owner: ctx.harper.admin.username,
			payload: 'LOWUSER-OVERWRITE',
		});
		ok(result.isError, 'lowuser update_Doc on admin row should return an MCP error');
		strictEqual((await readDoc(ctx, ADMIN_ROW))?.payload, 'admin-original', 'denied update must not persist');
	});

	test('lowuser delete_Doc on admin row is denied and does not persist', async () => {
		const result = await callTool(low.client, 'delete_Doc', { id: ADMIN_ROW });
		ok(result.isError, 'lowuser delete_Doc on admin row should return an MCP error');
		ok(await readDoc(ctx, ADMIN_ROW), 'denied delete must not remove the row');
	});

	test('lowuser create_Doc for a row owned by admin is denied and does not persist', async () => {
		const id = 'lowuser-creates-for-admin';
		const result = await callTool(low.client, 'create_Doc', {
			id,
			owner: ctx.harper.admin.username,
			payload: 'LOWUSER-CREATE-FOR-ADMIN',
		});
		ok(result.isError, 'lowuser create_Doc owned-by-admin should return an MCP error');
		strictEqual(await readDoc(ctx, id), null, 'denied create must not insert a row');
	});

	// ── WRITE: low-priv user CAN write rows it owns (guards are selective) ─────
	test('lowuser update_Doc on its own row succeeds and persists', async () => {
		const result = await callTool(low.client, 'update_Doc', {
			id: LOWUSER_ROW,
			owner: LOWUSER.username,
			payload: 'lowuser-self-update',
		});
		ok(!result.isError, `lowuser update of own row should succeed: ${resultText(result)}`);
		strictEqual((await readDoc(ctx, LOWUSER_ROW))?.payload, 'lowuser-self-update', 'own-row update must persist');
	});

	// ── READ: positive control — low-priv user reads its own row ──────────────
	test('lowuser get_Doc on its own row returns the row', async () => {
		const result = await callTool(low.client, 'get_Doc', { id: LOWUSER_ROW });
		ok(!result.isError, `lowuser get of own row should succeed: ${resultText(result)}`);
		ok(resultText(result).includes('lowuser'), 'own row should be returned');
	});

	// ── READ: low-priv user cannot read or scan rows it does not own ──────────
	test('lowuser get_Doc on admin row leaks nothing', async () => {
		const result = await callTool(low.client, 'get_Doc', { id: ADMIN_ROW });
		ok(!resultText(result).includes('admin-original'), 'get_Doc must not leak a denied row');
	});

	test('lowuser search_Doc does not leak rows it does not own', async () => {
		const result = await callTool(low.client, 'search_Doc', {});
		ok(!resultText(result).includes('admin-original'), 'search_Doc must not leak a denied row');
	});
});
