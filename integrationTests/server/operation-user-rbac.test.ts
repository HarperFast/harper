/**
 * operations RBAC integration tests.
 *
 * Tests the `operations` permission field on roles, which provides an
 * operation-level allowlist enabling non-super_user roles to call specific
 * operations (including SU-only ones) without full super_user access.
 *
 * Dual gate: operations restricts which ops are reachable, and table
 * CRUD permissions still apply for data operations — both must pass.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';

import { setupHarper, teardownHarper, type ContextWithHarper } from '../utils/harperLifecycle.ts';

const DATABASE = 'test_db';
const TABLE = 'dogs';
const HASH_ATTR = 'id';

const READ_ONLY_ROLE = 'read_only_ops_role';
const READ_ONLY_USER = 'readonly_user';
const READ_ONLY_PASS = 'Test1234!';

const SU_OPS_ROLE = 'su_ops_role';
const SU_OPS_USER = 'su_ops_user';
const SU_OPS_PASS = 'Test1234!';

const COMBINED_ROLE = 'combined_ops_role';
const COMBINED_USER = 'combined_user';
const COMBINED_PASS = 'Test1234!';

const STANDARD_USER_ROLE = 'standard_user_ops_role';
const STANDARD_USER_USER = 'standard_user_user';
const STANDARD_USER_PASS = 'Test1234!';

suite('operations RBAC', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarper(ctx, { config: {}, env: {} });

		const adminAuth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

		async function op(body: object) {
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': adminAuth },
				body: JSON.stringify(body),
			});
			return res;
		}

		// Create database, table, and seed data
		await op({ operation: 'create_database', database: DATABASE });
		await op({ operation: 'create_table', schema: DATABASE, table: TABLE, hash_attribute: HASH_ATTR });
		await op({
			operation: 'insert',
			schema: DATABASE,
			table: TABLE,
			records: [
				{ id: 1, name: 'Rex', breed: 'German Shepherd' },
				{ id: 2, name: 'Buddy', breed: 'Labrador' },
			],
		});

		// Create read_only_ops_role: operations restricts to read-only ops,
		// with explicit READ permission on the test table (dual gate)
		await op({
			operation: 'add_role',
			role: READ_ONLY_ROLE,
			permission: {
				operations: ['read_only'],
				[DATABASE]: {
					tables: {
						[TABLE]: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			},
		});

		// Create su_ops_role: can call specific SU-only ops without being super_user
		await op({
			operation: 'add_role',
			role: SU_OPS_ROLE,
			permission: {
				operations: ['get_configuration', 'system_information', 'list_users'],
			},
		});

		// Create combined_ops_role: both read_only data ops AND a specific SU-only op in one role
		await op({
			operation: 'add_role',
			role: COMBINED_ROLE,
			permission: {
				operations: ['read_only', 'get_configuration'],
				[DATABASE]: {
					tables: {
						[TABLE]: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			},
		});

		// Create standard_user_ops_role: full CRUD data access + two SU-only ops,
		// demonstrating the "all normally available ops + targeted admin ops" pattern
		await op({
			operation: 'add_role',
			role: STANDARD_USER_ROLE,
			permission: {
				operations: ['standard_user', 'get_configuration', 'system_information'],
				[DATABASE]: {
					tables: {
						[TABLE]: {
							read: true,
							insert: true,
							update: true,
							delete: true,
							attribute_permissions: [],
						},
					},
				},
			},
		});

		// Create test users
		await op({
			operation: 'add_user',
			role: READ_ONLY_ROLE,
			username: READ_ONLY_USER,
			password: READ_ONLY_PASS,
			active: true,
		});
		await op({ operation: 'add_user', role: SU_OPS_ROLE, username: SU_OPS_USER, password: SU_OPS_PASS, active: true });
		await op({
			operation: 'add_user',
			role: COMBINED_ROLE,
			username: COMBINED_USER,
			password: COMBINED_PASS,
			active: true,
		});
		await op({
			operation: 'add_user',
			role: STANDARD_USER_ROLE,
			username: STANDARD_USER_USER,
			password: STANDARD_USER_PASS,
			active: true,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// -- helpers --

	function authHeader(username: string, password: string) {
		return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
	}

	async function callOp(username: string, password: string, body: object) {
		return fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': authHeader(username, password),
			},
			body: JSON.stringify(body),
		});
	}

	// -- read_only_ops_role tests --

	suite('read_only_ops_role', () => {
		test('search_by_hash is allowed (in read_only group + table READ perm)', async () => {
			const res = await callOp(READ_ONLY_USER, READ_ONLY_PASS, {
				operation: 'search_by_hash',
				schema: DATABASE,
				table: TABLE,
				hash_values: [1],
				get_attributes: ['*'],
			});
			strictEqual(res.status, 200);
			const body = (await res.json()) as any[];
			ok(Array.isArray(body), 'Expected array response');
			strictEqual(body[0].id, 1);
		});

		test('sql SELECT is allowed (in read_only group + table READ perm)', async () => {
			const res = await callOp(READ_ONLY_USER, READ_ONLY_PASS, {
				operation: 'sql',
				sql: `SELECT * FROM ${DATABASE}.${TABLE} WHERE id = 1`,
			});
			strictEqual(res.status, 200);
		});

		test('describe_all is allowed (in read_only group)', async () => {
			const res = await callOp(READ_ONLY_USER, READ_ONLY_PASS, {
				operation: 'describe_all',
			});
			strictEqual(res.status, 200);
		});

		test('insert is denied (not in operations list)', async () => {
			const res = await callOp(READ_ONLY_USER, READ_ONLY_PASS, {
				operation: 'insert',
				schema: DATABASE,
				table: TABLE,
				records: [{ id: 99, name: 'Max', breed: 'Poodle' }],
			});
			strictEqual(res.status, 403);
			const body = (await res.json()) as any;
			ok(
				body.unauthorized_access?.[0]?.includes("'insert' is not permitted for this role's operations configuration"),
				`Unexpected denial reason: ${JSON.stringify(body.unauthorized_access)}`
			);
		});

		test('update is denied (not in operations list)', async () => {
			const res = await callOp(READ_ONLY_USER, READ_ONLY_PASS, {
				operation: 'update',
				schema: DATABASE,
				table: TABLE,
				records: [{ id: 1, name: 'Rex Updated' }],
			});
			strictEqual(res.status, 403);
		});

		test('delete is denied (not in operations list)', async () => {
			const res = await callOp(READ_ONLY_USER, READ_ONLY_PASS, {
				operation: 'delete',
				schema: DATABASE,
				table: TABLE,
				hash_values: [1],
			});
			strictEqual(res.status, 403);
		});

		test('get_configuration is denied (SU-only op not in operations list)', async () => {
			const res = await callOp(READ_ONLY_USER, READ_ONLY_PASS, {
				operation: 'get_configuration',
			});
			strictEqual(res.status, 403);
		});
	});

	// -- su_ops_role tests --

	suite('su_ops_role', () => {
		test('get_configuration is allowed (SU-only op granted via operations)', async () => {
			const res = await callOp(SU_OPS_USER, SU_OPS_PASS, {
				operation: 'get_configuration',
			});
			strictEqual(res.status, 200);
		});

		test('system_information is allowed (SU-only op granted via operations)', async () => {
			const res = await callOp(SU_OPS_USER, SU_OPS_PASS, {
				operation: 'system_information',
			});
			strictEqual(res.status, 200);
		});

		test('list_users is allowed (SU-only op granted via operations)', async () => {
			const res = await callOp(SU_OPS_USER, SU_OPS_PASS, {
				operation: 'list_users',
			});
			strictEqual(res.status, 200);
		});

		test('insert is denied (not in operations list)', async () => {
			const res = await callOp(SU_OPS_USER, SU_OPS_PASS, {
				operation: 'insert',
				schema: DATABASE,
				table: TABLE,
				records: [{ id: 99, name: 'Max', breed: 'Poodle' }],
			});
			strictEqual(res.status, 403);
		});

		test('restart is denied (SU-only op not in operations list)', async () => {
			const res = await callOp(SU_OPS_USER, SU_OPS_PASS, {
				operation: 'restart',
			});
			strictEqual(res.status, 403);
		});

		test('search_by_hash is denied (not in operations list)', async () => {
			const res = await callOp(SU_OPS_USER, SU_OPS_PASS, {
				operation: 'search_by_hash',
				schema: DATABASE,
				table: TABLE,
				hash_values: [1],
				get_attributes: ['*'],
			});
			strictEqual(res.status, 403);
		});
	});

	// -- role validation tests --

	suite('add_role validation', () => {
		test('non-array operations is rejected with 400', async () => {
			const res = await callOp(ctx.harper.admin.username, ctx.harper.admin.password, {
				operation: 'add_role',
				role: 'bad_role_1',
				permission: {
					operations: true,
				},
			});
			strictEqual(res.status, 400);
			const body = (await res.json()) as any;
			ok(JSON.stringify(body).includes('must be an array'), `Unexpected response: ${JSON.stringify(body)}`);
		});

		test('invalid operation name in operations is rejected with 400', async () => {
			const res = await callOp(ctx.harper.admin.username, ctx.harper.admin.password, {
				operation: 'add_role',
				role: 'bad_role_2',
				permission: {
					operations: ['bogus_nonexistent_op'],
				},
			});
			strictEqual(res.status, 400);
			const body = (await res.json()) as any;
			ok(JSON.stringify(body).includes('bogus_nonexistent_op'), `Unexpected response: ${JSON.stringify(body)}`);
		});

		test('valid operations with read_only group is accepted', async () => {
			const res = await callOp(ctx.harper.admin.username, ctx.harper.admin.password, {
				operation: 'add_role',
				role: 'valid_role_1',
				permission: {
					operations: ['read_only'],
				},
			});
			strictEqual(res.status, 200);
		});
	});

	// -- combined role: both data ops (read_only group) and SU-only op granted together --

	suite('combined_ops_role (read_only + SU-only op)', () => {
		test('search_by_hash is allowed (data op via read_only group + table READ perm)', async () => {
			const res = await callOp(COMBINED_USER, COMBINED_PASS, {
				operation: 'search_by_hash',
				schema: DATABASE,
				table: TABLE,
				hash_values: [1],
				get_attributes: ['*'],
			});
			strictEqual(res.status, 200);
		});

		test('get_configuration is allowed (SU-only bypass via operations)', async () => {
			const res = await callOp(COMBINED_USER, COMBINED_PASS, {
				operation: 'get_configuration',
			});
			strictEqual(res.status, 200);
		});

		test('insert is denied (not in operations list despite table existing in perms)', async () => {
			const res = await callOp(COMBINED_USER, COMBINED_PASS, {
				operation: 'insert',
				schema: DATABASE,
				table: TABLE,
				records: [{ id: 98, name: 'Daisy', breed: 'Corgi' }],
			});
			strictEqual(res.status, 403);
		});

		test('restart is denied (SU-only op not in operations list)', async () => {
			const res = await callOp(COMBINED_USER, COMBINED_PASS, {
				operation: 'restart',
			});
			strictEqual(res.status, 403);
		});
	});

	// -- standard_user group: all non-SU data ops + targeted SU ops --
	// This mirrors the docs example: "all normally available access + two SU operations"

	suite('standard_user_ops_role (standard_user group + targeted SU ops)', () => {
		test('search_by_hash is allowed (in standard_user group + table READ perm)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'search_by_hash',
				schema: DATABASE,
				table: TABLE,
				hash_values: [1],
				get_attributes: ['*'],
			});
			strictEqual(res.status, 200);
		});

		test('insert is allowed (in standard_user group + table INSERT perm)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'insert',
				schema: DATABASE,
				table: TABLE,
				records: [{ id: 10, name: 'Luna', breed: 'Husky' }],
			});
			strictEqual(res.status, 200);
		});

		test('update is allowed (in standard_user group + table UPDATE perm)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'update',
				schema: DATABASE,
				table: TABLE,
				records: [{ id: 10, name: 'Luna Updated' }],
			});
			strictEqual(res.status, 200);
		});

		test('delete is allowed (in standard_user group + table DELETE perm)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'delete',
				schema: DATABASE,
				table: TABLE,
				hash_values: [10],
			});
			strictEqual(res.status, 200);
		});

		test('get_configuration is allowed (SU-only op explicitly granted)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'get_configuration',
			});
			strictEqual(res.status, 200);
		});

		test('system_information is allowed (SU-only op explicitly granted)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'system_information',
			});
			strictEqual(res.status, 200);
		});

		test('restart is denied (SU-only op not in operations list)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'restart',
			});
			strictEqual(res.status, 403);
		});

		test('drop_database is denied (SU-only op not in operations list)', async () => {
			const res = await callOp(STANDARD_USER_USER, STANDARD_USER_PASS, {
				operation: 'drop_database',
				database: DATABASE,
			});
			strictEqual(res.status, 403);
		});
	});

	// -- regression: admin super_user behavior unchanged --

	suite('admin (super_user) regression', () => {
		test('admin can insert (no operations restriction)', async () => {
			const res = await callOp(ctx.harper.admin.username, ctx.harper.admin.password, {
				operation: 'insert',
				schema: DATABASE,
				table: TABLE,
				records: [{ id: 50, name: 'Bella', breed: 'Beagle' }],
			});
			strictEqual(res.status, 200);
		});

		test('admin can get_configuration (super_user unrestricted)', async () => {
			const res = await callOp(ctx.harper.admin.username, ctx.harper.admin.password, {
				operation: 'get_configuration',
			});
			strictEqual(res.status, 200);
		});
	});
});
