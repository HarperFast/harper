// SQA-104 leg (6) — PR #3654 (main a7c60dd97) acceptance: `search_by_value` / `search_by_hash` validation failures
// answer 400 (`dataLayer/harperBridge/ResourceBridge.ts` throwSearchValidationError wraps the validator's
// plain Error in ClientError), `search_value: null` answers 200, `search_value: ['*']` answers 400 — and a role
// WITHOUT permission on the attribute is still refused at authorization (403) before validation can say
// whether the attribute exists (SF-67, SQA-100 A8 measured 500 on main 8bf7d1e06).
// Anchors: harper PR #3654; related harper#1416. Fixture: fulltext-source-authz-fixture (Product, audit + FullText). QA: SQA-104 / SP-76.
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fulltext-source-authz-fixture');
const OPTIONS = {
	config: {
		threads: { count: 2 },
		mcp: { operations: { mountPath: '/mcp' } },
	},
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const PASSWORD = 'Sqa104-mcp-7731!';
const READER = 'sqa104_reader'; // table read, description read:false, no operations allowlist
const SOURCES = ['id', 'title', 'description', 'tags', 'category', 'owner'];
const DENIED = 'description';

function ids(records: any[]): string[] {
	return records.map(({ id }) => id).sort();
}

suite(
	'SQA-104 search_by_value / search_by_hash validation status after PR #3654 (HTTP and MCP)',
	(ctx: ContextWithHarper) => {
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
		async function connectMcp(name: string, user: string, password: string) {
			const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.operationsAPIURL), {
				requestInit: { headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } },
			});
			const client = new Client({ name: 'sqa104-mcp', version: '1.0.0' }, { capabilities: {} });
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
			return { isError: Boolean(result.isError), text, parsed, structured: result.structuredContent };
		}
		const searchByValue = (search_attribute: unknown, search_value: unknown) => ({
			operation: 'search_by_value',
			database: 'data',
			table: 'Product',
			search_attribute,
			search_value,
			get_attributes: ['id', 'title'],
		});

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
					],
				},
				admin,
				200
			);
			await expectOp(
				{
					operation: 'add_role',
					role: READER,
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
										read: attribute_name !== DENIED,
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
			await expectOp(
				{ operation: 'add_user', username: READER, password: PASSWORD, role: READER, active: true },
				admin,
				200
			);
			await connectMcp('admin', ctx.harper.admin.username, ctx.harper.admin.password);
			await connectMcp('reader', READER, PASSWORD);
		});

		after(async () => {
			for (const c of Object.values(clients)) await c.transport.close().catch(() => {});
			await teardownHarper(ctx);
		});

		// ---------- leg (6): PR #3654 acceptance ----------

		test('V1 super_user: search_by_value on an unknown attribute (and on the full-text index name) answers 400, not 500', async () => {
			const statuses: Record<string, number> = {};
			for (const attribute of ['sqa104NoSuchAttribute', 'catalogSearch']) {
				const result = await op(searchByValue(attribute, 'classified'), admin);
				statuses[attribute] = result.status;
				assert.strictEqual(result.status, 400, `${attribute}: HTTP ${result.status} ${result.text}`);
				assert.match(result.text, /unknown attribute/i, result.text);
				assert.doesNotMatch(result.text, /\bat .*\.(ts|js):\d+/, `stack frame in the 400 body: ${result.text}`);
			}
			console.log('V1 statuses', JSON.stringify(statuses));
		});

		test('V1b positive control: search_by_value on a real attribute answers 200 with the matching rows', async () => {
			const result = await expectOp(searchByValue('category', 'shoes'), admin, 200);
			assert.deepStrictEqual(ids(result.body), ['one', 'two']);
		});

		test('V2 attribute-permissioned role: an unknown attribute is still refused at authorization (403), so the 400 does not disclose attribute existence', async () => {
			const statuses: Record<string, number> = {};
			for (const attribute of ['sqa104NoSuchAttribute', 'catalogSearch', DENIED]) {
				const result = await op(searchByValue(attribute, 'classified'), reader);
				statuses[attribute] = result.status;
				assert.strictEqual(result.status, 403, `${attribute}: HTTP ${result.status} ${result.text}`);
				assert.doesNotMatch(result.text, /unknown attribute/i, `validation ran before authorization: ${result.text}`);
			}
			// and the same role on a permitted attribute is answered without the denied attribute
			const allowed = await expectOp({ ...searchByValue('category', 'shoes'), get_attributes: ['*'] }, reader, 200);
			assert.deepStrictEqual(ids(allowed.body), ['one', 'two']);
			assert.deepStrictEqual(
				allowed.body.filter((record: any) => Object.hasOwn(record, DENIED)).map(({ id }: any) => id),
				[]
			);
			console.log('V2 statuses', JSON.stringify(statuses));
		});

		test('V3 super_user: search_value null answers 200; search_value ["*"] answers 400 (PR #3654 contract)', async () => {
			const nul = await op(searchByValue('category', null), admin);
			assert.strictEqual(nul.status, 200, `null: HTTP ${nul.status} ${nul.text}`);
			assert.ok(Array.isArray(nul.body), nul.text);
			const star = await op(searchByValue('category', ['*']), admin);
			assert.strictEqual(star.status, 400, `["*"]: HTTP ${star.status} ${star.text}`);
			assert.match(star.text, /must not be an array containing/i, star.text);
			console.log(
				'V3',
				JSON.stringify({ nullStatus: nul.status, nullIds: ids(nul.body), starStatus: star.status, star: star.text })
			);
		});

		test('V4 super_user: search_by_hash validation failures answer 400, not 500', async () => {
			const shapes: Array<[string, Record<string, unknown>]> = [
				['hash_values not an array', { hash_values: 'one' }],
				['hash_values missing', {}],
				['get_attributes empty', { hash_values: ['one'], get_attributes: [] }],
			];
			const statuses: Record<string, number> = {};
			for (const [label, extra] of shapes) {
				const result = await op(
					{ operation: 'search_by_hash', database: 'data', table: 'Product', get_attributes: ['id'], ...extra },
					admin
				);
				statuses[label] = result.status;
				assert.strictEqual(result.status, 400, `${label}: HTTP ${result.status} ${result.text}`);
			}
			const good = await expectOp(
				{
					operation: 'search_by_hash',
					database: 'data',
					table: 'Product',
					hash_values: ['one', 'three'],
					get_attributes: ['id'],
				},
				admin,
				200
			);
			assert.deepStrictEqual(ids(good.body), ['one', 'three']);
			console.log('V4 statuses', JSON.stringify(statuses));
		});

		test('V5 MCP super_user: the same unknown-attribute search_by_value is an isError result carrying the validation message', async () => {
			const result = await mcp('admin', 'search_by_value', {
				database: 'data',
				table: 'Product',
				search_attribute: 'sqa104NoSuchAttribute',
				search_value: 'classified',
				get_attributes: ['id', 'title'],
			});
			assert.strictEqual(result.isError, true, result.text);
			assert.match(result.text, /unknown attribute/i, result.text);
		});
	}
);
