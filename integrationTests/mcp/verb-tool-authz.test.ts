/**
 * MCP verb-tool listing-vs-enforcement and manufactured-verb contracts.
 *
 * QA-735 (#1940, promote-candidate P-506) — MCP verb-tool listing-vs-authorization
 * divergence.
 *
 * #1940 reports that MCP verb tools for a table-less programmatic Resource are
 * listed ONLY to super-users (components/mcp/tools/application.ts
 * `makeVisibleTo`: `if (!databaseName || !tableName) return false` for any
 * non-super-user — there is no table to check a permission grant against).
 *
 * The interesting question is not the listing gap itself, it's whether listing
 * tracks authorization:
 *   1. Is a table-less tool hidden from a non-super-user's tools/list ALSO
 *      blocked when that user calls it blind (by name, not from their own
 *      list)? Or is it hidden-but-unguarded?
 *   2. Conversely, correctly-guarded-but-wrongly-hidden (usability bug)?
 *   3. For a table-backed Resource whose tools ARE listed (gated by table
 *      permission), does a hidden verb (e.g. create_Qa735Order, hidden because
 *      the role lacks insert) stay blocked when called blind — i.e. does
 *      table-backed hiding track real authorization, unlike the table-less
 *      case?
 *
 * Four identities x four resources, full visibility x invocability
 * cross-tabulation, every tool called BLIND by every identity (not just the
 * tools that identity's own tools/list returned). See resources.js for the
 * per-resource rationale.
 *
 * QA-736 (#1945, promote-candidate P-509) — MCP manufactured create_, update_,
 * delete_ tools: what happens on CALL.
 *
 * #1945 reports that `detectVerbs` (components/mcp/tools/application.ts) manufactures
 * create_, update_, delete_ tool entries for every Resource subclass, including ones that never
 * implement the verb — even the built-in `login` resource gets a create_login tool. #1945 is
 * about the LISTING; this probes the CALL: what actually happens when an MCP client invokes a
 * manufactured verb the Resource doesn't implement.
 *
 * ROOT CAUSE (read before adjusting expectations): `detectVerbs` checks
 * `typeof ResourceClass.prototype.post === 'function'` to decide whether to manufacture
 * `create_*`. resources/Resource.ts (~L352, `async post(target, newRecord)`) defines a base
 * INSTANCE `post` on every Resource subclass (it throws `missingMethod` unless the target is a
 * collection AND the subclass implements `create`) — so `typeof p.post === 'function'` is true
 * for EVERY subclass, manufacturing create_* unconditionally. Contrast resources/openApi.ts
 * L182/346: `prototype.post !== Resource.prototype.post || prototype.update` — an identity
 * comparison against the base class, which correctly excludes non-overriding subclasses.
 * `put`/`patch`/`delete` have NO base-class instance default (grep resources/Resource.ts: no
 * `async put(`/`patch(`/`delete(` instance methods exist), so detectVerbs' `typeof === 'function'`
 * check is correct for those three — the bug is narrower than the issue title implies: it is
 * specifically `create_*` (post-derived).
 *
 * Arms:
 *   1. Control — Qa736Widget (@table): a real Table genuinely implements every CRUD verb. Must succeed.
 *   2. Manufactured-but-unimplemented — Qa736ReadOnlyThing implements only get/search, never
 *      post/create anywhere. create_Qa736ReadOnlyThing is manufactured anyway (the bug).
 *      Characterize the call: clean isError? HTTP 500? unhandled rejection? silent no-op success?
 *      corruption?
 *   3. Authorization contract — does create_Qa736ReadOnlyThing (no allow* override -> base
 *      super-user-only default) block a non-super identity and an unauthenticated identity, or
 *      fall through unguarded? Per the prior-result note: hidden-from-listing is NOT itself a
 *      security boundary in Harper (toolRegistry.ts) — only a handler-level bypass counts as a gap.
 *   4. The built-in `login` resource's manufactured verb(s) specifically (#1945's own example).
 *
 * EMPIRICAL NOTE on arm 3 (verified at runtime, not assumed): with `authentication.authorizeLocal`
 * disabled (see `before`), Harper's /mcp transport does NOT require authentication to establish a
 * session or reach tools/call — an anonymous `initialize` succeeds and `request.user` is falsy in
 * the handler. That alone is not a defect per the prior-result note; what matters is whether the
 * per-resource `allow*` handler still denies for a null user, which it does (verified below).
 *
 * Oracle-arming (a blind negative is worthless): Qa736ThrowingCanary proves the isError/"TOOL-ERR"
 * classifier fires on a REAL throw; Qa736PermissiveCanary proves the "call actually succeeded"
 * classifier fires on a REAL permissive success. Both run through the identical detection code
 * used to judge arms 2-4, so a clean result there is not just "the harness always says ok/blocked".
 *
 * Shared instance: both specs have the same instance signature except QA-736 needs
 * `authentication.authorizeLocal: false` for its genuinely-anonymous arm, which QA-735 adopts for
 * free (it never relies on the loopback-as-super-user bypass). Resources/tables are namespaced
 * Qa735-/Qa736-prefixed in the shared fixture (see integrationTests/fixtures/mcp-verb-tool-authz)
 * so neither spec's state can collide with the other's.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-verb-tool-authz');

// ── QA-735 identities ──
const READER = { username: 'qa728_reader', password: 'ReaderPw-1940!' };
const READER_ROLE = 'qa728_reader_role';
const NOPERM = { username: 'qa728_noperm', password: 'NopermPw-1940!' };
const NOPERM_ROLE = 'qa728_noperm_role';

// ── QA-736 identity ──
const AUTHED = { username: 'qa736_authed', password: 'AuthedPw-1945!' };
const AUTHED_ROLE = 'qa736_authed_role';

// QA-735: the candidate tool names we probe blind, per resource. Some may not
// register at all (e.g. if a resource ends up with no create verb) — the
// probe records "unknown tool" for those rather than assuming.
const CANDIDATE_TOOLS = [
	'get_Qa735OpenTool',
	'search_Qa735OpenTool',
	'create_Qa735OpenTool',
	'get_Qa735StrictTool',
	'search_Qa735StrictTool',
	'create_Qa735StrictTool',
	'get_Qa735Order',
	'search_Qa735Order',
	'create_Qa735Order',
	'update_Qa735Order',
	'delete_Qa735Order',
	'qa735_health_ping',
];

// Every candidate registers on current main (verified at gate); the assertions below depend on all
// of them, so they are asserted as a precondition rather than skipped when absent.
const REQUIRED_ADMIN_TOOLS = CANDIDATE_TOOLS;

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

interface RpcSession {
	name: string;
	auth: string | undefined;
	sessionId?: string;
	rpcId: number;
}

interface ToolCallOutcome {
	httpStatus: number;
	/** JSON-RPC-level error (e.g. -32601 unknown tool / -32602) — a protocol-level rejection, not a handler error. */
	rpcError?: { code: number; message: string };
	/** Handler-level result: tools/call succeeded at the protocol level but the tool itself reported failure. */
	isError?: boolean;
	resultText?: string;
	structured?: unknown;
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

async function rpc(
	ctx: ContextWithHarper,
	session: RpcSession | null,
	method: string,
	params?: unknown
): Promise<{ status: number; body: any }> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'accept': 'application/json, text/event-stream',
	};
	if (session?.auth) headers.authorization = session.auth;
	if (session?.sessionId) {
		headers['mcp-session-id'] = session.sessionId;
		headers['mcp-protocol-version'] = '2025-06-18';
	}
	const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id: session ? ++session.rpcId : 1, method, params: params ?? {} }),
	});
	if (session) session.sessionId = res.headers.get('mcp-session-id') ?? session.sessionId;
	const status = res.status;
	const text = await res.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status, body };
}

/** Attempt an MCP session. Returns null (not a session) if initialize didn't yield HTTP 200. */
async function tryNewSession(
	ctx: ContextWithHarper,
	name: string,
	auth: string | undefined
): Promise<RpcSession | null> {
	const session: RpcSession = { name, auth, rpcId: 0 };
	const { status, body } = await rpc(ctx, session, 'initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: `verb-tool-authz-${name}`, version: '0' },
	});
	if (status !== 200 || body?.error) return null;
	return session;
}

async function newSession(ctx: ContextWithHarper, name: string, auth: string | undefined): Promise<RpcSession> {
	const session = await tryNewSession(ctx, name, auth);
	ok(session, `${name} initialize should succeed`);
	return session!;
}

/** Full tools/list for a session, paging through cursors. */
async function listAllTools(ctx: ContextWithHarper, session: RpcSession): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const { body } = await rpc(ctx, session, 'tools/list', cursor ? { cursor } : {});
		const tools = body?.result?.tools ?? [];
		for (const t of tools) names.push(t.name);
		cursor = body?.result?.nextCursor;
		if (!cursor) break;
	}
	return names;
}

async function callTool(
	ctx: ContextWithHarper,
	session: RpcSession | null,
	toolName: string,
	args: Record<string, unknown>
): Promise<ToolCallOutcome> {
	const { status, body } = await rpc(ctx, session, 'tools/call', { name: toolName, arguments: args });
	if (body?.error) {
		return { httpStatus: status, rpcError: { code: body.error.code, message: body.error.message } };
	}
	const result = body?.result;
	return {
		httpStatus: status,
		isError: result?.isError === true,
		resultText: result?.content?.map((c: any) => c.text ?? '').join('') ?? '',
		structured: result?.structuredContent,
	};
}

/** Minimal-but-valid arguments per QA-735 candidate tool, so a denial can't be blamed on malformed args. */
function argsFor(toolName: string): Record<string, unknown> {
	if (toolName.startsWith('create_'))
		return { id: `blind-${toolName}-${Date.now()}`, label: 'blind-call', item: 'blind-item' };
	if (toolName.startsWith('update_')) return { id: 'blind-target', item: 'blind-update' };
	if (toolName.startsWith('delete_')) return { id: 'blind-target' };
	if (toolName.startsWith('get_')) return { id: 'w1' };
	if (toolName.startsWith('search_')) return {};
	return {};
}

async function callToolBlind(ctx: ContextWithHarper, session: RpcSession, toolName: string): Promise<ToolCallOutcome> {
	return callTool(ctx, session, toolName, argsFor(toolName));
}

function classify(outcome: ToolCallOutcome | undefined): string {
	if (!outcome) return 'n/a';
	if (outcome.rpcError) return `RPC-ERR(${outcome.rpcError.code}):${outcome.rpcError.message}`;
	if (outcome.isError) return `TOOL-ERR:${(outcome.resultText ?? '').slice(0, 120)}`;
	return `OK:${JSON.stringify(outcome.structured ?? outcome.resultText).slice(0, 120)}`;
}

suite(
	'MCP verb-tool listing-vs-enforcement (QA-735 #1940) and manufactured-verb (QA-736 #1945) contracts',
	(ctx: ContextWithHarper) => {
		// ── QA-735 state ──
		let qa735Admin: RpcSession;
		let qa735Reader: RpcSession;
		let qa735Noperm: RpcSession;
		// visibility[identity][tool] = true if tool appeared in that identity's tools/list
		const visibility: Record<string, Set<string>> = {};
		// invocability[identity][tool] = outcome of a BLIND call (by name, regardless of visibility)
		const invocability: Record<string, Record<string, ToolCallOutcome>> = {};

		// ── QA-736 state ──
		let qa736Admin: RpcSession;
		let qa736Authed: RpcSession;
		// Live capture of Harper's stdout/stderr so we can confirm no unhandled rejection surfaces
		// server-side when a manufactured-but-unimplemented verb is invoked.
		let procOutput = '';
		const qa736Results: Record<string, ToolCallOutcome | undefined> = {};

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					mcp: { application: { mountPath: '/mcp' } },
					// Disable Harper's loopback auth bypass (security/auth.ts ~L270-278): by default,
					// a same-host request with NO Authorization header and no session is silently
					// authenticated AS THE SUPER USER (`AUTHORIZE_LOCAL`, on by default in dev/test —
					// see qa602-nulluser-middleware.test.ts). Integration tests run entirely against
					// 127.0.0.1, so without this QA-736's "unauthenticated" probes would actually be
					// exercising local-trust-as-super-user, not genuine anonymous access — a confound,
					// not an MCP-specific finding. Explicit Basic auth for admin/reader/noperm/authed is
					// unaffected, so QA-735 adopts this for free.
					authentication: { authorizeLocal: false },
				},
				env: {},
			});

			procOutput += ctx.harper.startupOutput?.stdout ?? '';
			procOutput += ctx.harper.startupOutput?.stderr ?? '';
			const proc = ctx.harper.process;
			proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
			proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

			// Poll the probe route directly for non-404 — component is pre-installed, no restart needed.
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const res = await fetch(new URL('/Qa735Order/', ctx.harper.httpURL), {
							headers: { Authorization: basicAuth(ctx.harper.admin.username, ctx.harper.admin.password) },
						});
						await res.body?.cancel();
						if (res.status !== 404) break;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
			}

			// QA-735 reader: explicit read-only table permission on Qa735Order. No permission on
			// Qa735OpenTool/Qa735StrictTool (table-less — there is nothing to grant a table permission
			// against) and none on Qa735Health (custom tool; RBAC is delegated to the Resource /
			// visibleTo:()=>true by design).
			await opsAsAdmin(ctx, {
				operation: 'add_role',
				role: READER_ROLE,
				permission: {
					super_user: false,
					data: {
						tables: {
							Qa735Order: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
			});
			await opsAsAdmin(ctx, {
				operation: 'add_user',
				role: READER_ROLE,
				username: READER.username,
				password: READER.password,
				active: true,
			});

			// QA-735 noperm: a role with NO table grants at all — the most locked-down non-super identity.
			await opsAsAdmin(ctx, {
				operation: 'add_role',
				role: NOPERM_ROLE,
				permission: { super_user: false },
			});
			await opsAsAdmin(ctx, {
				operation: 'add_user',
				role: NOPERM_ROLE,
				username: NOPERM.username,
				password: NOPERM.password,
				active: true,
			});

			await opsAsAdmin(ctx, {
				operation: 'insert',
				schema: 'data',
				table: 'Qa735Order',
				records: [{ id: 'order-1', customerId: 'someone', item: 'widget', total: 9.99 }],
			});

			// QA-736 authed: a locked-down non-super identity — no table grants, no special role permissions.
			await opsAsAdmin(ctx, {
				operation: 'add_role',
				role: AUTHED_ROLE,
				permission: { super_user: false },
			});
			await opsAsAdmin(ctx, {
				operation: 'add_user',
				role: AUTHED_ROLE,
				username: AUTHED.username,
				password: AUTHED.password,
				active: true,
			});

			qa735Admin = await newSession(
				ctx,
				'qa735-admin',
				basicAuth(ctx.harper.admin.username, ctx.harper.admin.password)
			);
			qa735Reader = await newSession(ctx, 'qa735-reader', basicAuth(READER.username, READER.password));
			qa735Noperm = await newSession(ctx, 'qa735-noperm', basicAuth(NOPERM.username, NOPERM.password));

			qa736Admin = await newSession(
				ctx,
				'qa736-admin',
				basicAuth(ctx.harper.admin.username, ctx.harper.admin.password)
			);
			qa736Authed = await newSession(ctx, 'qa736-authed', basicAuth(AUTHED.username, AUTHED.password));
		});

		after(async () => {
			// eslint-disable-next-line no-console
			console.log('\n=== QA-735 visibility x invocability matrix ===');
			const identities = ['admin', 'reader', 'noperm'];
			for (const tool of CANDIDATE_TOOLS) {
				const row = identities
					.map((id) => {
						const vis = visibility[id]?.has(tool) ? 'LISTED' : 'hidden';
						const inv = classify(invocability[id]?.[tool]);
						return `${id}=[${vis}|${inv}]`;
					})
					.join('  ');
				// eslint-disable-next-line no-console
				console.log(`${tool.padEnd(24)} ${row}`);
			}

			// eslint-disable-next-line no-console
			console.log('\n=== QA-736 outcomes ===');
			for (const [key, outcome] of Object.entries(qa736Results)) {
				// eslint-disable-next-line no-console
				console.log(`${key.padEnd(40)} ${classify(outcome)}`);
			}

			await teardownHarper(ctx);
		});

		test('QA-735: enumerate tools/list per identity', async () => {
			for (const [name, session] of [
				['admin', qa735Admin],
				['reader', qa735Reader],
				['noperm', qa735Noperm],
			] as const) {
				const names = await listAllTools(ctx, session);
				visibility[name] = new Set(names);
			}

			// Sanity: admin (super-user) sees every candidate tool that actually registered.
			// Not asserted to include ALL of CANDIDATE_TOOLS verbatim (e.g. update_Qa735Order may not
			// register depending on verb detection) — just used to seed which names are real.
			// Hard precondition: every tool the assertions below depend on MUST have registered.
			// Without this the `has(...)`-guarded assertions could all skip and the test would pass vacuously.
			for (const tool of REQUIRED_ADMIN_TOOLS) {
				ok(
					visibility.admin.has(tool),
					`precondition: admin must see ${tool} (saw: ${[...visibility.admin].sort().join(', ')})`
				);
			}

			// #1940 core claim: table-less resource tools are hidden from non-super users.
			for (const tool of [
				'get_Qa735OpenTool',
				'search_Qa735OpenTool',
				'get_Qa735StrictTool',
				'search_Qa735StrictTool',
			]) {
				ok(!visibility.reader.has(tool), `#1940: reader should NOT see table-less tool ${tool}`);
				ok(!visibility.noperm.has(tool), `#1940: noperm should NOT see table-less tool ${tool}`);
			}

			// Qa735Order tools: reader has read-only permission -> should see get/search but not create/update/delete.
			ok(visibility.reader.has('get_Qa735Order'), 'reader should see get_Qa735Order (has read)');
			ok(visibility.reader.has('search_Qa735Order'), 'reader should see search_Qa735Order (has read)');
			ok(!visibility.reader.has('create_Qa735Order'), 'reader should NOT see create_Qa735Order (no insert)');
			// noperm has no table grants at all -> sees no Qa735Order tools.
			ok(!visibility.noperm.has('get_Qa735Order'), 'noperm should NOT see get_Qa735Order');
			ok(!visibility.noperm.has('search_Qa735Order'), 'noperm should NOT see search_Qa735Order');

			// Control: qa735_health_ping is a custom mcpTools entry (visibleTo: () => true) -> listed to everyone.
			ok(visibility.reader.has('qa735_health_ping'), 'reader should see the control tool qa735_health_ping');
			ok(visibility.noperm.has('qa735_health_ping'), 'noperm should see the control tool qa735_health_ping');
		});

		test('QA-735: blind-call every candidate tool as every identity and record outcomes', async () => {
			for (const [name, session] of [
				['admin', qa735Admin],
				['reader', qa735Reader],
				['noperm', qa735Noperm],
			] as const) {
				invocability[name] = {};
				for (const tool of CANDIDATE_TOOLS) {
					invocability[name][tool] = await callToolBlind(ctx, session, tool);
				}
			}

			// ── Harness sanity: the control tool must be invocable by everyone (proves the harness
			// actually exercises the surface — an all-403 matrix would otherwise be ambiguous). ──
			for (const id of ['admin', 'reader', 'noperm']) {
				const outcome = invocability[id]['qa735_health_ping'];
				ok(
					outcome && !outcome.rpcError && !outcome.isError,
					`control qa735_health_ping should succeed for ${id}: ${JSON.stringify(outcome)}`
				);
			}

			// admin (super-user) is a second sanity anchor: it should be able to invoke every tool
			// that actually registered (proves the handlers themselves work, ruling out "my calls
			// were malformed" as the explanation for any non-super denial below).
			for (const tool of CANDIDATE_TOOLS) {
				if (!visibility.admin?.has(tool)) continue;
				const outcome = invocability.admin[tool];
				ok(
					outcome && !outcome.rpcError && !outcome.isError,
					`admin blind call to ${tool} (a real, listed tool) should succeed: ${JSON.stringify(outcome)}`
				);
			}

			// ── #1940 leg 1: table-less Qa735OpenTool (author-permissive allow*) is hidden from
			// reader/noperm but its own allowRead/allowCreate says "any authenticated user" -> blind call
			// SUCCEEDS. This is the real divergence: hidden-but-unguarded relative to what tools/list
			// implied. ──
			for (const id of ['reader', 'noperm']) {
				for (const tool of ['get_Qa735OpenTool', 'search_Qa735OpenTool', 'create_Qa735OpenTool']) {
					if (!visibility.admin?.has(tool)) continue;
					ok(!visibility[id].has(tool), `sanity: ${tool} should be hidden from ${id}`);
					const outcome = invocability[id][tool];
					ok(
						outcome && !outcome.rpcError && !outcome.isError,
						`#1940 SECURITY-RELEVANT: ${id} blind call to hidden ${tool} should succeed (author's allow* permits any authenticated user): ${JSON.stringify(outcome)}`
					);
				}
			}

			// ── Contrast: table-less Qa735StrictTool has NO allow* override -> falls back to Harper's
			// base Resource default (super-user only). Hidden from reader/noperm AND blocked when called
			// blind -> no divergence here; the framework default is safe by itself. ──
			for (const id of ['reader', 'noperm']) {
				for (const tool of ['get_Qa735StrictTool', 'search_Qa735StrictTool', 'create_Qa735StrictTool']) {
					if (!visibility.admin?.has(tool)) continue;
					const outcome = invocability[id][tool];
					ok(
						outcome && (outcome.rpcError || outcome.isError),
						`Qa735StrictTool ${tool} should be blocked for ${id} (no allow* override -> super-user-only default): ${JSON.stringify(outcome)}`
					);
				}
			}

			// ── #1940 leg 3: table-backed Qa735Order. reader has read-only permission: create/update/delete
			// are hidden AND should stay blocked when called blind (table-level RBAC enforces
			// regardless of listing) -> no divergence for the table-backed case. ──
			for (const tool of ['create_Qa735Order', 'update_Qa735Order', 'delete_Qa735Order']) {
				if (!visibility.admin?.has(tool)) continue;
				const outcome = invocability.reader[tool];
				ok(
					outcome && (outcome.rpcError || outcome.isError),
					`reader blind call to hidden ${tool} should be blocked (no insert/update/delete grant): ${JSON.stringify(outcome)}`
				);
			}
			// noperm has no Qa735Order grant at all: get/search are hidden and should also be blocked blind.
			for (const tool of ['get_Qa735Order', 'search_Qa735Order']) {
				if (!visibility.admin?.has(tool)) continue;
				const outcome = invocability.noperm[tool];
				ok(
					outcome && (outcome.rpcError || outcome.isError),
					`noperm blind call to hidden ${tool} should be blocked (no read grant): ${JSON.stringify(outcome)}`
				);
			}
		});

		test('QA-736 arm 0: discover the manufactured tool set (sanity)', async () => {
			const adminTools = await listAllTools(ctx, qa736Admin);
			ok(adminTools.includes('create_Qa736Widget'), 'Qa736Widget (a real table) should list create_Qa736Widget');
			ok(
				adminTools.includes('create_Qa736ReadOnlyThing'),
				'#1945 REPRODUCTION: create_Qa736ReadOnlyThing should be manufactured despite Qa736ReadOnlyThing never implementing create/post (detectVerbs checks typeof p.post === "function", which is always true — every Resource subclass inherits a base instance post from resources/Resource.ts)'
			);
			// The narrower-than-stated-in-the-issue-title claim: put/patch have no base-class instance
			// default, so update_Qa736ReadOnlyThing must NOT be manufactured for a class that doesn't implement it.
			ok(
				!adminTools.includes('update_Qa736ReadOnlyThing') && !adminTools.includes('patch_Qa736ReadOnlyThing'),
				'update_ and patch_ tools should NOT be manufactured for Qa736ReadOnlyThing (no base-class instance put/patch default exists, unlike post)'
			);
			ok(
				adminTools.includes('create_login'),
				'#1945: built-in login resource should also get a manufactured create_login tool'
			);
			ok(
				!adminTools.includes('get_login'),
				'sanity: login only overrides STATIC get (bypassing the instance-prototype introspection detectVerbs reads), so get_login is correctly NOT manufactured — a separate, opposite-direction quirk'
			);
		});

		test('QA-736 oracle-arming: canaries prove the classifier has teeth', async () => {
			// Canary 1: a REAL throw inside create must classify as TOOL-ERR, not OK.
			const throwOutcome = await callTool(ctx, qa736Admin, 'create_Qa736ThrowingCanary', { id: 'canary-1' });
			qa736Results['canary.throwing(admin)'] = throwOutcome;
			ok(
				throwOutcome.httpStatus === 200,
				'canary throw: JSON-RPC transport should still be HTTP 200 (clean tool-level error)'
			);
			ok(throwOutcome.isError === true, 'canary throw: isError must be true for a handler that genuinely threw');
			ok(
				(throwOutcome.resultText ?? '').includes('QA736_DELIBERATE_CANARY_THROW'),
				`canary throw: error text should surface the real throw message, got: ${throwOutcome.resultText}`
			);

			// Canary 2: a REAL permissive success (non-super user, permissive allowCreate) must classify as OK.
			const permissiveOutcome = await callTool(ctx, qa736Authed, 'create_Qa736PermissiveCanary', { id: 'canary-2' });
			qa736Results['canary.permissive(authed)'] = permissiveOutcome;
			ok(!permissiveOutcome.rpcError, 'canary permissive: should not be a protocol-level error');
			ok(
				permissiveOutcome.isError !== true,
				`canary permissive: should succeed (allowCreate is permissive), got: ${JSON.stringify(permissiveOutcome)}`
			);
			ok(
				(permissiveOutcome.structured as any)?.id === 'canary-2',
				`canary permissive: structuredContent should carry the created id, got: ${JSON.stringify(permissiveOutcome.structured)}`
			);
		});

		test('QA-736 arm 1: control — Qa736Widget (real table) create succeeds for admin', async () => {
			const outcome = await callTool(ctx, qa736Admin, 'create_Qa736Widget', { id: 'widget-1', label: 'control' });
			qa736Results['arm1.control.create_Qa736Widget(admin)'] = outcome;
			ok(!outcome.rpcError, 'control create should not be a protocol-level error');
			ok(outcome.isError !== true, `control create_Qa736Widget should succeed, got: ${JSON.stringify(outcome)}`);
			// Verify it actually persisted (not a silent no-op success).
			const getOutcome = await callTool(ctx, qa736Admin, 'get_Qa736Widget', { id: 'widget-1' });
			ok(
				(getOutcome.structured as any)?.label === 'control',
				`control: created Qa736Widget should be readable back, got: ${JSON.stringify(getOutcome)}`
			);
		});

		test('QA-736 arm 2: manufactured-but-unimplemented create_Qa736ReadOnlyThing as admin (super-user, so authz passes trivially)', async () => {
			const before = await callTool(ctx, qa736Admin, 'search_Qa736ReadOnlyThing', {});
			const outcome = await callTool(ctx, qa736Admin, 'create_Qa736ReadOnlyThing', {
				id: 'phantom-1',
				label: 'should-not-persist',
			});
			qa736Results['arm2.create_Qa736ReadOnlyThing(admin)'] = outcome;
			const after = await callTool(ctx, qa736Admin, 'search_Qa736ReadOnlyThing', {});

			ok(
				outcome.httpStatus === 200,
				`manufactured-unimplemented call should not be an HTTP 500, got status ${outcome.httpStatus}`
			);
			ok(
				!outcome.rpcError,
				`manufactured-unimplemented call should not be a protocol-level JSON-RPC error, got: ${JSON.stringify(outcome.rpcError)}`
			);
			ok(
				outcome.isError === true,
				`manufactured-unimplemented call should be a clean isError result, not a silent success, got: ${JSON.stringify(outcome)}`
			);
			ok(
				/create/i.test(outcome.resultText ?? '') || /method/i.test(outcome.resultText ?? ''),
				`error text should reflect the missing create/post method, got: ${outcome.resultText}`
			);
			strictEqual(
				JSON.stringify((before.structured as any)?.rows ?? before.resultText),
				JSON.stringify((after.structured as any)?.rows ?? after.resultText),
				'Qa736ReadOnlyThing.search() output must be unchanged by the failed create attempt (no phantom state)'
			);
			ok(
				!/UnhandledPromiseRejection|uncaughtException/i.test(procOutput),
				'no unhandled rejection/uncaught exception should appear in the Harper process output'
			);
		});

		test('QA-736 arm 3: authorization contract — create_Qa736ReadOnlyThing inherits the super-user-only default', async () => {
			const authedOutcome = await callTool(ctx, qa736Authed, 'create_Qa736ReadOnlyThing', {
				id: 'phantom-2',
				label: 'authed-attempt',
			});
			qa736Results['arm3.create_Qa736ReadOnlyThing(authed-non-super)'] = authedOutcome;
			ok(
				authedOutcome.rpcError || authedOutcome.isError === true,
				`non-super authed call should be blocked (base allowCreate default is super-user-only), got: ${JSON.stringify(authedOutcome)}`
			);
			// The block must be an AUTHORIZATION denial, not accidentally the same "missing method" text —
			// distinguishing "blocked before dispatch" from "dispatched then crashed" matters for arm 3's claim.
			ok(
				!/create.*method|method.*implement/i.test(authedOutcome.resultText ?? ''),
				`non-super denial should be an authz rejection (not the missing-method crash text that a super-user sees), got: ${authedOutcome.resultText}`
			);

			// Unauthenticated: try to even establish a session. EMPIRICAL FINDING (with the loopback
			// bypass disabled above): Harper's /mcp transport does NOT require authentication to
			// initialize a session or reach tools/call — `initialize` succeeds with no Authorization
			// header, and `request.user` is falsy inside the tool handler. That is NOT a security gap by
			// itself: per the prior-result note (toolRegistry.ts — visibleTo/listing is not authz), the
			// question is whether a handler-level check still denies. Here it does: the SAME
			// super-user-only allowCreate default that blocked "authed" also blocks a null user (the
			// default `user?.role.permission.super_user` optional-chains safely to `undefined` for a
			// missing user, without throwing).
			const anonSession = await tryNewSession(ctx, 'anon', undefined);
			if (anonSession) {
				const anonOutcome = await callTool(ctx, anonSession, 'create_Qa736ReadOnlyThing', { id: 'phantom-3' });
				qa736Results['arm3.create_Qa736ReadOnlyThing(unauth, session granted)'] = anonOutcome;
				ok(
					anonOutcome.rpcError || anonOutcome.isError === true,
					`SECURITY: unauthenticated call must be blocked, got: ${JSON.stringify(anonOutcome)}`
				);
			} else {
				// Confirm this via a raw, session-less tools/call attempt too (belt-and-suspenders).
				const raw = await callTool(ctx, null, 'create_Qa736ReadOnlyThing', { id: 'phantom-3' });
				qa736Results['arm3.create_Qa736ReadOnlyThing(unauth, no session)'] = raw;
				ok(
					raw.httpStatus !== 200 || raw.rpcError || raw.isError === true,
					`SECURITY: a session-less tools/call must not silently succeed, got: ${JSON.stringify(raw)}`
				);
			}
		});

		test('QA-736 arm 4: built-in login resource — manufactured create_login', async () => {
			// As admin: authz passes trivially (super-user), so we're isolating what happens when
			// create_login actually dispatches. Login overrides STATIC post directly (bypassing the
			// `transactional()` wrapper other resources go through), calling `request.login(...)` —
			// but the MCP-built context object has no `.login` method.
			const adminOutcome = await callTool(ctx, qa736Admin, 'create_login', { username: 'nobody', password: 'wrong' });
			qa736Results['arm4.create_login(admin)'] = adminOutcome;
			ok(
				adminOutcome.httpStatus === 200,
				`create_login call should not be an HTTP 500, got status ${adminOutcome.httpStatus}`
			);
			ok(
				!adminOutcome.rpcError,
				`create_login should not be a protocol-level error, got: ${JSON.stringify(adminOutcome.rpcError)}`
			);
			ok(
				adminOutcome.isError === true,
				`create_login should surface a clean isError (not a silent success masquerading as a login), got: ${JSON.stringify(adminOutcome)}`
			);

			// As non-super authed user: Login's static post bypass means no allow* gate runs for this
			// tool specifically (unlike Qa736ReadOnlyThing) — the real question is whether that
			// translates into an actual state change or credential leak, or whether it's inert because
			// the call crashes before doing anything.
			const authedOutcome = await callTool(ctx, qa736Authed, 'create_login', { username: 'nobody', password: 'wrong' });
			qa736Results['arm4.create_login(authed-non-super)'] = authedOutcome;
			ok(
				authedOutcome.httpStatus === 200,
				`create_login call should not be an HTTP 500, got status ${authedOutcome.httpStatus}`
			);
			ok(
				authedOutcome.isError === true || !!authedOutcome.rpcError,
				`create_login must not silently succeed for a non-super user (even though it bypasses the allow* gate, it must not fabricate a session), got: ${JSON.stringify(authedOutcome)}`
			);

			// Unauthenticated: per arm 3's finding, the MCP transport itself doesn't require auth to
			// reach tools/call — so unlike Qa736ReadOnlyThing (which is protected by the allow* default),
			// create_login has NO allow* gate at all (Login's static post bypasses `transactional()`
			// entirely). The only thing standing between an anonymous caller and a "successful" call is
			// that the handler is broken by construction (`request.login` doesn't exist on the MCP
			// context) — so it's inert, not because it's guarded, but because it can't do anything.
			const anonSession = await tryNewSession(ctx, 'anon-login', undefined);
			ok(
				anonSession,
				'anon-login initialize should succeed (confirms the transport genuinely allows anonymous session establishment)'
			);
			const anonOutcome = await callTool(ctx, anonSession!, 'create_login', { username: 'nobody', password: 'wrong' });
			qa736Results['arm4.create_login(unauth)'] = anonOutcome;
			ok(
				anonOutcome.httpStatus === 200,
				`create_login call should not be an HTTP 500, got status ${anonOutcome.httpStatus}`
			);
			ok(
				anonOutcome.isError === true || !!anonOutcome.rpcError,
				`SECURITY: create_login must not silently succeed / fabricate a session for an unauthenticated caller, got: ${JSON.stringify(anonOutcome)}`
			);
			ok(
				(anonOutcome.resultText ?? '').includes('request.login is not a function'),
				`create_login should fail the same way (broken handler, not an authz denial) for every identity, got: ${anonOutcome.resultText}`
			);
		});
	}
);
