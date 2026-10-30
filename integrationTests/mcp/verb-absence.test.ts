/**
 * QA-736/P-521 (harper#1945, fixed by #2405): missing Resource verbs are absent
 * from MCP discovery and dispatch. Implemented verbs remain callable, with
 * default allowCreate enforced for zero-permission and anonymous users.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-verb-absence');
const LOW_USER = { username: 'verb_no_permissions', password: 'VerbProbe-736!' };
const ROLE = 'verb_no_permissions';

interface Session {
	auth?: string;
	id?: string;
	rpcId: number;
}

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('MCP Resource verb absence and default create authorization', (ctx: ContextWithHarper) => {
	let admin: Session;
	let low: Session;
	let anonymous: Session;

	async function rpc(session: Session, method: string, params: object = {}): Promise<any> {
		const id = ++session.rpcId;
		const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json, text/event-stream',
				...(session.auth ? { authorization: session.auth } : {}),
				...(session.id ? { 'mcp-session-id': session.id, 'mcp-protocol-version': '2025-06-18' } : {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
			signal: AbortSignal.timeout(10_000),
		});
		session.id = res.headers.get('mcp-session-id') ?? session.id;
		const text = await res.text();
		strictEqual(res.status, 200, `${method}: ${text}`);
		const body = JSON.parse(text);
		strictEqual(body.jsonrpc, '2.0');
		strictEqual(body.id, id);
		return body;
	}

	async function newSession(auth?: string): Promise<Session> {
		const session: Session = { auth, rpcId: 0 };
		const body = await rpc(session, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'verb-absence', version: '1.0.0' },
		});
		strictEqual(body.error, undefined, JSON.stringify(body));
		strictEqual(body.result.protocolVersion, '2025-06-18');
		ok(session.id, 'initialize must establish a session');
		return session;
	}

	async function listTools(session: Session): Promise<string[]> {
		const names: string[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		do {
			const body = await rpc(session, 'tools/list', cursor ? { cursor } : {});
			strictEqual(body.error, undefined, JSON.stringify(body));
			ok(Array.isArray(body.result.tools), JSON.stringify(body));
			names.push(...body.result.tools.map((tool: { name: string }) => tool.name));
			cursor = body.result.nextCursor;
			if (cursor) {
				ok(!cursors.has(cursor) && cursors.size < 100, 'tools/list pagination must advance and terminate');
				cursors.add(cursor);
			}
		} while (cursor);
		return names;
	}

	function callTool(session: Session, name: string, args: object = {}): Promise<any> {
		return rpc(session, 'tools/call', { name, arguments: args });
	}

	async function success(session: Session, name: string, args: object = {}): Promise<any> {
		const body = await callTool(session, name, args);
		strictEqual(body.error, undefined, JSON.stringify(body));
		ok(body.result && body.result.isError !== true, JSON.stringify(body));
		return body.result.structuredContent;
	}

	function assertToolError(body: any, tool: string, message: string | string[]) {
		strictEqual(body.error, undefined, JSON.stringify(body));
		const content = body.result?.content;
		ok(Array.isArray(content) && content.length === 1 && content[0].type === 'text', JSON.stringify(body));
		const error = JSON.parse(content[0].text);
		const allowedMessages = Array.isArray(message) ? message : [message];
		ok(allowedMessages.includes(error.message), `unexpected ${tool} error: ${JSON.stringify(error)}`);
		deepStrictEqual(body.result, {
			isError: true,
			content: [{ type: 'text', text: content[0].text }],
		});
		deepStrictEqual(error, { kind: 'harper_error', tool, message: error.message });
	}

	async function operation(body: object): Promise<any> {
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': admin.auth! },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const text = await res.text();
		strictEqual(res.status, 200, text);
		return JSON.parse(text);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				mcp: { application: { mountPath: '/mcp' } },
				authentication: { authorizeLocal: false },
				threads: { count: 1 },
			},
		});
		const auth = basicAuth(ctx.harper.admin.username, ctx.harper.admin.password);
		await waitFor(
			async () => {
				try {
					const res = await fetch(new URL('/ReadOnlyThing/r1', ctx.harper.httpURL), {
						headers: { authorization: auth },
						signal: AbortSignal.timeout(5000),
					});
					const text = await res.text();
					return res.status === 200 && JSON.parse(text).label === 'readonly-r1';
				} catch {
					return false;
				}
			},
			{ timeout: 120_000, interval: 100, message: 'ReadOnlyThing fixture did not become ready' }
		);
		admin = await newSession(auth);
		await waitFor(async () => (await listTools(admin)).includes('get_ReadOnlyThing'), {
			timeout: 30_000,
			interval: 100,
			message: 'MCP did not register the fixture resources',
		});
		const role = await operation({ operation: 'add_role', role: ROLE, permission: { super_user: false } });
		ok(role.id, JSON.stringify(role));
		strictEqual(role.permission.super_user, false);
		const user = await operation({ operation: 'add_user', role: ROLE, ...LOW_USER, active: true });
		ok(user.message, JSON.stringify(user));
		low = await newSession(basicAuth(LOW_USER.username, LOW_USER.password));
		anonymous = await newSession();
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	for (const name of ['create_ReadOnlyThing', 'update_ReadOnlyThing', 'get_WriteOnlyThing', 'search_WriteOnlyThing']) {
		test(`${name} is absent from discovery and returns the unknown-tool frame`, async () => {
			const names = await listTools(admin);
			ok(names.includes('get_ReadOnlyThing') && names.includes('create_WriteOnlyThing'), 'fixture tools registered');
			strictEqual(names.includes(name), false, JSON.stringify(names));
			const body = await callTool(admin, name, { id: 'absent', label: 'must-not-write' });
			deepStrictEqual(body, {
				jsonrpc: '2.0',
				id: admin.rpcId,
				error: { code: -32601, message: `Unknown tool: ${name}` },
			});
		});
	}

	test('implemented custom verbs remain listed and return real values', async () => {
		const names = await listTools(admin);
		const expectedByResource: Record<string, string[]> = {
			ReadOnlyThing: ['get_ReadOnlyThing', 'search_ReadOnlyThing'],
			WriteOnlyThing: ['create_WriteOnlyThing', 'update_WriteOnlyThing'],
			CreateOnlyThing: ['create_CreateOnlyThing'],
			ThrowingCanary: ['create_ThrowingCanary'],
			PermissiveCanary: ['create_PermissiveCanary'],
		};
		for (const [resource, expected] of Object.entries(expectedByResource)) {
			deepStrictEqual(
				names.filter((name) => name.endsWith(`_${resource}`)).sort(),
				expected.sort(),
				`unexpected tools for ${resource}`
			);
		}
		const record = { id: 'written', label: 'created' };
		deepStrictEqual(await success(admin, 'create_WriteOnlyThing', record), record);
		deepStrictEqual(await success(admin, 'get_ReadOnlyThing', { id: record.id }), record);
		const updated = { id: record.id, label: 'updated' };
		deepStrictEqual(await success(admin, 'update_WriteOnlyThing', updated), updated);
		deepStrictEqual(await success(admin, 'get_ReadOnlyThing', { id: record.id }), updated);
		const created = { id: 'create-only', label: 'base-post-delegates-to-create' };
		deepStrictEqual(await success(admin, 'create_CreateOnlyThing', created), { id: created.id });
		deepStrictEqual(await success(admin, 'get_ReadOnlyThing', { id: created.id }), created);
		const searched = await success(admin, 'search_ReadOnlyThing');
		for (const record of [{ id: 'r1', label: 'readonly-r1' }, updated, created]) {
			deepStrictEqual(
				searched.rows.find(({ id }) => id === record.id),
				record
			);
		}
	});

	test('a real table retains create/get/search/update and persists changes', async () => {
		const names = await listTools(admin);
		for (const verb of ['create', 'get', 'search', 'update']) ok(names.includes(`${verb}_Widget`));
		deepStrictEqual(await success(admin, 'create_Widget', { id: 'widget-1', label: 'control' }), { id: 'widget-1' });
		strictEqual((await success(admin, 'get_Widget', { id: 'widget-1' })).label, 'control');
		deepStrictEqual(await success(admin, 'update_Widget', { id: 'widget-1', label: 'updated' }), { ok: true });
		strictEqual((await success(admin, 'get_Widget', { id: 'widget-1' })).label, 'updated');
		const searched = await success(admin, 'search_Widget');
		deepStrictEqual(
			searched.rows.map(({ id, label }) => ({ id, label })),
			[{ id: 'widget-1', label: 'updated' }]
		);
	});

	test('handler errors and explicit allowCreate success remain distinguishable', async () => {
		assertToolError(
			await callTool(low, 'create_ThrowingCanary', { id: 'throw' }),
			'create_ThrowingCanary',
			'QA736_DELIBERATE_CANARY_THROW'
		);
		const record = { id: 'permitted', label: 'low-user-created' };
		deepStrictEqual(await success(low, 'create_PermissiveCanary', record), record);
		deepStrictEqual(await success(admin, 'get_ReadOnlyThing', { id: record.id }), record);
	});

	for (const [identity, message] of [
		['zero-permission user', 'Unauthorized access to resource'],
		['anonymous', ['Unauthorized access to resource', 'Must login']],
	]) {
		test(`default allowCreate denies ${identity} on implemented create tools without writing`, async () => {
			const session = identity === 'anonymous' ? anonymous : low;
			if (identity === 'anonymous') {
				const visible = await listTools(session);
				for (const name of ['create_WriteOnlyThing', 'create_CreateOnlyThing']) {
					strictEqual(visible.includes(name), false, `${name} must not be listed to an anonymous caller`);
				}
			}
			const rowsBefore = await success(admin, 'search_ReadOnlyThing');
			ok(rowsBefore.rows.length > 0, 'the no-write oracle must contain records');
			for (const name of ['create_WriteOnlyThing', 'create_CreateOnlyThing']) {
				if (session === low) ok((await listTools(low)).includes(name), `${name} visible to authenticated user`);
				assertToolError(
					await callTool(session, name, { id: `denied-${identity}-${name}`, label: 'forbidden' }),
					name,
					message
				);
			}
			deepStrictEqual(await success(admin, 'search_ReadOnlyThing'), rowsBefore);
		});
	}
});
