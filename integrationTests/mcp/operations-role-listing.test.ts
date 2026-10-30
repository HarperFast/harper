/**
 * MCP operations profile — `tools/list` filtering against real role records.
 *
 * Unit tests hand-build the user object; only this path builds `_expandedOperations` at role
 * cache-load time and resolves roles the way the server does. The schema DDL ops are opted in via
 * `mcp.operations.allow` because the default allow list is read-only — without that the negative
 * assertions would pass vacuously.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Reachable by a `structure_user` array grant (the array names the databases). */
const STRUCTURE_TABLE_OPS = ['create_table', 'drop_table', 'create_attribute', 'drop_attribute'];
/** Need `structure_user === true`; an array grant is denied at dispatch. */
const STRUCTURE_DATABASE_OPS = ['create_schema', 'create_database', 'drop_schema', 'drop_database'];
const STRUCTURE_OPS = [...STRUCTURE_DATABASE_OPS, ...STRUCTURE_TABLE_OPS];

/** Opted in so the DDL tools exist on the surface at all; an explicit allow replaces the default. */
const MCP_ALLOW = [
	...STRUCTURE_OPS,
	'sql',
	'describe_all',
	'search_by_value',
	'insert',
	'describe_schema',
	'describe_database',
	'search_by_hash',
	'search_by_id',
];

const PASSWORD = 'McpRoleListing-1!';

const BOUNDED = { role: 'mcp_listing_bounded', username: 'mcp_listing_bounded_user' };
const UNBOUNDED = { role: 'mcp_listing_unbounded', username: 'mcp_listing_unbounded_user' };
const GROUPED = { role: 'mcp_listing_grouped', username: 'mcp_listing_grouped_user' };
const UNRESTRICTED = { role: 'mcp_listing_unrestricted', username: 'mcp_listing_unrestricted_user' };
const ALIASED = { role: 'mcp_listing_aliased', username: 'mcp_listing_aliased_user' };

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

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

async function createRole(ctx: ContextWithHarper, role: string, username: string, permission: object): Promise<void> {
	const added = await opsAsAdmin(ctx, { operation: 'add_role', role, permission });
	ok(added?.id ?? added?.role, `add_role ${role} failed: ${JSON.stringify(added)}`);
	const user = await opsAsAdmin(ctx, { operation: 'add_user', role, username, password: PASSWORD, active: true });
	ok(user?.message ?? user?.username, `add_user ${username} failed: ${JSON.stringify(user)}`);
}

/** Tool names visible to `username` on the operations profile. */
async function listToolNames(ctx: ContextWithHarper, username: string): Promise<string[]> {
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.operationsAPIURL), {
		requestInit: { headers: { Authorization: basicAuth(username, PASSWORD) } },
	});
	const client = new Client({ name: 'mcp-role-listing', version: '1.0.0' }, { capabilities: {} });
	try {
		await client.connect(transport);
		const { tools } = await client.listTools();
		return tools.map((t) => t.name);
	} finally {
		await transport.close();
	}
}

suite('MCP operations profile: tools/list respects the role operations allowlist', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			config: { mcp: { operations: { mountPath: '/mcp', allow: MCP_ALLOW } } },
			env: {},
		});

		// `structure_user: ['data']` is validated against real databases at add_role time.
		await opsAsAdmin(ctx, { operation: 'create_database', database: 'data' });

		await createRole(ctx, BOUNDED.role, BOUNDED.username, {
			super_user: false,
			structure_user: ['data'],
			operations: ['sql', 'describe_all'],
		});
		await createRole(ctx, UNBOUNDED.role, UNBOUNDED.username, {
			super_user: false,
			structure_user: ['data'],
		});
		await createRole(ctx, GROUPED.role, GROUPED.username, {
			super_user: false,
			operations: ['read_only'],
		});
		await createRole(ctx, UNRESTRICTED.role, UNRESTRICTED.username, {
			super_user: false,
			structure_user: true,
		});
		// Every allowlist entry is the CANONICAL api_name of an aliased pair.
		await createRole(ctx, ALIASED.role, ALIASED.username, {
			super_user: false,
			structure_user: true,
			operations: ['create_database', 'drop_database', 'describe_schema', 'search_by_hash'],
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a structure_user grant does not escape the role operations allowlist', async () => {
		const names = await listToolNames(ctx, BOUNDED.username);
		for (const op of STRUCTURE_OPS) {
			ok(!names.includes(op), `${op} must not be advertised; got: ${names.join(', ')}`);
		}
		ok(names.includes('sql'), `the allowlisted op stays visible; got: ${names.join(', ')}`);
		ok(names.includes('describe_all'), `the allowlisted op stays visible; got: ${names.join(', ')}`);
	});

	test('an array structure_user sees the table ops but not the database ops', async () => {
		// `STRUCTURE_USER_OPS` holds only the table/attribute ops, so create/drop schema-or-database
		// needs `structure_user === true` and an array grant is denied at dispatch.
		const names = await listToolNames(ctx, UNBOUNDED.username);
		for (const op of STRUCTURE_TABLE_OPS) {
			ok(names.includes(op), `${op} expected for an array structure_user; got: ${names.join(', ')}`);
		}
		for (const op of STRUCTURE_DATABASE_OPS) {
			ok(!names.includes(op), `${op} must not be advertised to an array structure_user; got: ${names.join(', ')}`);
		}
	});

	test('an unrestricted structure_user sees all eight structure tools', async () => {
		const names = await listToolNames(ctx, UNRESTRICTED.username);
		for (const op of STRUCTURE_OPS) {
			ok(names.includes(op), `${op} expected for structure_user: true; got: ${names.join(', ')}`);
		}
	});

	test('an allowlist naming the canonical api_name governs both halves of an alias pair', async () => {
		// `verifyOperationsAllowlist` tests the handler's `api_name`, so listing `create_database`
		// is what actually grants `create_schema` at dispatch. Discovery must resolve the same alias.
		const names = await listToolNames(ctx, ALIASED.username);
		for (const op of ['create_database', 'create_schema', 'drop_database', 'drop_schema']) {
			ok(names.includes(op), `${op} expected via its canonical api_name; got: ${names.join(', ')}`);
		}
		for (const op of ['describe_schema', 'describe_database', 'search_by_hash', 'search_by_id']) {
			ok(names.includes(op), `${op} expected via its canonical api_name; got: ${names.join(', ')}`);
		}
		// Not aliased and not listed — the allowlist still bounds the structure_user grant.
		ok(!names.includes('create_table'), `create_table is unlisted; got: ${names.join(', ')}`);
		ok(!names.includes('drop_table'), `drop_table is unlisted; got: ${names.join(', ')}`);
	});

	test('an allowlisted group expands to the operations it actually grants', async () => {
		const names = await listToolNames(ctx, GROUPED.username);
		ok(names.includes('sql'), `read_only grants sql; got: ${names.join(', ')}`);
		ok(names.includes('describe_all'), `read_only grants describe_all; got: ${names.join(', ')}`);
		ok(names.includes('search_by_value'), `read_only grants search_by_value; got: ${names.join(', ')}`);
		ok(!names.includes('insert'), `read_only does not grant insert; got: ${names.join(', ')}`);
		ok(!names.includes('create_table'), `read_only does not grant create_table; got: ${names.join(', ')}`);
		// read_only lists both halves of these pairs, so both stay visible.
		ok(names.includes('describe_database'), `read_only grants describe_database; got: ${names.join(', ')}`);
		ok(names.includes('search_by_id'), `read_only grants search_by_id; got: ${names.join(', ')}`);
	});

	test('a surviving tool is actually invocable — discovery matches dispatch', async () => {
		// The bug was discovery-only: dispatch already failed closed. Invoking an op the bounded
		// role kept confirms the filter removed only the unreachable ones.
		const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.operationsAPIURL), {
			requestInit: { headers: { Authorization: basicAuth(BOUNDED.username, PASSWORD) } },
		});
		const client = new Client({ name: 'mcp-role-listing-call', version: '1.0.0' }, { capabilities: {} });
		try {
			await client.connect(transport);
			const result: any = await client.callTool({ name: 'describe_all', arguments: {} });
			strictEqual(result?.isError ?? false, false, `describe_all should dispatch: ${JSON.stringify(result)}`);
		} finally {
			await transport.close();
		}
	});
});
