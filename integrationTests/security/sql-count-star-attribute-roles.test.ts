/**
 * `SELECT COUNT(*)` for a role whose table permission lists attributes.
 *
 * The SQL permission check records every column reference as an attribute the role must be allowed
 * to read. The `*` inside `COUNT(*)` is a row count, not an attribute, so table `read` alone must
 * be enough — while a real column in the same statement, and any other use of a wildcard, is still
 * checked.
 *
 * Reproduction:
 *   npm run build && npm run test:integration -- "integrationTests/security/sql-count-star-attribute-roles.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/sql-count-star-attribute-roles');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const TABLE = 'data.CountStarRow';
const RESTRICTED = {
	username: 'count_star_restricted',
	password: 'Restricted-pw-4471!',
	role: 'count_star_restricted_role',
};
const UNGRANTED = {
	username: 'count_star_ungranted',
	password: 'Ungranted-pw-4471!',
	role: 'count_star_ungranted_role',
};

// `name` is absent on one row so COUNT(*) (4) differs from COUNT(name) (3).
const ROWS = [
	{ id: 'a', dept: 'x', name: 'n1', salary: 100 },
	{ id: 'b', dept: 'x', salary: 200 },
	{ id: 'c', dept: 'y', name: 'n3', salary: 300 },
	{ id: 'd', dept: 'y', name: 'n4', salary: 400 },
];

// `auto` serves a statement from the new engine when it can; `legacy` never does. The permission
// check runs before either, so both must agree.
for (const sqlEngine of ['auto', 'legacy']) {
	suite(
		`SQL COUNT(*) under attribute permissions [sql.engine=${sqlEngine}]`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			let client: ReturnType<typeof createApiClient>;
			let restrictedHeaders: Record<string, string>;
			let ungrantedHeaders: Record<string, string>;

			const sqlAs = (headers: Record<string, string> | null, sql: string) =>
				(headers ? client.reqAs(headers) : client.req()).send({ operation: 'sql', sql });

			async function addUser(user: typeof RESTRICTED, permission: Record<string, unknown>) {
				await client.req().send({ operation: 'add_role', role: user.role, permission }).expect(200);
				await client
					.req()
					.send({
						operation: 'add_user',
						role: user.role,
						username: user.username,
						password: user.password,
						active: true,
					})
					.expect(200);
			}

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: { HARPER_SQL_ENGINE: sqlEngine } });
				client = createApiClient(ctx.harper);
				restrictedHeaders = createHeaders(RESTRICTED.username, RESTRICTED.password);
				ungrantedHeaders = createHeaders(UNGRANTED.username, UNGRANTED.password);

				await addUser(RESTRICTED, {
					super_user: false,
					data: {
						tables: {
							CountStarRow: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{ attribute_name: 'id', read: true, insert: false, update: false },
									{ attribute_name: 'dept', read: true, insert: false, update: false },
									{ attribute_name: 'name', read: true, insert: false, update: false },
									{ attribute_name: 'salary', read: false, insert: false, update: false },
								],
							},
						},
					},
				});
				await addUser(UNGRANTED, {
					super_user: false,
					data: {
						tables: {
							CountStarOther: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				});

				await client
					.req()
					.send({ operation: 'insert', schema: 'data', table: 'CountStarRow', records: ROWS })
					.expect(200);
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			test('COUNT(*) returns the row count for the attribute-restricted role', async () => {
				const r = await sqlAs(restrictedHeaders, `SELECT COUNT(*) AS c FROM ${TABLE}`).expect(200);
				deepStrictEqual(r.body, [{ c: 4 }]);
			});

			test('COUNT(*) keeps its NULL-insensitive meaning (differs from COUNT(name))', async () => {
				const r = await sqlAs(restrictedHeaders, `SELECT COUNT(*) AS c, COUNT(name) AS n FROM ${TABLE}`).expect(200);
				deepStrictEqual(r.body, [{ c: 4, n: 3 }]);
			});

			test('COUNT(*) GROUP BY a permitted column is served', async () => {
				const r = await sqlAs(restrictedHeaders, `SELECT dept, COUNT(*) AS c FROM ${TABLE} GROUP BY dept`).expect(200);
				deepStrictEqual(
					(r.body as { dept: string; c: number }[]).sort((l, rr) => l.dept.localeCompare(rr.dept)),
					[
						{ dept: 'x', c: 2 },
						{ dept: 'y', c: 2 },
					]
				);
			});

			test('COUNT(*) in HAVING is served', async () => {
				const r = await sqlAs(
					restrictedHeaders,
					`SELECT dept, COUNT(*) AS c FROM ${TABLE} GROUP BY dept HAVING COUNT(*) > 1`
				).expect(200);
				strictEqual((r.body as unknown[]).length, 2);
			});

			test('COUNT(*) GROUP BY a denied column is still refused, naming that column', async () => {
				const r = await sqlAs(restrictedHeaders, `SELECT COUNT(*) AS c FROM ${TABLE} GROUP BY salary`);
				strictEqual(r.status, 403, JSON.stringify(r.body));
				const items = JSON.stringify(r.body.invalid_schema_items);
				ok(items.includes('salary'), `denial must come from the salary check: ${items}`);
				ok(!items.includes("'*'"), `the count wildcard must not be reported: ${items}`);
			});

			test('COUNT(*) with a denied column in WHERE or HAVING is still refused', async () => {
				const where = await sqlAs(restrictedHeaders, `SELECT COUNT(*) AS c FROM ${TABLE} WHERE salary > 100`);
				strictEqual(where.status, 403, JSON.stringify(where.body));
				ok(JSON.stringify(where.body.invalid_schema_items).includes('salary'));
				const having = await sqlAs(
					restrictedHeaders,
					`SELECT dept, COUNT(*) AS c FROM ${TABLE} GROUP BY dept HAVING SUM(salary) > 100`
				);
				strictEqual(having.status, 403, JSON.stringify(having.body));
				ok(JSON.stringify(having.body.invalid_schema_items).includes('salary'));
			});

			test('wildcards other than a plain COUNT(*) stay checked', async () => {
				for (const expr of ['FIRST(*)', 'ARRAY(*)', 'COUNT(DISTINCT *)']) {
					const r = await sqlAs(restrictedHeaders, `SELECT ${expr} AS v FROM ${TABLE}`);
					strictEqual(r.status, 403, `${expr}: ${JSON.stringify(r.body)}`);
				}
			});

			test('SELECT * returns only the permitted attributes', async () => {
				const r = await sqlAs(restrictedHeaders, `SELECT * FROM ${TABLE}`).expect(200);
				const rows = r.body as Record<string, unknown>[];
				strictEqual(rows.length, 4);
				for (const row of rows) {
					ok(!('salary' in row), `salary leaked: ${JSON.stringify(row)}`);
					ok('id' in row && 'dept' in row);
				}
			});

			test('a role without table read is still refused COUNT(*)', async () => {
				const r = await sqlAs(ungrantedHeaders, `SELECT COUNT(*) AS c FROM ${TABLE}`);
				strictEqual(r.status, 403, JSON.stringify(r.body));
			});

			test('super user COUNT(*) and COUNT(*) GROUP BY are unchanged', async () => {
				const total = await sqlAs(null, `SELECT COUNT(*) AS c FROM ${TABLE}`).expect(200);
				deepStrictEqual(total.body, [{ c: 4 }]);
				const grouped = await sqlAs(null, `SELECT salary, COUNT(*) AS c FROM ${TABLE} GROUP BY salary`).expect(200);
				strictEqual((grouped.body as unknown[]).length, 4);
			});
		}
	);
}
