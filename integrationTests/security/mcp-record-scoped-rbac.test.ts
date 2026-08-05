/**
 * QA-408 — Verify harper#1522 closes MCP authz bypasses F-092 (read) and F-093 (write).
 *
 * PR #1522 (`fix(mcp): enforce row-level RBAC on MCP application verb tools`, commit
 * 2e3620c6e, merged 2026-06-29) introduced `liveResource()` in
 * components/mcp/tools/application.ts: all 5 verb handlers now resolve the LIVE
 * registry Resource class at call time instead of the base table class captured at
 * tool-registration. This closes both bypasses in one shot.
 *
 * What we test:
 *   F-092 (read):  lowuser MCP get_Doc on admin's row → denied (isError or empty),
 *                  NOT the row. search_Doc → only lowuser-owned rows, NOT admin-owned.
 *   F-093 (write): lowuser MCP update_Doc/delete_Doc/create_Doc on denied rows →
 *                  MCP error + NO persistence (verified by admin read-back).
 *
 *   Controls (all must pass for result to be valid):
 *     POSITIVE CONTROL:  admin MCP get/update/create/delete succeed and persist.
 *     OWN-ROW:           lowuser can get and update its OWN row.
 *     REST ANCHOR:       REST GET/PUT/DELETE as lowuser on admin's row → 403.
 *
 * Fixture: integrationTests/qa-scratch/qa408-mcp-rbac-fixed/ (copied from
 *   integrationTests/fixtures/mcp-row-authz — same guards, already validated by
 *   the PR's regression suite).
 *
 * Harper SHA: 1b45db9ea (v5.1.15 + 2e3620c6e merged).
 * Run: npm run test:integration -- "integrationTests/qa-scratch/qa408-mcp-rbac-fixed.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { writeFileSync, appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_PATH = resolve(import.meta.dirname, 'mcp-record-scoped-rbac');
const RESULTS_FILE = join(tmpdir(), 'qa408-results.txt');
const HARPER_SHA = '1b45db9ea';

const LOWUSER = { username: 'qa408_lowuser', password: 'LowPw-408!' };
const ROLE = 'qa408_writer';

const ADMIN_ROW = 'qa408-admin-row';
const LOWUSER_ROW = 'qa408-lowuser-row';

// A row id lowuser will try to CREATE with owner=admin (should be denied).
const LOWUSER_CREATE_ID = 'qa408-lowuser-creates-for-admin';

// ─── Result tracking ──────────────────────────────────────────────────────────

interface Finding {
	op: string;
	principal: string;
	allowed: boolean | 'n/a';
	persisted?: boolean | 'n/a';
	verdict: 'ENFORCED' | 'BYPASS' | 'PASS' | 'FAIL' | 'N/A';
	note?: string;
}

const findings: Finding[] = [];

function recordFinding(f: Finding): void {
	findings.push(f);
	const line = `  ${f.op.padEnd(30)} | ${f.principal.padEnd(20)} | allowed=${String(f.allowed).padEnd(5)} | persisted=${String(f.persisted ?? 'n/a').padEnd(5)} | ${f.verdict}${f.note ? ' — ' + f.note : ''}`;
	appendFileSync(RESULTS_FILE, line + '\n');
}

function log(msg: string): void {
	const line = `[QA-408] ${msg}`;
	console.log(line);
	appendFileSync(RESULTS_FILE, line + '\n');
}

// ─── MCP client helpers ───────────────────────────────────────────────────────

function basicAuth(u: string, p: string): string {
	return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
}

interface ToolResult {
	isError?: boolean;
	content?: Array<{ type: string; text: string }>;
}

async function appClient(
	ctx: ContextWithHarper,
	username: string,
	password: string
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.httpURL), {
		requestInit: { headers: { Authorization: basicAuth(username, password) } },
	});
	const client = new Client({ name: 'qa408', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
	return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function resultText(r: ToolResult): string {
	return r.content?.map((c) => c.text ?? '').join('') ?? '';
}

// ─── Persistence oracle (admin ops API read-back) ─────────────────────────────

async function readDoc(ctx: ContextWithHarper, id: string): Promise<Record<string, unknown> | null> {
	const res = await fetch(new URL('', ctx.harper.operationsAPIURL), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': basicAuth(ctx.harper.admin.username, ctx.harper.admin.password),
		},
		body: JSON.stringify({
			operation: 'search_by_value',
			schema: 'data',
			table: 'Doc',
			search_attribute: 'id',
			search_value: id,
			get_attributes: ['*'],
		}),
	});
	const text = await res.text();
	let rows: unknown[];
	try {
		rows = JSON.parse(text);
	} catch {
		return null;
	}
	return Array.isArray(rows) && rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

suite('QA-408: verify harper#1522 closes F-092/F-093 MCP RBAC bypasses', (ctx: ContextWithHarper) => {
	let admin: { client: Client; transport: StreamableHTTPClientTransport };
	let low: { client: Client; transport: StreamableHTTPClientTransport };
	let appURL: string;

	before(async () => {
		writeFileSync(
			RESULTS_FILE,
			`========== QA-408: MCP RBAC fix regression (harper#1522) ==========\n` +
				`Harper SHA: ${HARPER_SHA}\n` +
				`Fixture: ${FIXTURE_PATH}\n` +
				`Started: ${new Date().toISOString()}\n\n` +
				`Checking all MCP ops × principals:\n`
		);

		log('Starting Harper with mcp.application config...');
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' } } },
			env: {},
		});

		appURL = ctx.harper.httpURL;
		log(`Harper started. httpURL=${appURL}`);

		// Role: table-level CRUD — row-level guards are the ONLY barrier.
		const adminAuth = basicAuth(ctx.harper.admin.username, ctx.harper.admin.password);

		const roleRes = await fetch(new URL('', ctx.harper.operationsAPIURL), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': adminAuth },
			body: JSON.stringify({
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
			}),
		});
		log(`add_role: ${roleRes.status}`);

		const userRes = await fetch(new URL('', ctx.harper.operationsAPIURL), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': adminAuth },
			body: JSON.stringify({
				operation: 'add_user',
				role: ROLE,
				username: LOWUSER.username,
				password: LOWUSER.password,
				active: true,
			}),
		});
		log(`add_user: ${userRes.status}`);

		// Seed rows.
		const insertRes = await fetch(new URL('', ctx.harper.operationsAPIURL), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': adminAuth },
			body: JSON.stringify({
				operation: 'insert',
				schema: 'data',
				table: 'Doc',
				records: [
					{ id: ADMIN_ROW, owner: ctx.harper.admin.username, payload: 'admin-original' },
					{ id: LOWUSER_ROW, owner: LOWUSER.username, payload: 'lowuser-original' },
				],
			}),
		});
		log(`insert rows: ${insertRes.status}`);

		// Poll until Doc route is ready.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(new URL('/Doc/', appURL), {
					headers: { Authorization: adminAuth },
				});
				if (probe.status !== 404) {
					await probe.body?.cancel();
					break;
				}
				await probe.body?.cancel();
			} catch {
				/* not ready */
			}
			await sleep(250);
		}

		// Open authenticated MCP sessions. MUST pass real Authorization header —
		// loopback-without-auth is auto-promoted to super_user and would mask the fix.
		admin = await appClient(ctx, ctx.harper.admin.username, ctx.harper.admin.password);
		low = await appClient(ctx, LOWUSER.username, LOWUSER.password);
		log('MCP sessions established (admin + lowuser)');
	});

	after(async () => {
		await admin?.transport.close();
		await low?.transport.close();
		await teardownHarper(ctx);
		appendFileSync(RESULTS_FILE, `\nFinished: ${new Date().toISOString()}\n`);
		log('Teardown complete.');
	});

	// ── REST ANCHORS ─────────────────────────────────────────────────────────────

	test('REST anchor: lowuser GET admin row → 403/404 (cross-surface reference)', async () => {
		const res = await fetch(new URL(`/Doc/${ADMIN_ROW}`, appURL), {
			headers: { Authorization: basicAuth(LOWUSER.username, LOWUSER.password) },
		});
		await res.body?.cancel();
		log(`REST GET admin row as lowuser: status=${res.status}`);
		recordFinding({
			op: 'REST GET admin row',
			principal: 'lowuser',
			allowed: false,
			persisted: 'n/a',
			verdict: res.status === 403 || res.status === 404 || res.status === 401 ? 'ENFORCED' : 'BYPASS',
			note: `HTTP ${res.status}`,
		});
		ok(
			res.status === 403 || res.status === 404 || res.status === 401,
			`REST GET should deny lowuser on admin's row, got ${res.status}`
		);
	});

	test('REST anchor: lowuser PUT admin row → 403 (cross-surface reference)', async () => {
		const res = await fetch(new URL(`/Doc/${ADMIN_ROW}`, appURL), {
			method: 'PUT',
			headers: {
				'Authorization': basicAuth(LOWUSER.username, LOWUSER.password),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ owner: ctx.harper.admin.username, payload: 'rest-overwrite' }),
		});
		await res.body?.cancel();
		log(`REST PUT admin row as lowuser: status=${res.status}`);
		recordFinding({
			op: 'REST PUT admin row',
			principal: 'lowuser',
			allowed: false,
			persisted: 'n/a',
			verdict: res.status === 403 || res.status === 401 ? 'ENFORCED' : 'BYPASS',
			note: `HTTP ${res.status}`,
		});
		ok(res.status === 403 || res.status === 401, `REST PUT should deny lowuser, got ${res.status}`);
	});

	test('REST anchor: lowuser DELETE admin row → 403 (cross-surface reference)', async () => {
		const res = await fetch(new URL(`/Doc/${ADMIN_ROW}`, appURL), {
			method: 'DELETE',
			headers: { Authorization: basicAuth(LOWUSER.username, LOWUSER.password) },
		});
		await res.body?.cancel();
		log(`REST DELETE admin row as lowuser: status=${res.status}`);
		recordFinding({
			op: 'REST DELETE admin row',
			principal: 'lowuser',
			allowed: false,
			persisted: 'n/a',
			verdict: res.status === 403 || res.status === 401 ? 'ENFORCED' : 'BYPASS',
			note: `HTTP ${res.status}`,
		});
		ok(res.status === 403 || res.status === 401, `REST DELETE should deny lowuser, got ${res.status}`);
	});

	// ── POSITIVE CONTROL: admin can do everything ─────────────────────────────

	test('Positive control: admin MCP create/update/delete persist (write wiring intact)', async () => {
		const ctrlId = 'qa408-ctrl-admin';

		const created = await call(admin.client, 'create_Doc', {
			id: ctrlId,
			owner: ctx.harper.admin.username,
			payload: 'ctrl',
		});
		log(`admin create_Doc: isError=${created.isError}`);
		ok(!created.isError, `admin create_Doc errored: ${resultText(created)}`);
		const afterCreate = await readDoc(ctx, ctrlId);
		ok(afterCreate != null, 'admin create_Doc must persist');
		recordFinding({
			op: 'MCP create_Doc (ctrl row)',
			principal: 'admin',
			allowed: true,
			persisted: afterCreate != null,
			verdict: afterCreate != null ? 'PASS' : 'FAIL',
		});

		const updated = await call(admin.client, 'update_Doc', {
			id: ctrlId,
			owner: ctx.harper.admin.username,
			payload: 'ctrl-updated',
		});
		log(`admin update_Doc: isError=${updated.isError}`);
		ok(!updated.isError, `admin update_Doc errored: ${resultText(updated)}`);
		const afterUpdate = await readDoc(ctx, ctrlId);
		strictEqual(afterUpdate?.payload, 'ctrl-updated', 'admin update_Doc must persist');
		recordFinding({
			op: 'MCP update_Doc (ctrl row)',
			principal: 'admin',
			allowed: true,
			persisted: afterUpdate?.payload === 'ctrl-updated',
			verdict: afterUpdate?.payload === 'ctrl-updated' ? 'PASS' : 'FAIL',
		});

		const deleted = await call(admin.client, 'delete_Doc', { id: ctrlId });
		log(`admin delete_Doc: isError=${deleted.isError}`);
		ok(!deleted.isError, `admin delete_Doc errored: ${resultText(deleted)}`);
		const afterDelete = await readDoc(ctx, ctrlId);
		strictEqual(afterDelete, null, 'admin delete_Doc must remove the row');
		recordFinding({
			op: 'MCP delete_Doc (ctrl row)',
			principal: 'admin',
			allowed: true,
			persisted: afterDelete == null,
			verdict: afterDelete == null ? 'PASS' : 'FAIL',
		});
	});

	// ── OWN-ROW CONTROLS: lowuser reads/writes its own row ────────────────────

	test('Own-row control: lowuser MCP get_Doc on own row returns the row', async () => {
		const result = await call(low.client, 'get_Doc', { id: LOWUSER_ROW });
		const text = resultText(result);
		log(`lowuser get_Doc own row: isError=${result.isError} hasPayload=${text.includes('lowuser')}`);
		ok(!result.isError, `lowuser get own row errored: ${text}`);
		ok(text.includes('lowuser'), `own row payload not returned: ${text}`);
		recordFinding({
			op: 'MCP get_Doc (own row)',
			principal: 'lowuser',
			allowed: true,
			persisted: 'n/a',
			verdict: 'PASS',
		});
	});

	test('Own-row control: lowuser MCP update_Doc on own row persists', async () => {
		const result = await call(low.client, 'update_Doc', {
			id: LOWUSER_ROW,
			owner: LOWUSER.username,
			payload: 'lowuser-self-updated',
		});
		log(`lowuser update_Doc own row: isError=${result.isError}`);
		ok(!result.isError, `lowuser update own row errored: ${resultText(result)}`);
		const afterUpdate = await readDoc(ctx, LOWUSER_ROW);
		strictEqual(afterUpdate?.payload, 'lowuser-self-updated', 'own-row update must persist');
		recordFinding({
			op: 'MCP update_Doc (own row)',
			principal: 'lowuser',
			allowed: true,
			persisted: afterUpdate?.payload === 'lowuser-self-updated',
			verdict: 'PASS',
		});
	});

	// ── F-092 READ ENFORCEMENT ─────────────────────────────────────────────────

	test('F-092 (read): lowuser MCP get_Doc on admin row is denied and leaks nothing', async () => {
		const result = await call(low.client, 'get_Doc', { id: ADMIN_ROW });
		const text = resultText(result);
		log(`F-092 get_Doc admin row: isError=${result.isError} text=${text.slice(0, 120)}`);
		const leaked = text.includes('admin-original');
		recordFinding({
			op: 'MCP get_Doc (admin row)',
			principal: 'lowuser',
			allowed: !result.isError,
			persisted: 'n/a',
			verdict: leaked ? 'BYPASS' : 'ENFORCED',
			note: leaked ? 'admin-original payload leaked — F-092 still open' : 'no leak',
		});
		ok(!leaked, `F-092 BYPASS: get_Doc leaked admin payload. isError=${result.isError} text=${text}`);
	});

	test('F-092 (read): lowuser MCP search_Doc does not leak admin-owned rows', async () => {
		const result = await call(low.client, 'search_Doc', {});
		const text = resultText(result);
		log(`F-092 search_Doc: isError=${result.isError} text=${text.slice(0, 200)}`);
		const leaked = text.includes('admin-original');
		recordFinding({
			op: 'MCP search_Doc',
			principal: 'lowuser',
			allowed: !result.isError,
			persisted: 'n/a',
			verdict: leaked ? 'BYPASS' : 'ENFORCED',
			note: leaked ? 'admin-original in search results — F-092 still open on search' : 'no leak',
		});
		// Note per Flair memory: search_Doc per-row allowRead filtering depends on #1422/#1489;
		// until that lands, search may error (isError=true) rather than filter. Either is
		// acceptable — the key requirement is that admin-original NOT appear in the response.
		ok(!leaked, `F-092 BYPASS: search_Doc returned admin row. isError=${result.isError} text=${text}`);
	});

	// ── F-093 WRITE ENFORCEMENT ───────────────────────────────────────────────

	test('F-093 (write): lowuser MCP update_Doc on admin row is denied and does not persist', async () => {
		const result = await call(low.client, 'update_Doc', {
			id: ADMIN_ROW,
			owner: ctx.harper.admin.username,
			payload: 'LOWUSER-OVERWRITE',
		});
		log(`F-093 update_Doc admin row: isError=${result.isError} text=${resultText(result).slice(0, 120)}`);
		const afterUpdate = await readDoc(ctx, ADMIN_ROW);
		const payloadChanged = afterUpdate?.payload === 'LOWUSER-OVERWRITE';
		const bypassed = !result.isError && payloadChanged;
		recordFinding({
			op: 'MCP update_Doc (admin row)',
			principal: 'lowuser',
			allowed: !result.isError,
			persisted: payloadChanged,
			verdict: bypassed ? 'BYPASS' : 'ENFORCED',
			note: bypassed
				? 'write persisted despite guard — F-093 still open'
				: `isError=${result.isError} payloadChanged=${payloadChanged}`,
		});
		ok(result.isError, `F-093 BYPASS: update_Doc on admin row did not return isError. text=${resultText(result)}`);
		ok(!payloadChanged, `F-093 BYPASS: update_Doc persisted on admin row (payload changed to LOWUSER-OVERWRITE)`);
	});

	test('F-093 (write): lowuser MCP delete_Doc on admin row is denied and does not persist', async () => {
		const result = await call(low.client, 'delete_Doc', { id: ADMIN_ROW });
		log(`F-093 delete_Doc admin row: isError=${result.isError} text=${resultText(result).slice(0, 120)}`);
		const afterDelete = await readDoc(ctx, ADMIN_ROW);
		const rowGone = afterDelete == null;
		const bypassed = !result.isError && rowGone;
		recordFinding({
			op: 'MCP delete_Doc (admin row)',
			principal: 'lowuser',
			allowed: !result.isError,
			persisted: rowGone,
			verdict: bypassed ? 'BYPASS' : 'ENFORCED',
			note: bypassed
				? 'row deleted despite guard — F-093 still open'
				: `isError=${result.isError} rowStillPresent=${afterDelete != null}`,
		});
		ok(result.isError, `F-093 BYPASS: delete_Doc on admin row did not return isError. text=${resultText(result)}`);
		ok(!rowGone, `F-093 BYPASS: delete_Doc removed admin row`);
	});

	test('F-093 (write): lowuser MCP create_Doc for admin-owned row is denied and does not persist', async () => {
		const result = await call(low.client, 'create_Doc', {
			id: LOWUSER_CREATE_ID,
			owner: ctx.harper.admin.username,
			payload: 'LOWUSER-CREATE-FOR-ADMIN',
		});
		log(`F-093 create_Doc (owned by admin): isError=${result.isError} text=${resultText(result).slice(0, 120)}`);
		const afterCreate = await readDoc(ctx, LOWUSER_CREATE_ID);
		const rowCreated = afterCreate != null;
		const bypassed = !result.isError && rowCreated;
		recordFinding({
			op: 'MCP create_Doc (owned by admin)',
			principal: 'lowuser',
			allowed: !result.isError,
			persisted: rowCreated,
			verdict: bypassed ? 'BYPASS' : 'ENFORCED',
			note: bypassed
				? 'row created despite guard — F-093 still open'
				: `isError=${result.isError} rowCreated=${rowCreated}`,
		});
		ok(
			result.isError,
			`F-093 BYPASS: create_Doc for admin-owned row did not return isError. text=${resultText(result)}`
		);
		ok(!rowCreated, `F-093 BYPASS: create_Doc inserted row despite allowCreate denial`);
	});
});
