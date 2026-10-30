/**
 * Attribute-level read permissions apply to every way a SQL statement can reference a column:
 * `JOIN ... USING (col)`, an unqualified column inside `JOIN ... ON`, and row accessors that name
 * no column (`SELECT VALUE`, `_`, AlaSQL JavaScript expressions). The authorization check runs
 * before the engine router, so legacy, auto and new must all give the same answer.
 *
 *   npm run build && npm run test:integration -- "integrationTests/security/sql-attribute-perms.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/sql-attribute-perms');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const USER = { username: 'colperm_reader', password: 'Colperm-reader-pw-1!' };
const ROLE = 'colperm_reader_role';
const RIGHT_PK = 'r-primary-key-1';

type Client = ReturnType<typeof createApiClient>;

function attr(attribute_name: string, read: boolean) {
	return { attribute_name, read, insert: false, update: false };
}

function readOnly(attribute_permissions: ReturnType<typeof attr>[]) {
	return { read: true, insert: false, update: false, delete: false, attribute_permissions };
}

// sql.engine=new answers only indexed queries, so every statement carries an indexed predicate.
const USING_DENIED = `SELECT l.label FROM data.ColPermLeft l JOIN data.ColPermRight r USING (ssn) WHERE l.id = 'l1'`;
const USING_DENIED_SELF = `SELECT a.label FROM data.ColPermLeft a JOIN data.ColPermLeft b USING (ssn) WHERE a.id = 'l1'`;
const USING_PERMITTED = `SELECT l.label, r.label AS rl FROM data.ColPermLeft l JOIN data.ColPermRight r USING (label) WHERE l.id = 'l1'`;
const ON_PERMITTED = `SELECT l.label, r.label AS rl FROM data.ColPermLeft l JOIN data.ColPermRight r ON l.label = r.label WHERE l.id = 'l1'`;

for (const sqlEngine of ['legacy', 'auto', 'new']) {
	suite(
		`SQL attribute permissions cover every column reference [sql.engine=${sqlEngine}]`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			let client: Client;
			let readerHeaders: Record<string, string>;

			const asReader = (sql: string) => client.reqAs(readerHeaders).send({ operation: 'sql', sql });

			function assertRefused(r: { status: number; body: unknown }, sql: string) {
				strictEqual(r.status, 403, `${sql} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
				ok(!JSON.stringify(r.body).includes(RIGHT_PK), 'the refusal must not carry the primary key value');
			}

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: { HARPER_SQL_ENGINE: sqlEngine } });
				client = createApiClient(ctx.harper);
				readerHeaders = createHeaders(USER.username, USER.password);

				await client
					.req()
					.send({
						operation: 'add_role',
						role: ROLE,
						permission: {
							super_user: false,
							data: {
								tables: {
									ColPermLeft: readOnly([attr('id', true), attr('label', true), attr('ssn', false)]),
									ColPermRight: readOnly([
										attr('id', false),
										attr('label', true),
										attr('ssn', true),
										attr('code', false),
									]),
								},
							},
						},
					})
					.expect(200);
				await client
					.req()
					.send({ operation: 'add_user', role: ROLE, ...USER, active: true })
					.expect(200);
				await client
					.req()
					.send({
						operation: 'insert',
						schema: 'data',
						table: 'ColPermLeft',
						records: [
							{ id: 'l1', label: 'shared', ssn: '111' },
							{ id: 'l2', label: 'other', ssn: '222' },
						],
					})
					.expect(200);
				await client
					.req()
					.send({
						operation: 'insert',
						schema: 'data',
						table: 'ColPermRight',
						records: [
							{ id: RIGHT_PK, label: 'shared', ssn: '111', code: 'c1' },
							{ id: 'r-primary-key-2', label: 'unmatched', ssn: '333', code: 'c2' },
						],
					})
					.expect(200);
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			test('JOIN USING on a read-denied column is refused, as the equivalent ON is', async () => {
				assertRefused(await asReader(USING_DENIED), USING_DENIED);
				const on = `SELECT l.label FROM data.ColPermLeft l JOIN data.ColPermRight r ON l.ssn = r.ssn WHERE l.id = 'l1'`;
				assertRefused(await asReader(on), on);
			});

			test('self-join USING on a read-denied column is refused', async () => {
				assertRefused(await asReader(USING_DENIED_SELF), USING_DENIED_SELF);
			});

			test('an unqualified read-denied column inside JOIN ON is refused', async () => {
				const sql = `SELECT l.label FROM data.ColPermLeft l JOIN data.ColPermRight r ON l.label = r.label AND code = 'c1' WHERE l.id = 'l1'`;
				assertRefused(await asReader(sql), sql);
			});

			test('a column qualified by a name that is not a table in the statement is refused', async () => {
				const sql = `SELECT bogus.ssn FROM data.ColPermLeft WHERE id = 'l1'`;
				assertRefused(await asReader(sql), sql);
			});

			test('a read-denied column nested deep inside an expression is refused', async () => {
				const nested = 'UPPER('.repeat(80) + 'ssn' + ')'.repeat(80);
				const sql = `SELECT label FROM data.ColPermLeft WHERE id = 'l1' AND ${nested} = '111'`;
				assertRefused(await asReader(sql), sql);
			});

			test("a qualifier that is one table's alias and another's base name is refused", async () => {
				// v2 reads the aliased ColPermRight's read-denied primary key; ColPermLeft.id is readable.
				const sql = `SELECT ColPermLeft.id FROM data.ColPermLeft l JOIN data.ColPermRight ColPermLeft ON l.label = ColPermLeft.label WHERE l.id = 'l1'`;
				assertRefused(await asReader(sql), sql);
			});

			test('row accessors that name no column are refused when the primary key is read-denied', async () => {
				for (const sql of [
					`SELECT VALUE FROM data.ColPermRight r WHERE r.label = 'shared'`,
					`SELECT _->id AS k FROM data.ColPermRight r WHERE r.label = 'shared'`,
					"SELECT ``p`` AS rec FROM data.ColPermRight r WHERE r.label = 'shared'",
				]) {
					assertRefused(await asReader(sql), sql);
				}
			});

			test('JOIN USING on a permitted column is authorized and matches the equivalent ON', async () => {
				const using = await asReader(USING_PERMITTED);
				notStrictEqual(using.status, 403, `${USING_PERMITTED} -> ${JSON.stringify(using.body)}`);
				// Legacy SQL rejects every USING clause, super user included, so only the v2 engine
				// can show row parity with ON.
				if (sqlEngine !== 'legacy') {
					strictEqual(using.status, 200, JSON.stringify(using.body));
					const on = await asReader(ON_PERMITTED);
					strictEqual(on.status, 200, JSON.stringify(on.body));
					deepStrictEqual(using.body, on.body);
					deepStrictEqual(using.body, [{ label: 'shared', rl: 'shared' }]);
				}
			});

			test('super user is unaffected', async () => {
				const r = await client.req().send({ operation: 'sql', sql: USING_DENIED });
				if (sqlEngine === 'legacy') {
					notStrictEqual(r.status, 403, JSON.stringify(r.body));
				} else {
					strictEqual(r.status, 200, JSON.stringify(r.body));
					deepStrictEqual(r.body, [{ label: 'shared' }]);
				}
				const row = await client
					.req()
					.send({ operation: 'sql', sql: `SELECT id FROM data.ColPermRight WHERE label = 'shared'` });
				strictEqual(row.status, 200, JSON.stringify(row.body));
				deepStrictEqual(row.body, [{ id: RIGHT_PK }]);
			});
		}
	);
}
