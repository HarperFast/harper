import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-iterable-results');
const USER_PASS = 'TestPass123!';
const SECRET_CANARY = 'TOP-SECRET-VAULT-VALUE-999';
const RESTRICTED_NOTES_CANARY = 'RESTRICTED-NOTES-CANARY-777';

function basic(user: string, pass: string): string {
	return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function ops(
	ctx: ContextWithHarper,
	auth: string,
	body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'authorization': auth,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	return { status: res.status, body: parsed };
}

const sessionIds = new Map<string, string>();

async function ensureMcpSession(ctx: ContextWithHarper, auth: string): Promise<string> {
	const existing = sessionIds.get(auth);
	if (existing) return existing;
	const mcpUrl = new URL('/mcp', ctx.harper.operationsAPIURL).toString();
	const res = await fetch(mcpUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			'authorization': auth,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'mcp-iterable-test', version: '1.0.0' },
			},
		}),
	});
	const sessionId = res.headers.get('mcp-session-id');
	assert.ok(sessionId, `Expected Mcp-Session-Id header from initialize (status ${res.status})`);
	sessionIds.set(auth, sessionId);
	return sessionId;
}

async function mcpRpc(
	ctx: ContextWithHarper,
	auth: string,
	method: string,
	params: Record<string, unknown> = {}
): Promise<{ status: number; json: any; result: any; text: string; parsed: any }> {
	const sessionId = await ensureMcpSession(ctx, auth);
	const mcpUrl = new URL('/mcp', ctx.harper.operationsAPIURL).toString();
	const res = await fetch(mcpUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			'authorization': auth,
			'mcp-session-id': sessionId,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method,
			params,
		}),
	});
	const raw = await res.text();
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch {
		json = { raw };
	}
	const result = json?.result;
	const text = result?.content?.[0]?.text ?? '';
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	return { status: res.status, json, result, text, parsed };
}

async function mcpToolCall(ctx: ContextWithHarper, auth: string, name: string, args: Record<string, unknown> = {}) {
	return mcpRpc(ctx, auth, 'tools/call', { name, arguments: args });
}

suite('MCP operations profile: iterable results & search_by_conditions', (ctx: ContextWithHarper) => {
	let adminAuth: string;
	let readerAllowlistedAuth: string;
	let readerPlainAuth: string;
	let activeMetric = 'utilization';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				mcp: { operations: { mountPath: '/mcp' } },
				analytics: { aggregatePeriod: 1 },
			},
			env: {
				AUTHENTICATION_AUTHORIZELOCAL: 'false',
			},
		});

		adminAuth = basic(ctx.harper.admin.username, ctx.harper.admin.password);

		let tablesReady = false;
		const schemaDeadline = Date.now() + 15000;
		while (Date.now() < schemaDeadline) {
			const [pubDesc, secDesc] = await Promise.all([
				ops(ctx, adminAuth, { operation: 'describe_table', database: 'data', table: 'PublicNote' }),
				ops(ctx, adminAuth, { operation: 'describe_table', database: 'data', table: 'SecretVault' }),
			]);
			if (pubDesc.status === 200 && secDesc.status === 200) {
				tablesReady = true;
				break;
			}
			await delay(100);
		}
		assert.ok(tablesReady, 'Timed out waiting for PublicNote and SecretVault tables to register');

		const ct = await ops(ctx, adminAuth, {
			operation: 'create_table',
			database: 'data',
			table: 'AuditProbe',
			primary_key: 'id',
		});
		assert.strictEqual(ct.status, 200, `create_table AuditProbe failed: ${JSON.stringify(ct.body)}`);

		const insAudit = await ops(ctx, adminAuth, {
			operation: 'insert',
			database: 'data',
			table: 'AuditProbe',
			records: [
				{ id: 'row-1', label: 'alpha' },
				{ id: 'row-2', label: 'beta' },
				{ id: 'row-3', label: 'gamma' },
			],
		});
		assert.strictEqual(insAudit.status, 200, `insert AuditProbe failed: ${JSON.stringify(insAudit.body)}`);

		const updAudit = await ops(ctx, adminAuth, {
			operation: 'update',
			database: 'data',
			table: 'AuditProbe',
			records: [{ id: 'row-1', label: 'alpha-updated' }],
		});
		assert.strictEqual(updAudit.status, 200, `update AuditProbe failed: ${JSON.stringify(updAudit.body)}`);

		const insPub = await ops(ctx, adminAuth, {
			operation: 'insert',
			database: 'data',
			table: 'PublicNote',
			records: [
				{
					id: 'pub-1',
					title: 'welcome',
					notes: `alpha beta ${RESTRICTED_NOTES_CANARY} searchable fulltext token`,
					tag: 'greeting',
				},
				{
					id: 'pub-2',
					title: 'second',
					notes: `gamma delta ${RESTRICTED_NOTES_CANARY} searchable fulltext token`,
					tag: 'followup',
				},
			],
		});
		assert.strictEqual(insPub.status, 200, `insert PublicNote failed: ${JSON.stringify(insPub.body)}`);

		const insSec = await ops(ctx, adminAuth, {
			operation: 'insert',
			database: 'data',
			table: 'SecretVault',
			records: [
				{
					id: 'sec-1',
					secret: SECRET_CANARY,
					notes: `classified ${SECRET_CANARY} searchable fulltext token`,
				},
			],
		});
		assert.strictEqual(insSec.status, 200, `insert SecretVault failed: ${JSON.stringify(insSec.body)}`);

		const r1 = await ops(ctx, adminAuth, {
			operation: 'add_role',
			role: 'reader_allowlisted_role',
			permission: {
				super_user: false,
				operations: ['search_by_conditions', 'search_by_value'],
				data: {
					tables: {
						PublicNote: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [
								{ attribute_name: 'id', read: true, insert: false, update: false },
								{ attribute_name: 'title', read: true, insert: false, update: false },
								{ attribute_name: 'tag', read: true, insert: false, update: false },
								{ attribute_name: 'notes', read: false, insert: false, update: false },
							],
						},
						SecretVault: {
							read: false,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			},
		});
		assert.strictEqual(r1.status, 200, `add_role reader_allowlisted_role failed: ${JSON.stringify(r1.body)}`);

		const u1 = await ops(ctx, adminAuth, {
			operation: 'add_user',
			role: 'reader_allowlisted_role',
			username: 'reader_allowlisted',
			password: USER_PASS,
			active: true,
		});
		assert.strictEqual(u1.status, 200, `add_user reader_allowlisted failed: ${JSON.stringify(u1.body)}`);
		readerAllowlistedAuth = basic('reader_allowlisted', USER_PASS);

		const r2 = await ops(ctx, adminAuth, {
			operation: 'add_role',
			role: 'reader_plain_role',
			permission: {
				super_user: false,
				data: {
					tables: {
						PublicNote: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
						SecretVault: {
							read: false,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			},
		});
		assert.strictEqual(r2.status, 200, `add_role reader_plain_role failed: ${JSON.stringify(r2.body)}`);

		const u2 = await ops(ctx, adminAuth, {
			operation: 'add_user',
			role: 'reader_plain_role',
			username: 'reader_plain',
			password: USER_PASS,
			active: true,
		});
		assert.strictEqual(u2.status, 200, `add_user reader_plain failed: ${JSON.stringify(u2.body)}`);
		readerPlainAuth = basic('reader_plain', USER_PASS);

		let ftReady = false;
		const ftDeadline = Date.now() + 15000;
		while (Date.now() < ftDeadline) {
			const desc = await ops(ctx, adminAuth, {
				operation: 'describe_table',
				database: 'data',
				table: 'PublicNote',
			});
			if (desc.body?.full_text_indexes?.[0]?.readiness?.state === 'ready') {
				ftReady = true;
				break;
			}
			await delay(100);
		}
		assert.ok(ftReady, 'Timed out waiting for PublicNote @fullText index to reach ready state');

		for (let i = 0; i < 3; i++) {
			await fetch(`${ctx.harper.httpURL}/health`).catch(() => {});
		}
		const storageSizeFastPathMetrics = new Set(['database-size', 'table-size']);
		const candidateMetrics = ['utilization', 'main-thread-utilization', 'event-loop-delay', 'resource-usage'];
		let analyticsReady = false;
		const deadline = Date.now() + 15000;
		outer: while (Date.now() < deadline) {
			const listRes = await ops(ctx, adminAuth, { operation: 'list_metrics' });
			const fromList = Array.isArray(listRes.body)
				? listRes.body
						.map((m: any) => (typeof m === 'string' ? m : m?.metric))
						.filter((m: any) => Boolean(m) && !storageSizeFastPathMetrics.has(m))
				: [];
			for (const candidate of [...fromList, ...candidateMetrics]) {
				const check = await ops(ctx, adminAuth, { operation: 'get_analytics', metric: candidate });
				if (check.status === 200 && Array.isArray(check.body) && check.body.length > 0) {
					activeMetric = candidate;
					analyticsReady = true;
					break outer;
				}
			}
			await delay(250);
		}
		assert.ok(analyticsReady, 'Timed out waiting for a non-storage-size analytics metric to flush');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('A1: get_analytics over MCP resolves async-mapped metric elements matching HTTP POST /', async () => {
		const httpRes = await ops(ctx, adminAuth, { operation: 'get_analytics', metric: activeMetric });
		assert.strictEqual(
			httpRes.status,
			200,
			`HTTP get_analytics(${activeMetric}) failed: ${JSON.stringify(httpRes.body)}`
		);
		assert.ok(Array.isArray(httpRes.body), `HTTP get_analytics should return array: ${JSON.stringify(httpRes.body)}`);
		assert.ok(httpRes.body.length >= 1, `HTTP get_analytics should have >=1 metric: ${JSON.stringify(httpRes.body)}`);
		const firstHttp = httpRes.body[0];
		assert.strictEqual(
			typeof firstHttp.metric,
			'string',
			`HTTP metric entry must have string 'metric': ${JSON.stringify(firstHttp)}`
		);
		assert.strictEqual(
			typeof firstHttp.id,
			'number',
			`HTTP metric entry must have numeric timestamp 'id': ${JSON.stringify(firstHttp)}`
		);

		const mcpRes = await mcpToolCall(ctx, adminAuth, 'get_analytics', { metric: activeMetric });
		assert.strictEqual(mcpRes.status, 200);
		assert.ok(!mcpRes.result?.isError, `MCP get_analytics returned isError: ${mcpRes.text}`);
		assert.ok(Array.isArray(mcpRes.parsed), `MCP get_analytics content must parse to an array, got: ${mcpRes.text}`);
		assert.ok(
			mcpRes.parsed.length >= 1,
			`MCP get_analytics must return >=1 entry (HTTP had ${httpRes.body.length}), got: ${mcpRes.text}`
		);
		for (const [idx, entry] of mcpRes.parsed.entries()) {
			assert.strictEqual(
				typeof entry?.metric,
				'string',
				`MCP get_analytics entry[${idx}] must have resolved string 'metric' (not unawaited Promise '{}'): ${JSON.stringify(entry)}`
			);
			assert.strictEqual(
				typeof entry?.id,
				'number',
				`MCP get_analytics entry[${idx}] must have numeric timestamp 'id': ${JSON.stringify(entry)}`
			);
			assert.strictEqual(
				typeof entry?.node,
				'string',
				`MCP get_analytics entry[${idx}] must have resolved 'node' string: ${JSON.stringify(entry)}`
			);
		}
		assert.ok(
			Array.isArray(mcpRes.result?.structuredContent?.results),
			`MCP get_analytics must populate structuredContent.results`
		);
	});

	test('A2: read_audit_log default and timestamp branches drain AsyncGenerator over MCP matching HTTP POST /', async () => {
		const httpDefault = await ops(ctx, adminAuth, {
			operation: 'read_audit_log',
			database: 'data',
			table: 'AuditProbe',
		});
		assert.strictEqual(httpDefault.status, 200);
		assert.ok(Array.isArray(httpDefault.body) && httpDefault.body.length >= 2);

		const mcpDefault = await mcpToolCall(ctx, adminAuth, 'read_audit_log', {
			database: 'data',
			table: 'AuditProbe',
		});
		assert.strictEqual(mcpDefault.status, 200);
		assert.ok(!mcpDefault.result?.isError, `MCP read_audit_log (default) returned isError: ${mcpDefault.text}`);
		assert.ok(
			Array.isArray(mcpDefault.parsed),
			`MCP read_audit_log (default) must return a JSON array (not '{}' from uncollected AsyncGenerator), got: ${mcpDefault.text}`
		);
		assert.strictEqual(
			mcpDefault.parsed.length,
			httpDefault.body.length,
			`MCP read_audit_log (default) entry count must match HTTP POST / (${httpDefault.body.length}), got: ${mcpDefault.text}`
		);
		assert.deepStrictEqual(mcpDefault.parsed, httpDefault.body);

		const httpTs = await ops(ctx, adminAuth, {
			operation: 'read_audit_log',
			database: 'data',
			table: 'AuditProbe',
			search_type: 'timestamp',
			search_values: [0],
		});
		assert.strictEqual(httpTs.status, 200);
		assert.ok(Array.isArray(httpTs.body) && httpTs.body.length >= 2);

		const mcpTs = await mcpToolCall(ctx, adminAuth, 'read_audit_log', {
			database: 'data',
			table: 'AuditProbe',
			search_type: 'timestamp',
			search_values: [0],
		});
		assert.strictEqual(mcpTs.status, 200);
		assert.ok(!mcpTs.result?.isError, `MCP read_audit_log (timestamp) returned isError: ${mcpTs.text}`);
		assert.ok(
			Array.isArray(mcpTs.parsed),
			`MCP read_audit_log (timestamp) must return a JSON array (not '{}'), got: ${mcpTs.text}`
		);
		assert.deepStrictEqual(mcpTs.parsed, httpTs.body);
	});

	test('A2b: read_audit_log username and hash_value branches return identical keyed objects over HTTP and MCP', async () => {
		const httpByUser = await ops(ctx, adminAuth, {
			operation: 'read_audit_log',
			database: 'data',
			table: 'AuditProbe',
			search_type: 'username',
			search_values: [ctx.harper.admin.username],
		});
		assert.strictEqual(httpByUser.status, 200);
		assert.ok(typeof httpByUser.body === 'object' && httpByUser.body !== null && !Array.isArray(httpByUser.body));

		const mcpByUser = await mcpToolCall(ctx, adminAuth, 'read_audit_log', {
			database: 'data',
			table: 'AuditProbe',
			search_type: 'username',
			search_values: [ctx.harper.admin.username],
		});
		assert.strictEqual(mcpByUser.status, 200);
		assert.ok(!mcpByUser.result?.isError);
		assert.deepStrictEqual(mcpByUser.parsed, httpByUser.body);

		const httpByHash = await ops(ctx, adminAuth, {
			operation: 'read_audit_log',
			database: 'data',
			table: 'AuditProbe',
			search_type: 'hash_value',
			search_values: ['row-1'],
		});
		assert.strictEqual(httpByHash.status, 200);
		assert.ok(
			typeof httpByHash.body === 'object' &&
				httpByHash.body !== null &&
				Array.isArray(httpByHash.body['row-1']) &&
				httpByHash.body['row-1'].length >= 2
		);

		const mcpByHash = await mcpToolCall(ctx, adminAuth, 'read_audit_log', {
			database: 'data',
			table: 'AuditProbe',
			search_type: 'hash_value',
			search_values: ['row-1'],
		});
		assert.strictEqual(mcpByHash.status, 200);
		assert.ok(!mcpByHash.result?.isError);
		assert.deepStrictEqual(mcpByHash.parsed, httpByHash.body);
	});

	test('A3: search_by_conditions on AuditProbe returns matching rows over HTTP and MCP', async () => {
		const query = {
			database: 'data',
			table: 'AuditProbe',
			get_attributes: ['id', 'label'],
			conditions: [{ search_attribute: 'id', search_type: 'equals', search_value: 'row-2' }],
		};
		const httpRes = await ops(ctx, adminAuth, { operation: 'search_by_conditions', ...query });
		assert.strictEqual(httpRes.status, 200);
		assert.deepStrictEqual(httpRes.body, [{ id: 'row-2', label: 'beta' }]);

		const mcpRes = await mcpToolCall(ctx, adminAuth, 'search_by_conditions', query);
		assert.strictEqual(mcpRes.status, 200);
		assert.ok(!mcpRes.result?.isError, `MCP search_by_conditions failed: ${mcpRes.text}`);
		assert.deepStrictEqual(mcpRes.parsed, [{ id: 'row-2', label: 'beta' }]);
	});

	test('A4: list_metrics returns identical array over HTTP and MCP', async () => {
		const httpRes = await ops(ctx, adminAuth, { operation: 'list_metrics' });
		assert.strictEqual(httpRes.status, 200);
		assert.ok(Array.isArray(httpRes.body));

		const mcpRes = await mcpToolCall(ctx, adminAuth, 'list_metrics', {});
		assert.strictEqual(mcpRes.status, 200);
		assert.ok(!mcpRes.result?.isError, `MCP list_metrics failed: ${mcpRes.text}`);
		assert.deepStrictEqual(mcpRes.parsed, httpRes.body);
	});

	test('A5: search_by_id over MCP drains getRecords async iterable matching HTTP POST /', async () => {
		const query = {
			database: 'data',
			table: 'AuditProbe',
			ids: ['row-1', 'row-2'],
			get_attributes: ['id', 'label'],
		};
		const httpRes = await ops(ctx, adminAuth, { operation: 'search_by_id', ...query });
		assert.strictEqual(httpRes.status, 200);
		assert.deepStrictEqual(httpRes.body, [
			{ id: 'row-1', label: 'alpha-updated' },
			{ id: 'row-2', label: 'beta' },
		]);

		const mcpRes = await mcpToolCall(ctx, adminAuth, 'search_by_id', query);
		assert.strictEqual(mcpRes.status, 200);
		assert.ok(!mcpRes.result?.isError, `MCP search_by_id returned isError: ${mcpRes.text}`);
		assert.deepStrictEqual(mcpRes.parsed, httpRes.body);
	});

	test('M0: search_by_conditions over MCP with indexed equals condition returns matching rows', async () => {
		const adminRes = await mcpToolCall(ctx, adminAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['id', 'title'],
			conditions: [{ search_attribute: 'title', search_type: 'equals', search_value: 'welcome' }],
		});
		assert.strictEqual(adminRes.status, 200);
		assert.ok(!adminRes.result?.isError, `Admin MCP search_by_conditions failed: ${adminRes.text}`);
		assert.deepStrictEqual(adminRes.parsed, [{ id: 'pub-1', title: 'welcome' }]);

		const userRes = await mcpToolCall(ctx, readerAllowlistedAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['id', 'title'],
			conditions: [{ search_attribute: 'title', search_type: 'equals', search_value: 'welcome' }],
		});
		assert.strictEqual(userRes.status, 200);
		assert.ok(!userRes.result?.isError, `Scoped role MCP search_by_conditions failed: ${userRes.text}`);
		assert.deepStrictEqual(userRes.parsed, [{ id: 'pub-1', title: 'welcome' }]);
	});

	test('M0b: search_by_conditions over MCP with full-text matches condition drains async ExtendedIterable', async () => {
		const fullTextCondition = {
			search_attribute: 'titleSearch',
			search_type: 'matches',
			search_value: 'welcome',
			waitForIndexMilliseconds: 2000,
		};
		const adminRes = await mcpToolCall(ctx, adminAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['id', 'title'],
			conditions: [fullTextCondition],
		});
		assert.strictEqual(adminRes.status, 200);
		assert.ok(
			!adminRes.result?.isError,
			`Admin MCP full-text search_by_conditions failed (unawaited ExtendedIterable): ${adminRes.text}`
		);
		assert.deepStrictEqual(adminRes.parsed, [{ id: 'pub-1', title: 'welcome' }]);

		const userRes = await mcpToolCall(ctx, readerPlainAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['id', 'title'],
			conditions: [fullTextCondition],
		});
		assert.strictEqual(userRes.status, 200);
		assert.ok(!userRes.result?.isError, `Scoped role MCP full-text search_by_conditions failed: ${userRes.text}`);
		assert.deepStrictEqual(userRes.parsed, [{ id: 'pub-1', title: 'welcome' }]);
	});

	test('M0c: search_by_conditions over MCP with non-indexed condition returns matching rows for table-perm role', async () => {
		const userRes = await mcpToolCall(ctx, readerPlainAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['id', 'title', 'tag'],
			conditions: [{ search_attribute: 'tag', search_type: 'equals', search_value: 'greeting' }],
		});
		assert.strictEqual(userRes.status, 200);
		assert.ok(!userRes.result?.isError, `Plain role MCP search_by_conditions failed: ${userRes.text}`);
		assert.deepStrictEqual(userRes.parsed, [{ id: 'pub-1', title: 'welcome', tag: 'greeting' }]);
	});

	test('M1: tools/list includes search_by_conditions for a role whose operations allowlist grants it', async () => {
		const listAllow = await mcpRpc(ctx, readerAllowlistedAuth, 'tools/list', {});
		assert.strictEqual(listAllow.status, 200);
		const allowNames = (listAllow.result?.tools ?? []).map((t: any) => t.name);
		assert.ok(
			allowNames.includes('search_by_conditions'),
			`tools/list for allowlisted role should include search_by_conditions, got: ${JSON.stringify(allowNames)}`
		);
	});

	test('M2: search_by_conditions over MCP denies reading an unauthorized table (SecretVault)', async () => {
		for (const [label, auth] of [
			['reader_allowlisted', readerAllowlistedAuth],
			['reader_plain', readerPlainAuth],
		] as const) {
			const res = await mcpToolCall(ctx, auth, 'search_by_conditions', {
				database: 'data',
				table: 'SecretVault',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'id', search_type: 'equals', search_value: 'sec-1' }],
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(
				res.result?.isError,
				true,
				`${label} must be denied on SecretVault over MCP, got: ${JSON.stringify(res.result)}`
			);
			assert.ok(
				!JSON.stringify(res.json).includes(SECRET_CANARY),
				`Secret canary leaked to ${label}: ${JSON.stringify(res.json)}`
			);
		}
	});

	test('M3: search_by_conditions over MCP denies reading or filtering on a restricted attribute', async () => {
		const starRes = await mcpToolCall(ctx, readerAllowlistedAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['*'],
			conditions: [{ search_attribute: 'title', search_type: 'equals', search_value: 'welcome' }],
		});
		assert.strictEqual(starRes.status, 200);
		assert.ok(
			!starRes.result?.isError,
			`Wildcard get_attributes:['*'] should filter to readable attributes: ${starRes.text}`
		);
		assert.deepStrictEqual(starRes.parsed, [{ id: 'pub-1', title: 'welcome', tag: 'greeting' }]);
		assert.ok(
			!JSON.stringify(starRes.json).includes(RESTRICTED_NOTES_CANARY),
			`Restricted attribute 'notes' leaked via get_attributes:['*']: ${JSON.stringify(starRes.json)}`
		);

		const explicitRes = await mcpToolCall(ctx, readerAllowlistedAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['id', 'notes'],
			conditions: [{ search_attribute: 'title', search_type: 'equals', search_value: 'welcome' }],
		});
		assert.strictEqual(explicitRes.status, 200);
		assert.strictEqual(
			explicitRes.result?.isError,
			true,
			`Explicit read of restricted attribute 'notes' must return isError:true: ${JSON.stringify(explicitRes.result)}`
		);
		assert.ok(
			!JSON.stringify(explicitRes.json).includes(RESTRICTED_NOTES_CANARY),
			`Restricted attribute 'notes' leaked via explicit get_attributes: ${JSON.stringify(explicitRes.json)}`
		);

		const condRes = await mcpToolCall(ctx, readerAllowlistedAuth, 'search_by_conditions', {
			database: 'data',
			table: 'PublicNote',
			get_attributes: ['id', 'title'],
			conditions: [{ search_attribute: 'notes', search_type: 'contains', search_value: 'CANARY' }],
		});
		assert.strictEqual(condRes.status, 200);
		assert.strictEqual(
			condRes.result?.isError,
			true,
			`Condition on restricted attribute 'notes' must return isError:true: ${JSON.stringify(condRes.result)}`
		);
	});
});
