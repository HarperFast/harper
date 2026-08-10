/**
 * harper#2120 — a system table created at runtime by its owning component must be addressable
 * through the operations API, not reported as nonexistent.
 *
 * `hdb_status` (server/status/index.ts) is created lazily and needs no fixture, so it is the probe:
 * on the unfixed build `describe_database` lists it in the same session where `describe_table` and
 * `search_by_hash` answer "Table 'system.hdb_status' does not exist".
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const COMPONENT_TABLE = 'hdb_status';
const INSTALL_TABLE = 'hdb_user';

const ROLE = 'system_table_reader_role';
const READER = { username: 'system_table_reader', password: 'Reader-pw-2120!' };

// 403 specifically, not "401 or 403": accepting 401 would let a broken credential or a regression
// in user lookup satisfy every denial assertion here without authorization ever being consulted.
const FORBIDDEN = 403;

suite(
	'harper#2120 — component-created system tables are addressable',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let readerHeaders: Record<string, string>;

		before(async () => {
			// Every test below assumes COMPONENT_TABLE is created at runtime rather than at install.
			// If it is ever added to systemSchema.json they would all keep passing while exercising
			// the seeded path, leaving the registry fallback with no end-to-end coverage.
			const systemSchema = JSON.parse(
				await readFile(resolve(import.meta.dirname, '../../json/systemSchema.json'), 'utf8')
			);
			ok(!(COMPONENT_TABLE in systemSchema), `${COMPONENT_TABLE} must not be an install-time table`);

			await startHarper(ctx);
			client = createApiClient(ctx.harper);
			readerHeaders = createHeaders(READER.username, READER.password);

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
		});

		after(async () => {
			await teardownHarper(ctx);
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
			// A miss is the point: the request must be answered, not refused as a nonexistent table.
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
