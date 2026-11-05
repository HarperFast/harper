import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import jwt from 'jsonwebtoken';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/system-table-authz');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const COMPONENT_TABLE = 'hdb_status';
const INSTALL_TABLE = 'hdb_user';

const ROLE = 'system_table_reader_role';
const LEGACY_ROLE = ROLE + '_legacy';
const LEGACY_READER = { username: 'legacy_system_reader', password: 'Legacy-pw-2120!' };
const SUPER_READER = { username: 'system_table_super_user', password: 'Super-pw-2120!' };
const READER = { username: 'system_table_reader', password: 'Reader-pw-2120!' };

const FORBIDDEN = 403;

suite(
	'harper#2120 — component-created system tables are addressable',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let readerHeaders: Record<string, string>;

		before(async () => {
			const systemSchema = JSON.parse(
				await readFile(resolve(import.meta.dirname, '../../json/systemSchema.json'), 'utf8')
			);
			ok(!(COMPONENT_TABLE in systemSchema), `${COMPONENT_TABLE} must not be an install-time table`);

			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			readerHeaders = createHeaders(READER.username, READER.password);
			await client
				.req()
				.send({
					operation: 'insert',
					database: 'system',
					table: 'hdb_role',
					records: [
						{
							id: LEGACY_ROLE,
							role: LEGACY_ROLE,
							permission: {
								super_user: false,
								system: {
									tables: {
										[COMPONENT_TABLE]: {
											read: true,
											insert: true,
											update: true,
											delete: true,
											attribute_permissions: [],
										},
									},
								},
							},
						},
					],
				})
				.expect(200);
			await client
				.req()
				.send({ operation: 'add_user', role: LEGACY_ROLE, ...LEGACY_READER, active: true })
				.expect(200);

			await client
				.req()
				.send({ operation: 'add_role', role: ROLE, permission: { super_user: false } })
				.expect(200);
			await client
				.req()
				.send({
					operation: 'add_user',
					role: ROLE,
					username: READER.username,
					password: READER.password,
					active: true,
				})
				.expect(200);
			await client
				.req()
				.send({ operation: 'add_user', role: 'super_user', ...SUPER_READER, active: true })
				.expect(200);
			await client
				.reqAs(createHeaders(SUPER_READER.username, SUPER_READER.password))
				.send({
					operation: 'describe_table',
					database: 'system',
					table: COMPONENT_TABLE,
					skip_record_count: true,
				})
				.expect(200);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		for (const operation of ['add_role', 'alter_role']) {
			test(`${operation} rejects system-table declarations before storing them`, async () => {
				const response = await client.req().send({
					operation,
					role: operation === 'add_role' ? ROLE + '_invalid' : ROLE,
					id: operation === 'add_role' ? ROLE + '_invalid' : ROLE,
					permission: {
						super_user: false,
						system: {
							tables: {
								[COMPONENT_TABLE]: {
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
				strictEqual(response.status, 400);
				ok(JSON.stringify(response.body).includes('managed by Harper'));
				const listed = await client.req().send({ operation: 'list_roles' }).expect(200);
				ok(!listed.body.some((role: { role: string }) => role.role === ROLE + '_invalid'));
				const readerRole = listed.body.find((role: { role: string }) => role.role === ROLE);
				strictEqual(readerRole.permission.super_user, false);
				strictEqual(readerRole.permission.system, undefined);
			});
		}

		for (const impersonate of [
			{ role: { permission: { super_user: true, system: { tables: { [COMPONENT_TABLE]: { read: true } } } } } },
			{ role_name: ROLE },
			{ username: SUPER_READER.username },
		]) {
			test(`impersonation ${Object.keys(impersonate)[0]} cannot grant system access`, async () => {
				await client
					.req()
					.send({
						operation: 'search_by_hash',
						database: 'system',
						table: COMPONENT_TABLE,
						hash_values: ['no-such-status-id'],
						get_attributes: ['*'],
						impersonate,
					})
					.expect(FORBIDDEN);
			});
		}

		test('legacy role grants are omitted from role and user introspection', async () => {
			const listed = await client.req().send({ operation: 'list_roles' }).expect(200);
			const role = listed.body.find((role: { role: string }) => role.role === LEGACY_ROLE);
			strictEqual(role.permission.system, undefined);
			strictEqual(role.permission.super_user, false);
			const info = await client
				.reqAs(createHeaders(LEGACY_READER.username, LEGACY_READER.password))
				.send({ operation: 'user_info' })
				.expect(200);
			strictEqual(info.body.role.role, LEGACY_ROLE);
			strictEqual(info.body.role.permission.system, undefined);
			const users = await client.req().send({ operation: 'list_users' }).expect(200);
			const listedUser = users.body.find((entry: { username: string }) => entry.username === LEGACY_READER.username);
			strictEqual(listedUser.role.permission.system, undefined);
		});

		test('the legacy user cannot read a system table using its stored grant', async () => {
			await client
				.reqAs(createHeaders(LEGACY_READER.username, LEGACY_READER.password))
				.send({
					operation: 'search_by_hash',
					database: 'system',
					table: COMPONENT_TABLE,
					hash_values: ['no-such-status-id'],
					get_attributes: ['*'],
				})
				.expect(FORBIDDEN);
		});

		test('a legacy named-role grant cannot authorize a system-table write through impersonation', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					database: 'system',
					table: COMPONENT_TABLE,
					records: [{ id: 'legacy-impersonation-write' }],
					impersonate: { role_name: LEGACY_ROLE },
				})
				.expect(FORBIDDEN);
		});

		test('describe_database lists the component-created table', async () => {
			const response = await client.req().send({ operation: 'describe_database', database: 'system' }).expect(200);
			ok(response.body[COMPONENT_TABLE], `${COMPONENT_TABLE} should be enumerated by describe_database`);
		});

		test('describe_table resolves the component-created table for a super_user', async () => {
			const response = await client
				.req()
				.send({ operation: 'describe_table', database: 'system', table: COMPONENT_TABLE, skip_record_count: true })
				.expect(200);
			strictEqual(response.body.name, COMPONENT_TABLE);
		});

		test('search_by_hash reaches the component-created table for a super_user', async () => {
			const response = await client
				.req()
				.send({
					operation: 'search_by_hash',
					database: 'system',
					table: COMPONENT_TABLE,
					hash_values: ['no-such-status-id'],
					get_attributes: ['*'],
				})
				.expect(200);
			ok(Array.isArray(response.body));
		});

		test('sql selects from the component-created table for a super_user', async () => {
			const response = await client
				.req()
				.send({ operation: 'sql', sql: `SELECT * FROM system.${COMPONENT_TABLE} LIMIT 1` })
				.expect(200);
			ok(Array.isArray(response.body));
		});

		test('install-time system tables still resolve for a super_user', async () => {
			const response = await client
				.req()
				.send({ operation: 'describe_table', database: 'system', table: INSTALL_TABLE, skip_record_count: true })
				.expect(200);
			strictEqual(response.body.name, INSTALL_TABLE);
		});

		test('a non-super_user is still refused the component-created table', async () => {
			const response = await client.reqAs(readerHeaders).send({
				operation: 'search_by_hash',
				database: 'system',
				table: COMPONENT_TABLE,
				hash_values: ['no-such-status-id'],
				get_attributes: ['*'],
			});
			strictEqual(response.status, FORBIDDEN, 'expected the reader to be authenticated and then forbidden');
		});

		for (const write of [
			{ operation: 'insert', records: [{ id: 'authz-2120-write-probe', status: 'injected' }] },
			{ operation: 'update', records: [{ id: 'authz-2120-write-probe', status: 'injected' }] },
			{ operation: 'delete', hash_values: ['authz-2120-write-probe'] },
		]) {
			test(`a super_user is refused ${write.operation} on the component-created table`, async () => {
				const response = await client.req().send({ ...write, database: 'system', table: COMPONENT_TABLE });
				strictEqual(response.status, FORBIDDEN, `expected ${write.operation} to be forbidden`);
			});
		}

		test('the refused writes did not land', async () => {
			const response = await client
				.req()
				.send({
					operation: 'search_by_hash',
					database: 'system',
					table: COMPONENT_TABLE,
					hash_values: ['authz-2120-write-probe'],
					get_attributes: ['*'],
				})
				.expect(200);
			strictEqual(response.body.length, 0);
		});

		test('a legacy signed scoped token cannot read a system table', async () => {
			const keys = resolve(ctx.harper.dataRootDir, 'keys');
			const token = jwt.sign(
				{
					username: 'legacy_scoped_reader',
					role: { permission: { operations: ['read_only'], system: { tables: { hdb_user: { read: true } } } } },
				},
				{
					key: await readFile(resolve(keys, '.jwtPrivate.key'), 'utf8'),
					passphrase: await readFile(resolve(keys, '.jwtPass'), 'utf8'),
				},
				{ algorithm: 'RS256', subject: 'scoped-operation', expiresIn: '1h' }
			);
			const headers = { ...readerHeaders, Authorization: `Bearer ${token}` };
			await client.reqAs(headers).send({ operation: 'user_info' }).expect(200);
			await client
				.reqAs(headers)
				.send({
					operation: 'search_by_value',
					database: 'system',
					table: INSTALL_TABLE,
					search_attribute: 'username',
					search_value: 'admin',
					get_attributes: ['*'],
				})
				.expect(FORBIDDEN);
		});

		test('permissions survive forwarding to a worker thread', async () => {
			const response = await client.req().send({ operation: 'system_authz_probe' }).expect(200);
			strictEqual(response.body.executedOnMainThread, false, 'the probe must run off the main thread');
			ok(response.body.sawSystemTables > 0, 'the system permission map must survive the clone');
			strictEqual(response.body.statusReadable, true);
			strictEqual(response.body.statusInsertable, false);
		});

		test('a non-super_user is still refused an install-time system table', async () => {
			const response = await client.reqAs(readerHeaders).send({
				operation: 'search_by_value',
				database: 'system',
				table: INSTALL_TABLE,
				search_attribute: 'username',
				search_value: '*',
				get_attributes: ['*'],
			});
			strictEqual(response.status, FORBIDDEN, 'expected the reader to be authenticated and then forbidden');
		});
	}
);
