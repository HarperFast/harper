/**
 * encrypted_operation: a sealed operation is authorized exactly as the same operation sent directly.
 * Contract: docs/reference/operations-api/operations.md, "Encrypted Operations" -> "Authorization":
 * "The sealed operation runs as the user who sent encrypted_operation and is authorized exactly as if
 * that user had sent it directly. A role with an operations allowlist, or a scoped token, must allow both."
 *
 * Oracle: for each principal x inner operation, the DIRECT answer (status + normalized body) must equal
 * the answer opened from the SEALED reply, in both modes. Controls: authorizeLocal is off (credential-less
 * -> 401); the matrix holds both 200-with-data and 403 cells per restricted principal; a cross-principal
 * comparison must be UNEQUAL (the comparator can see a widening).
 *
 * Its own instance: encrypted-operation.test.ts relies on the operations socket's bypass, this file
 * needs authorizeLocal off.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, notDeepStrictEqual, ok, strictEqual } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';
import { openResponse, sealOperation } from '../../dist/utility/sealedOperation.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/encrypted-operation');
const OPEN = 'ParityOpen';
const CLOSED = 'ParityClosed';
const READER_ROLE = 'parity_reader_role';
const READER = { username: 'parity_reader', password: 'Parity-reader-pw-1!' };
const TABLE_PERMS = {
	[OPEN]: {
		read: true,
		insert: false,
		update: false,
		delete: false,
		// an attribute_permissions list is exhaustive: an unlisted attribute is denied
		attribute_permissions: [
			{ attribute_name: 'name', read: true, insert: false, update: false },
			{ attribute_name: 'secret', read: false, insert: false, update: false },
		],
	},
	[CLOSED]: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] },
};
const VOLATILE_KEYS = new Set([
	'record_count',
	'table_size',
	'db_size',
	'db_audit_size',
	'last_updated_record',
	'estimated_record_range',
	'audit_size',
]);

function tokenView(body: any) {
	const token = body?.operation_token;
	const claims =
		typeof token === 'string' ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) : undefined;
	return {
		keys: Object.keys(body ?? {}).sort(),
		username: claims?.username,
		super_user: claims?.super_user,
		error: body?.error,
	};
}

function normalize(value: any): any {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === 'object') {
		const out: Record<string, any> = {};
		for (const key of Object.keys(value).sort()) if (!VOLATILE_KEYS.has(key)) out[key] = normalize(value[key]);
		return out;
	}
	return value;
}

interface Cell {
	name: string;
	op: Record<string, any>;
	/** compare status and top-level key set only (volatile payload) */
	shapeOnly?: boolean;
	/** compare status, key set and the `username` claim of the minted operation token */
	tokenOwner?: boolean;
}

const CELLS: Cell[] = [
	{
		name: 'sbv-star',
		op: {
			operation: 'search_by_value',
			database: 'data',
			table: OPEN,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['*'],
		},
	},
	{
		name: 'sbv-secret',
		op: {
			operation: 'search_by_value',
			database: 'data',
			table: OPEN,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'secret'],
		},
	},
	{
		name: 'sbv-by-secret',
		op: {
			operation: 'search_by_value',
			database: 'data',
			table: OPEN,
			search_attribute: 'secret',
			search_value: 'open-secret-1',
			get_attributes: ['id'],
		},
	},
	{
		name: 'sbc-secret-cond',
		op: {
			operation: 'search_by_conditions',
			database: 'data',
			table: OPEN,
			get_attributes: ['id'],
			conditions: [{ search_attribute: 'secret', search_type: 'equals', search_value: 'open-secret-1' }],
		},
	},
	{
		name: 'sbid-closed',
		op: { operation: 'search_by_id', database: 'data', table: CLOSED, ids: ['c1'], get_attributes: ['*'] },
	},
	{ name: 'sql-star', op: { operation: 'sql', sql: `SELECT * FROM data.${OPEN} ORDER BY id` } },
	{ name: 'sql-secret', op: { operation: 'sql', sql: `SELECT id, secret FROM data.${OPEN} ORDER BY id` } },
	{
		name: 'sql-where-secret',
		op: { operation: 'sql', sql: `SELECT id FROM data.${OPEN} WHERE secret = 'open-secret-1'` },
	},
	{
		name: 'sql-secret-supplied-ast',
		op: {
			operation: 'sql',
			sql: `SELECT id, secret FROM data.${OPEN} ORDER BY id`,
			parsed_sql_object: { permissions_checked: true },
		},
	},
	{ name: 'sql-closed', op: { operation: 'sql', sql: `SELECT * FROM data.${CLOSED}` } },
	{
		name: 'sql-update-secret',
		op: { operation: 'sql', sql: `UPDATE data.${OPEN} SET secret = 'open-secret-1' WHERE id = 'o1'` },
	},
	{
		name: 'upsert-open',
		op: {
			operation: 'upsert',
			database: 'data',
			table: OPEN,
			records: [{ id: 'o1', name: 'one', secret: 'open-secret-1' }],
		},
	},
	{
		name: 'update-open-name',
		op: { operation: 'update', database: 'data', table: OPEN, records: [{ id: 'o1', name: 'one' }] },
	},
	{ name: 'delete-missing', op: { operation: 'delete', database: 'data', table: OPEN, ids: ['no-such-row'] } },
	{ name: 'describe-all', op: { operation: 'describe_all' } },
	{ name: 'describe-closed', op: { operation: 'describe_table', database: 'data', table: CLOSED } },
	{ name: 'describe-open', op: { operation: 'describe_table', database: 'data', table: OPEN } },
	{ name: 'list-users', op: { operation: 'list_users' }, shapeOnly: true },
	{ name: 'list-roles', op: { operation: 'list_roles' }, shapeOnly: true },
	{ name: 'user-info', op: { operation: 'user_info' } },
	{ name: 'get-configuration', op: { operation: 'get_configuration' }, shapeOnly: true },
	{ name: 'read-log', op: { operation: 'read_log', limit: 1 }, shapeOnly: true },
	{ name: 'system-information', op: { operation: 'system_information', attributes: ['system'] }, shapeOnly: true },
	{ name: 'get-job-missing', op: { operation: 'get_job', id: 'parity-no-such-job' } },
	{ name: 'unknown-op', op: { operation: 'parity_no_such_operation' } },
	{ name: 'drop-table-missing', op: { operation: 'drop_table', database: 'data', table: 'ParityNoSuchTable' } },
	{ name: 'add-role-invalid', op: { operation: 'add_role', role: READER_ROLE, permission: { super_user: false } } },
	{ name: 'list-secrets', op: { operation: 'list_secrets' }, shapeOnly: true },
	{ name: 'tokens-self', op: { operation: 'create_authentication_tokens' }, tokenOwner: true },
	{
		name: 'tokens-reader-password',
		op: { operation: 'create_authentication_tokens', username: READER.username, password: READER.password },
		tokenOwner: true,
	},
	{
		name: 'tokens-wrong-password',
		op: { operation: 'create_authentication_tokens', username: READER.username, password: 'not-the-password' },
	},
	{
		name: 'tokens-inline-role',
		op: {
			operation: 'create_authentication_tokens',
			role: { permission: { super_user: false, data: { tables: TABLE_PERMS } } },
		},
		tokenOwner: true,
	},
];

interface Principal {
	name: string;
	headers: () => Record<string, string>;
	/** added to the DIRECT body and to the OUTER sealed body */
	outer?: Record<string, any>;
}

suite('encrypted_operation authorizes a sealed operation as the direct one', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let publicKey: string;
	let kid: string;
	let scopedToken: string;
	let wrapperOnlyToken: string;
	let innerOnlyToken: string;
	let mintScopedToken: string;
	const results: any[] = [];
	const json = { 'Content-Type': 'application/json', 'Connection': 'close' };

	const principals: Principal[] = [
		{ name: 'super_user', headers: () => client.headers },
		{ name: 'reader-basic', headers: () => createHeaders(READER.username, READER.password) },
		{ name: 'scoped-token', headers: () => ({ ...json, Authorization: `Bearer ${scopedToken}` }) },
		{
			name: 'su-impersonating-reader',
			headers: () => client.headers,
			outer: { impersonate: { username: READER.username } },
		},
	];

	async function direct(p: Principal, op: Record<string, any>) {
		const response = await client.reqAs(p.headers()).send({ ...structuredClone(op), ...p.outer });
		return { status: response.status, body: response.body };
	}

	async function sealed(p: Principal, op: Record<string, any>, options: Record<string, unknown> = {}) {
		const { request, responseKey, nonce } = sealOperation({
			op: structuredClone(op) as any,
			publicKey,
			kid,
			...options,
		});
		const response = await client.reqAs(p.headers()).send({ ...request, ...p.outer });
		if (!response.body?.encrypted_response) return { outerStatus: response.status, plaintext: response.body };
		const opened = openResponse(response.body.encrypted_response, responseKey, nonce);
		return {
			outerStatus: response.status,
			status: opened.status,
			body: opened.body,
			executed: (opened as any).executed,
		};
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { logging: { level: 'info' }, authentication: { authorizeLocal: false } },
			env: {
				AUTHENTICATION_AUTHORIZELOCAL: 'false',
				HARPER_BUILTIN_COMPONENTS:
					'encryptedOperationTestCustody=@/integrationTests/security/fixtures/encrypted-operation/registerCustody.js',
			},
		});
		client = createApiClient(ctx.harper);
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const keyResponse = await client.req().send({ operation: 'get_secrets_public_key' });
			if (keyResponse.status === 200 && keyResponse.body?.fingerprint) {
				publicKey = keyResponse.body.public_key;
				kid = keyResponse.body.fingerprint;
				break;
			}
			await sleep(250);
		}
		ok(publicKey, 'the test custody never registered');
		for (const table of [OPEN, CLOSED]) {
			await client.req().send({ operation: 'create_table', database: 'data', table, primary_key: 'id' }).expect(200);
		}
		await client
			.req()
			.send({
				operation: 'upsert',
				database: 'data',
				table: OPEN,
				records: [
					{ id: 'o1', name: 'one', secret: 'open-secret-1' },
					{ id: 'o2', name: 'two', secret: 'open-secret-2' },
				],
			})
			.expect(200);
		await client
			.req()
			.send({
				operation: 'upsert',
				database: 'data',
				table: CLOSED,
				records: [{ id: 'c1', name: 'closed', secret: 'closed-secret-1' }],
			})
			.expect(200);
		const roleResponse = await client.req().send({
			operation: 'add_role',
			role: READER_ROLE,
			permission: { super_user: false, data: { tables: TABLE_PERMS } },
		});
		strictEqual(roleResponse.status, 200, JSON.stringify(roleResponse.body));
		await client
			.req()
			.send({
				operation: 'add_user',
				role: READER_ROLE,
				username: READER.username,
				password: READER.password,
				active: true,
			})
			.expect(200);
		const mint = async (permission: Record<string, any>) => {
			const response = await client.req().send({ operation: 'create_authentication_tokens', role: { permission } });
			strictEqual(response.status, 200, JSON.stringify(response.body));
			ok(response.body.operation_token, JSON.stringify(response.body));
			return response.body.operation_token as string;
		};
		scopedToken = await mint({ super_user: false, data: { tables: TABLE_PERMS } });
		wrapperOnlyToken = await mint({
			super_user: false,
			operations: ['encrypted_operation'],
			data: { tables: TABLE_PERMS },
		});
		mintScopedToken = await mint({
			super_user: false,
			operations: ['encrypted_operation', 'create_authentication_tokens'],
			data: { tables: TABLE_PERMS },
		});
		innerOnlyToken = await mint({ super_user: false, operations: ['search_by_value'], data: { tables: TABLE_PERMS } });
	});

	after(async () => {
		if (process.env.PARITY_MATRIX_DIR) {
			writeFileSync(join(process.env.PARITY_MATRIX_DIR, `matrix-${Date.now()}.json`), JSON.stringify(results, null, 1));
		}
		await teardownHarper(ctx);
	});

	test('precondition: no credentials is 401 on the direct and the sealed path', async () => {
		const bare = await client.reqAs(json).send({ operation: 'user_info' });
		strictEqual(bare.status, 401, JSON.stringify(bare.body));
		const { request } = sealOperation({ op: { operation: 'user_info' }, publicKey, kid });
		const sealedBare = await client.reqAs(json).send(request);
		strictEqual(sealedBare.status, 401, JSON.stringify(sealedBare.body));
	});

	for (const mode of ['sealed', 'fields'] as const) {
		test(`parity matrix, ${mode} mode`, async () => {
			const mismatches: string[] = [];
			const statusByCell: Record<string, Record<string, number>> = {};
			for (const p of principals) {
				for (const cell of CELLS) {
					const d = await direct(p, cell.op);
					const s = await sealed(p, cell.op, { mode });
					results.push({ mode, principal: p.name, cell: cell.name, direct: d, sealed: s });
					(statusByCell[cell.name] ??= {})[p.name] = d.status;
					const label = `${mode}/${p.name}/${cell.name}`;
					if (s.outerStatus !== 200 || s.status === undefined) {
						mismatches.push(
							`${label}: sealed answered in plaintext ${s.outerStatus} ${JSON.stringify(s.plaintext)}; direct ${d.status}`
						);
						continue;
					}
					if (s.status !== d.status) {
						mismatches.push(
							`${label}: status direct ${d.status} sealed ${s.status} | direct ${JSON.stringify(d.body).slice(0, 300)} | sealed ${JSON.stringify(s.body).slice(0, 300)}`
						);
						continue;
					}
					const [left, right] = cell.tokenOwner
						? [tokenView(d.body), tokenView(s.body)]
						: cell.shapeOnly
							? [Object.keys(d.body ?? {}).sort(), Object.keys(s.body ?? {}).sort()]
							: [normalize(d.body), normalize(s.body)];
					try {
						deepStrictEqual(right, left);
					} catch {
						mismatches.push(
							`${label}: body differs | direct ${JSON.stringify(left).slice(0, 400)} | sealed ${JSON.stringify(right).slice(0, 400)}`
						);
					}
				}
			}
			// The matrix discriminates: the restricted principals are refused where the super user is served.
			strictEqual(statusByCell['sbv-secret'].super_user, 200);
			strictEqual(statusByCell['sbv-star'].super_user, 200);
			for (const name of ['reader-basic', 'scoped-token', 'su-impersonating-reader']) {
				strictEqual(statusByCell['sbv-star'][name], 200, `${name} sbv-star`);
				strictEqual(statusByCell['sbv-secret'][name], 403, `${name} sbv-secret`);
				strictEqual(statusByCell['sbid-closed'][name], 403, `${name} sbid-closed`);
				strictEqual(statusByCell['list-users'][name], 403, `${name} list-users`);
			}
			deepStrictEqual(mismatches, [], `\n${mismatches.join('\n')}`);
		});
	}

	test('control: the comparator sees a widening (sealed as super user vs direct as reader)', async () => {
		const cell = CELLS.find((c) => c.name === 'sbv-secret');
		const d = await direct(principals[1], cell.op);
		const s = await sealed(principals[0], cell.op);
		strictEqual(s.status, 200);
		strictEqual(d.status, 403);
		notDeepStrictEqual(normalize(s.body), normalize(d.body));
		ok(JSON.stringify(s.body).includes('open-secret-1'));
		ok(!JSON.stringify(d.body).includes('open-secret-1'));
	});

	test('restricted principals never receive the denied attribute or table through the sealed path', async () => {
		for (const p of principals.slice(1)) {
			for (const cell of CELLS) {
				for (const mode of ['sealed', 'fields'] as const) {
					if (cell.name === 'upsert-open' || cell.name === 'sql-update-secret') continue; // request echoes
					const s = await sealed(p, cell.op, { mode });
					const text = JSON.stringify(s);
					ok(!text.includes('open-secret-2'), `${p.name}/${cell.name}/${mode} returned a denied attribute value`);
					ok(!text.includes('closed-secret-1'), `${p.name}/${cell.name}/${mode} returned a denied table's row`);
				}
			}
		}
	});

	test('a scoped token must allow both the wrapper and the sealed operation', async () => {
		const op = CELLS[0].op;
		const wrapperOnly: Principal = {
			name: 'wrapper-only',
			headers: () => ({ ...json, Authorization: `Bearer ${wrapperOnlyToken}` }),
		};
		const innerOnly: Principal = {
			name: 'inner-only',
			headers: () => ({ ...json, Authorization: `Bearer ${innerOnlyToken}` }),
		};
		const dWrapper = await direct(wrapperOnly, op);
		const sWrapper = await sealed(wrapperOnly, op);
		const dInner = await direct(innerOnly, op);
		const sInner = await sealed(innerOnly, op);
		results.push({ arm: 'allowlist', dWrapper, sWrapper, dInner, sInner });
		strictEqual(dInner.status, 200, 'positive control: the inner-only token runs the operation directly');
		strictEqual(dWrapper.status, 403, JSON.stringify(dWrapper.body));
		strictEqual(sWrapper.status, 403, JSON.stringify(sWrapper));
		ok(sInner.outerStatus === 403 || sInner.status === 403, JSON.stringify(sInner));
		ok(!JSON.stringify(sInner).includes('"name":"one"'), 'an inner-only token read rows through the wrapper');
		ok(!JSON.stringify(sWrapper).includes('"name":"one"'), 'a wrapper-only token read rows through the wrapper');
	});

	test('create_authentication_tokens with body credentials answers the same sealed as direct for operation-allowlisted tokens', async () => {
		// Direct, the body credentials are the authentication (NO_AUTH_OPERATIONS) and no operations allowlist
		// applies. Measured on 51a24bb3a: sealed answers the same, for a token that lists the operation and
		// for one that lists only the wrapper.
		const op = { operation: 'create_authentication_tokens', username: READER.username, password: READER.password };
		for (const [name, token] of [
			['mint-scoped', mintScopedToken],
			['wrapper-only', wrapperOnlyToken],
		] as const) {
			const p: Principal = { name, headers: () => ({ ...json, Authorization: `Bearer ${token}` }) };
			const d = await direct(p, op);
			const s = await sealed(p, op);
			results.push({
				arm: 'token-mint-allowlisted',
				principal: name,
				direct: { status: d.status, view: tokenView(d.body) },
				sealed: { status: s.status, view: tokenView(s.body) },
			});
			strictEqual(d.status, 200, `${name}: ${JSON.stringify(d.body)}`);
			strictEqual(s.status, d.status, `${name}: ${JSON.stringify(s.body)}`);
			deepStrictEqual(tokenView(s.body), tokenView(d.body), name);
			strictEqual(tokenView(s.body).username, READER.username, name);
			const wrong = await sealed(p, { ...op, password: 'not-the-password' });
			strictEqual(wrong.status, 401, `${name}: ${JSON.stringify(wrong.body)}`);
		}
	});

	test('the sealed body cannot name a principal, and a replay is refused for every principal', async () => {
		const refusedFailures: string[] = [];
		for (const field of ['impersonate', 'hdb_user', 'bypass_auth', 'bypassAuth']) {
			const value =
				field === 'impersonate'
					? { username: ctx.harper.admin.username }
					: field === 'hdb_user'
						? { role: { permission: { super_user: true } } }
						: true;
			for (const mode of ['sealed', 'fields'] as const) {
				const s = await sealed(principals[1], { ...CELLS[1].op, [field]: value }, { mode });
				results.push({ arm: 'refused-field', field, mode, s });
				if (s.status !== 400) refusedFailures.push(`${field}/${mode}: status ${s.status} ${JSON.stringify(s.body)}`);
				if (JSON.stringify(s).includes('open-secret-1')) refusedFailures.push(`${field}/${mode} widened the reader`);
			}
		}
		deepStrictEqual(refusedFailures, [], `\n${refusedFailures.join('\n')}`);
		const { request, responseKey, nonce } = sealOperation({ op: CELLS[1].op as any, publicKey, kid });
		const first = await client.reqAs(principals[1].headers()).send(request);
		strictEqual(openResponse(first.body.encrypted_response, responseKey, nonce).status, 403);
		const replayAsSuper = await client.req().send(request);
		strictEqual(replayAsSuper.status, 409, JSON.stringify(replayAsSuper.body));
	});

	test('set_network_access: the lockout check has no caller address when sealed, so it is refused without force', async () => {
		const op = { operation: 'set_network_access', scope: 'operations', allow: ['127.0.0.0/8'] };
		const su = principals[0];
		const before = await direct(su, { operation: 'get_network_access', scope: 'operations' });
		const s = await sealed(su, op);
		const afterSealed = await direct(su, { operation: 'get_network_access', scope: 'operations' });
		const d = await direct(su, op);
		const afterDirect = await direct(su, { operation: 'get_network_access', scope: 'operations' });
		const sForce = await sealed(su, { ...op, allow: [], force: true });
		const cleared = await direct(su, { operation: 'get_network_access', scope: 'operations' });
		results.push({ arm: 'network-access', before, s, afterSealed, d, afterDirect, sForce, cleared });
		strictEqual(d.status, 200, JSON.stringify(d.body));
		deepStrictEqual(afterDirect.body.allow, ['127.0.0.0/8']);
		// measured on f39c1a183: the sealed form is refused, fail-closed, where the direct form is accepted
		strictEqual(s.status, 409, JSON.stringify(s));
		ok(/source address is unknown/.test(s.body.error), JSON.stringify(s.body));
		deepStrictEqual(afterSealed.body, before.body, 'the refused sealed request changed the list');
		strictEqual(sForce.status, 200, JSON.stringify(sForce));
		deepStrictEqual(cleared.body, before.body);
	});

	test('sealed values of failing and succeeding operations stay out of the node log (control: a direct one is logged)', async () => {
		const logPath = (ctx.harper as any).logDir
			? join((ctx.harper as any).logDir, 'hdb.log')
			: join(ctx.harper.dataRootDir, 'log', 'hdb.log');
		ok(existsSync(logPath), `no log at ${logPath}`);
		const canary = (n: number) => `parity-canary-${n}-9c41`;
		const control = await client.req().send({
			operation: 'search_by_value',
			database: 'data',
			table: OPEN,
			search_attribute: 'name',
			search_value: canary(0),
			get_attributes: ['id'],
		});
		strictEqual(control.status, 200);
		const sealedOps: Record<string, any>[] = [
			{
				operation: 'search_by_value',
				database: 'data',
				table: OPEN,
				search_attribute: 'name',
				search_value: canary(1),
				get_attributes: ['id'],
			},
			{ operation: 'sql', sql: `SELECT * FROM data.${OPEN} WHERE name = '${canary(2)}'` },
			{ operation: 'sql', sql: `SELEKT ${canary(3)} FROM nowhere` },
			{ operation: 'insert', database: 'data', table: 'ParityNoSuchTable', records: [{ id: canary(4) }] },
			{
				operation: 'search_by_value',
				database: 'data',
				table: OPEN,
				search_attribute: canary(5),
				search_value: 'x',
				get_attributes: ['id'],
			},
			{ operation: 'add_user', role: 'parity-no-such-role', username: canary(6), password: canary(7), active: true },
			{ operation: 'create_authentication_tokens', username: canary(8), password: canary(9) },
			{ operation: 'search_by_id', database: 'data', table: CLOSED, ids: [canary(10)], get_attributes: ['*'] },
		];
		const statuses: any[] = [];
		for (const p of [principals[0], principals[1]]) {
			for (const op of sealedOps) {
				const s = await sealed(p, op);
				statuses.push({ principal: p.name, operation: op.operation, status: s.status });
				strictEqual(s.outerStatus, 200);
			}
		}
		// The sealed operation runs on the main thread and the control on a worker, so no later log line orders
		// them: a fixed settle, as in encrypted-operation.test.ts. The control canary below fails a late flush.
		await sleep(1500);
		const log = readFileSync(logPath, 'utf8');
		const leaked: string[] = [];
		for (let n = 1; n <= 10; n++) {
			const index = log.indexOf(canary(n));
			if (index >= 0)
				leaked.push(
					`canary ${n}: ${log.slice(log.lastIndexOf('\n', index) + 1, log.indexOf('\n', index)).slice(0, 400)}`
				);
		}
		results.push({ arm: 'log', statuses, leaked, controlLogged: log.includes(canary(0)) });
		ok(log.includes(canary(0)), 'control: the direct operation was not logged, so the log check proves nothing');
		deepStrictEqual(leaked, [], `\n${leaked.join('\n')}`);
	});
});
