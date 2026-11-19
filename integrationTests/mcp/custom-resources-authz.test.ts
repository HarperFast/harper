/**
 * MCP custom content resources (#1609) — row-level allowRead enforcement (#1735).
 *
 * Regression coverage for an authorization bypass on the custom `mcpResources`
 * read path. A component author wraps real table data behind a friendly MCP URI
 * (`orders:///{+orderId}`). When `Order` has a row-level `allowRead(user)` guard,
 * a low-priv MCP `resources/read` of another user's row must be denied — the same
 * as REST — not returned with full content.
 *
 * Two things make that hold, and this fixture exercises both:
 *   1. The custom-resource read runs inside a transaction that carries the calling
 *      MCP user (components/mcp/resources.ts `readCustomResource`), so an internal
 *      guarded fetch authorizes against the real session user.
 *   2. The author fetches through the *exported* (routing) `Order` Resource with a
 *      `checkPermission`-bearing RequestTarget — `Order.get(target)` — so its
 *      per-record `allowRead` runs. Fetching via the base `tables.Order.get()`
 *      would dispatch on the base table (table-level RBAC only) and leak.
 *
 * The fixture's `Order` subclass restricts reads to `customerId === username`
 * (super users pass); table-level read is granted, so the only barrier between
 * `lowuser` and another user's order is the per-record guard — exactly what must
 * hold on MCP just as it does on REST.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-custom-resources-authz');

const LOWUSER = { username: 'mcp_res_lowuser', password: 'LowPw-1735!' };
const ROLE = 'mcp_res_reader';

const ORDER_A = 'order-A'; // owned by lowuser
const ORDER_B = 'order-B'; // owned by admin — the forbidden row
const ORDER_B_ITEM = 'widget-B-secret';
const ORDER_B_TOTAL = 51599.15; // sentinel we scan for in a leak

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
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
	const client = new Client({ name: 'mcp-custom-resources-authz', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport };
}

interface ReadResult {
	contents?: Array<{ uri: string; text?: string; mimeType?: string }>;
}

function readText(result: ReadResult): string {
	return result.contents?.map((c) => c.text ?? '').join('') ?? '';
}

/** Operations-API call as admin (super user). */
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

suite('MCP custom content resources row-level allowRead (#1735)', (ctx: ContextWithHarper) => {
	let admin: { client: Client; transport: StreamableHTTPClientTransport };
	let low: { client: Client; transport: StreamableHTTPClientTransport };

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' } } },
			env: {},
		});

		// Table-level read only — the per-row allowRead guard is the real barrier.
		await opsAsAdmin(ctx, {
			operation: 'add_role',
			role: ROLE,
			permission: {
				super_user: false,
				data: {
					tables: {
						Order: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
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
			table: 'Order',
			records: [
				{ id: ORDER_A, customerId: LOWUSER.username, item: 'widget-A', total: 12.34 },
				{ id: ORDER_B, customerId: ctx.harper.admin.username, item: ORDER_B_ITEM, total: ORDER_B_TOTAL },
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

	// ── REST anchor: proves allowRead is wired and enforced on the base path ──
	test('REST anchor: lowuser is denied a direct point-read of order B', async () => {
		const res = await fetch(new URL(`/Order/${ORDER_B}`, ctx.harper.httpURL), {
			headers: { Authorization: basicAuth(LOWUSER.username, LOWUSER.password) },
		});
		await res.body?.cancel();
		ok(res.status === 403 || res.status === 404, `expected 403/404 REST anchor deny, got ${res.status}`);
	});

	// ── Positive control: the read handler works end-to-end for an allowed row ─
	test('lowuser MCP resources/read on own order A succeeds with real content', async () => {
		const result = (await low.client.readResource({ uri: `orders:///${ORDER_A}` })) as ReadResult;
		ok(readText(result).includes('widget-A'), `own order content present: ${JSON.stringify(result.contents)}`);
	});

	// ── The security oracle: forbidden row must NOT come back ──────────────────
	test('lowuser MCP resources/read on order B (not theirs) is denied, no leak', async () => {
		let deniedError: string | undefined;
		let text = '';
		try {
			const result = (await low.client.readResource({ uri: `orders:///${ORDER_B}` })) as ReadResult;
			text = readText(result);
		} catch (err) {
			deniedError = (err as Error)?.message ?? String(err);
		}
		// No content leak.
		ok(
			!text.includes(ORDER_B_ITEM) && !text.includes(String(ORDER_B_TOTAL)),
			'SECURITY: order B content leaked to lowuser via MCP custom resource read'
		);
		// And the denial must be an authorization error specifically — not a
		// generic read failure (import error, handler bug) that would fail open.
		ok(deniedError !== undefined, 'order B read should have been rejected, not returned');
		ok(/permission denied/i.test(deniedError), `expected a permission-denied error, got: ${deniedError}`);
	});

	// ── Enumeration is not a separate leak vector ──────────────────────────────
	test('resources/templates/list does not leak order B id/content', async () => {
		const listed = await low.client.listResourceTemplates();
		const blob = JSON.stringify(listed.resourceTemplates ?? []);
		ok(!blob.includes(ORDER_B) && !blob.includes(ORDER_B_ITEM), 'templates/list should advertise only the URI shape');
	});

	// ── Positive control: super user reads both, so the handler isn't just broken ─
	test('admin (super_user) MCP resources/read succeeds on both order A and B', async () => {
		const a = (await admin.client.readResource({ uri: `orders:///${ORDER_A}` })) as ReadResult;
		const b = (await admin.client.readResource({ uri: `orders:///${ORDER_B}` })) as ReadResult;
		ok(readText(a).includes('widget-A'), 'admin reads A');
		ok(readText(b).includes(ORDER_B_ITEM), 'admin reads B');
	});
});
