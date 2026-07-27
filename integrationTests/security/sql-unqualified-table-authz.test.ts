/**
 * GHSA-5c29-q62v-jrwf — a schema-unqualified SQL statement must be authorized against the
 * same database.table the engine will actually touch.
 *
 * The SQL authorization layer derives the affected schema/table set from the AST's
 * `databaseid`. When the statement omits the schema qualifier that field is empty, so
 * `getSelectAttributes` / `addSchemaTableToMap` returned without recording anything and
 * `verifyPermsAST` ran `hasPermissions` against an empty map — which authorizes. The v2
 * engine then resolved the same bare name to a concrete database via `pickDefaultDatabase`
 * and read (or wrote) it, so a role with no grant on the table reached its rows.
 *
 * The tests below drive the ops `sql` operation as a non-super_user whose role holds no
 * permission at all on `UnqualSecret`:
 *
 *   CONTROL   — the schema-qualified form is refused, proving the role really lacks the grant.
 *   READ      — bare `SELECT ... FROM UnqualSecret` must be refused, not served, both as an
 *               indexed lookup (which stays in the v2 engine) and as a full scan (which falls
 *               back to legacy) — the denial must come from authorization, not from an engine
 *               capability accident.
 *   SYSTEM    — bare `SELECT ... FROM hdb_user` must not surrender credential material.
 *   WRITE     — bare DELETE / UPDATE / INSERT must be refused AND must not mutate the table.
 *   JOIN      — a bare JOIN target is bound like a bare FROM target, so it must be authorized too.
 *   WILDCARD  — bare `SELECT *` must be refused; wildcard expansion keys off the resolved
 *               database, so it exercises the resolution write-back on both paths.
 *   POSITIVE  — a bare reference to a table the role *can* read still resolves and returns
 *               rows, so the fix authorizes the resolved name rather than banning bare names.
 *
 * Reproduction:
 *   npm run build && npm run test:integration -- "integrationTests/security/sql-unqualified-table-authz.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/sql-unqualified-authz');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const MALLORY = { username: 'unqual_mallory', password: 'Mallory-pw-5c29!' };
const ROLE = 'unqual_reader_role';
const DB = 'data';
const SECRET_TABLE = 'UnqualSecret';
const PUBLIC_TABLE = 'UnqualPublic';

const VAULT_DB = 'vault';
const VAULT_TABLE = 'UnqualVault';
const VAULT_ROW = 'vault-row-1';
const VAULT_SSN = '999-88-7777';

const SECRET_ROW = 'secret-row-1';
const SECRET_SSN = '111-22-3333';
const PUBLIC_ROW = 'public-row-1';

/** Any of these mean the request was refused rather than served. */
function isDenied(status: number): boolean {
	return status === 401 || status === 403;
}

suite(
	'GHSA-5c29-q62v-jrwf — unqualified SQL table references are authorized',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let malloryHeaders: Record<string, string>;

		/** Read the secret row back as admin, to check a denied write really did not land. */
		async function readSecretRowAsAdmin(): Promise<Record<string, unknown> | undefined> {
			const r = await client
				.req()
				.send({ operation: 'sql', sql: `SELECT * FROM ${DB}.${SECRET_TABLE} WHERE id = '${SECRET_ROW}'` })
				.expect(200);
			return Array.isArray(r.body) ? (r.body[0] as Record<string, unknown> | undefined) : undefined;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			malloryHeaders = createHeaders(MALLORY.username, MALLORY.password);

			// Mallory's role can read UnqualPublic and has NO entry for UnqualSecret — no read,
			// no write, not even describe.
			await client
				.req()
				.send({
					operation: 'add_role',
					role: ROLE,
					permission: {
						super_user: false,
						[DB]: {
							tables: {
								// insert is granted so the INSERT-source test below is decided by its SOURCE
								// table, not by a missing grant on the target.
								[PUBLIC_TABLE]: {
									read: true,
									insert: true,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
							},
						},
						// Table-level read is granted, but `ssn` is denied at the attribute level — the
						// check that only runs if the column's database resolves correctly.
						[VAULT_DB]: {
							tables: {
								[VAULT_TABLE]: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [
										{ attribute_name: 'id', read: true, insert: false, update: false },
										{ attribute_name: 'label', read: true, insert: false, update: false },
										{ attribute_name: 'ssn', read: false, insert: false, update: false },
									],
								},
							},
						},
					},
				})
				.expect(200);

			await client
				.req()
				.send({
					operation: 'add_user',
					role: ROLE,
					username: MALLORY.username,
					password: MALLORY.password,
					active: true,
				})
				.expect(200);

			await client
				.req()
				.send({
					operation: 'insert',
					schema: DB,
					table: SECRET_TABLE,
					records: [{ id: SECRET_ROW, owner: 'victim', ssn: SECRET_SSN }],
				})
				.expect(200);

			await client
				.req()
				.send({
					operation: 'insert',
					schema: DB,
					table: PUBLIC_TABLE,
					records: [{ id: PUBLIC_ROW, label: 'public-label' }],
				})
				.expect(200);

			await client
				.req()
				.send({
					operation: 'insert',
					schema: VAULT_DB,
					table: VAULT_TABLE,
					records: [{ id: VAULT_ROW, label: 'vault-label', ssn: VAULT_SSN }],
				})
				.expect(200);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('CONTROL: schema-qualified SELECT on the forbidden table is denied', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT id, ssn FROM ${DB}.${SECRET_TABLE}` });

			ok(
				isDenied(r.status),
				`CONTROL BROKEN: the role was expected to have no grant on ${DB}.${SECRET_TABLE}, ` +
					`but the qualified SELECT returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		// An indexed WHERE keeps the statement inside the v2 engine; a bare full scan hits
		// EngineUnsupportedError and falls back to legacy, which refuses unqualified names on
		// its own. Both forms must be refused by authorization, not by an engine accident.
		test('unqualified SELECT with an indexed predicate on the forbidden table is denied', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT id, ssn FROM ${SECRET_TABLE} WHERE id = '${SECRET_ROW}'` });

			ok(
				!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
				`AUTHZ BYPASS: the unqualified SELECT leaked the protected ssn value (status=${r.status}): ` +
					`${JSON.stringify(r.body).slice(0, 300)}`
			);
			ok(
				isDenied(r.status),
				`AUTHZ BYPASS: dropping the schema qualifier let a role with no grant on ${DB}.${SECRET_TABLE} ` +
					`run the SELECT (status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('unqualified full-scan SELECT on the forbidden table is denied', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT id, ssn FROM ${SECRET_TABLE}` });

			ok(
				!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
				`AUTHZ BYPASS: the unqualified SELECT leaked the protected ssn value`
			);
			ok(
				isDenied(r.status),
				`AUTHZ BYPASS: dropping the schema qualifier let a role with no grant on ${DB}.${SECRET_TABLE} ` +
					`run the SELECT (status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('unqualified SELECT on a system table is denied', async () => {
			const r = await client.reqAs(malloryHeaders).send({ operation: 'sql', sql: 'SELECT * FROM hdb_user' });

			ok(
				isDenied(r.status),
				`AUTHZ BYPASS: a non-super_user read the system user table via an unqualified reference ` +
					`(status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		// Constructs whose reach the authorization layer cannot determine. None of them execute
		// today (Harper rejects derived tables and ignores SELECT ... INTO), so these lock in the
		// fail-closed denial rather than leaving the outcome to a downstream engine error.
		test('a statement mixing a resolvable table with an unresolvable one is denied', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT * FROM ${DB}.${PUBLIC_TABLE}, ${SECRET_TABLE}` });

			ok(
				!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
				`AUTHZ BYPASS: a multi-table FROM leaked the protected ssn value (status=${r.status})`
			);
			ok(
				isDenied(r.status),
				`AUTHZ BYPASS: a multi-table FROM was authorized on the strength of the table that resolved ` +
					`(status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		// A derived JOIN carries its source on `join.select` with no `join.table`, so it has to be
		// reported explicitly — otherwise it leaves the inventory and attribute collection dies
		// dereferencing join.table, surfacing as a 500 instead of an authorization refusal.
		test('a derived JOIN source wrapping the forbidden table is denied', async () => {
			const r = await client.reqAs(malloryHeaders).send({
				operation: 'sql',
				sql:
					`SELECT p.id FROM ${DB}.${PUBLIC_TABLE} AS p ` +
					`INNER JOIN (SELECT * FROM ${DB}.${SECRET_TABLE}) AS s ON p.id = s.id`,
			});

			ok(
				!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
				`AUTHZ BYPASS: a derived JOIN leaked the protected ssn value (status=${r.status})`
			);
			ok(
				isDenied(r.status),
				`a derived JOIN source must be refused by authorization, not surface as a 500 ` +
					`(status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('a derived table wrapping the forbidden table is denied', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT * FROM (SELECT * FROM ${SECRET_TABLE}) AS sub` });

			ok(
				!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
				`AUTHZ BYPASS: a derived table leaked the protected ssn value (status=${r.status})`
			);
			ok(
				isDenied(r.status),
				`a derived table must be refused by authorization, not left to a downstream error ` +
					`(status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('SELECT ... INTO the forbidden table is denied', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT 1 AS id INTO ${SECRET_TABLE}` });

			ok(
				isDenied(r.status),
				`a SELECT INTO target is invisible to the affected-attribute map and must be refused ` +
					`(status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		// Once bare names resolve, a statement can span two databases with no aliases anywhere. The
		// column's database then has to come from the table-to-schema map: resolving it from the FROM
		// table's database instead drops the column before its attribute permission is checked, so a
		// role with table-level read but `ssn` denied would still receive `ssn`.
		test('attribute-level denial is enforced on an unaliased cross-database join', async () => {
			const r = await client.reqAs(malloryHeaders).send({
				operation: 'sql',
				sql: `SELECT ${VAULT_TABLE}.ssn FROM ${PUBLIC_TABLE} INNER JOIN ${VAULT_TABLE} ON ${PUBLIC_TABLE}.id = ${VAULT_TABLE}.id`,
			});

			ok(
				!JSON.stringify(r.body ?? '').includes(VAULT_SSN),
				`ATTRIBUTE AUTHZ BYPASS: a cross-database join returned an attribute the role is denied ` +
					`(status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('the same denied attribute is refused when selected directly', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT id, ssn FROM ${VAULT_DB}.${VAULT_TABLE}` });

			ok(
				!JSON.stringify(r.body ?? '').includes(VAULT_SSN),
				`ATTRIBUTE AUTHZ BYPASS: a denied attribute was returned (status=${r.status}): ` +
					`${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('a permitted attribute on the same table is still readable', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT id, label FROM ${VAULT_DB}.${VAULT_TABLE}` });

			strictEqual(
				r.status,
				200,
				`REGRESSION: a permitted attribute was refused (status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		// Nested and compound queries are not descended into by the attribute collectors, so a table
		// referenced only from one of them is invisible to permission checking. They must be refused
		// rather than left to whether the engine happens to support them.
		for (const [label, sql] of [
			['a WHERE subquery', `SELECT id FROM ${DB}.${PUBLIC_TABLE} WHERE id IN (SELECT id FROM ${SECRET_TABLE})`],
			['an EXISTS subquery', `SELECT id FROM ${DB}.${PUBLIC_TABLE} WHERE EXISTS (SELECT id FROM ${SECRET_TABLE})`],
			['a UNION branch', `SELECT id FROM ${DB}.${PUBLIC_TABLE} UNION SELECT id FROM ${SECRET_TABLE}`],
			['an INSERT source query', `INSERT INTO ${DB}.${PUBLIC_TABLE} SELECT id, owner AS label FROM ${SECRET_TABLE}`],
		] as [string, string][]) {
			test(`${label} referencing the forbidden table is denied`, async () => {
				const r = await client.reqAs(malloryHeaders).send({ operation: 'sql', sql });

				ok(
					!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
					`AUTHZ BYPASS: ${label} leaked protected data (status=${r.status})`
				);
				ok(
					isDenied(r.status),
					`${label} reaches a table the collectors never record, so it must be refused by ` +
						`authorization (status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
				);
			});
		}

		// The INTO target is a write whose permission isn't modeled. Treating it as a normal named
		// reference would let it satisfy the check on the map entry the FROM collector created.
		test('SELECT INTO is denied even when its target matches the FROM table', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT * INTO ${DB}.${PUBLIC_TABLE} FROM ${DB}.${PUBLIC_TABLE}` });

			ok(
				isDenied(r.status),
				`AUTHZ BYPASS: a SELECT INTO write was authorized by the FROM table's read entry ` +
					`(status=${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('unqualified DELETE on the forbidden table is denied and does not remove the row', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `DELETE FROM ${SECRET_TABLE} WHERE id = '${SECRET_ROW}'` });

			const row = await readSecretRowAsAdmin();
			ok(row, `AUTHZ BYPASS: an unqualified DELETE removed a row the role has no delete grant on (status=${r.status})`);
			ok(isDenied(r.status), `AUTHZ BYPASS: unqualified DELETE was accepted (status=${r.status})`);
		});

		test('unqualified UPDATE on the forbidden table is denied and does not change the row', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `UPDATE ${SECRET_TABLE} SET ssn = 'tampered' WHERE id = '${SECRET_ROW}'` });

			const row = await readSecretRowAsAdmin();
			strictEqual(
				row?.ssn,
				SECRET_SSN,
				`AUTHZ BYPASS: an unqualified UPDATE mutated a row the role has no update grant on (status=${r.status})`
			);
			ok(isDenied(r.status), `AUTHZ BYPASS: unqualified UPDATE was accepted (status=${r.status})`);
		});

		test('unqualified INSERT on the forbidden table is denied and does not add a row', async () => {
			const injectedId = 'injected-row-1';
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `INSERT INTO ${SECRET_TABLE} (id, owner) VALUES ('${injectedId}', 'mallory')` });

			const check = await client
				.req()
				.send({ operation: 'sql', sql: `SELECT id FROM ${DB}.${SECRET_TABLE} WHERE id = '${injectedId}'` })
				.expect(200);
			strictEqual(
				Array.isArray(check.body) ? check.body.length : -1,
				0,
				`AUTHZ BYPASS: an unqualified INSERT wrote to a table the role has no insert grant on (status=${r.status})`
			);
			ok(isDenied(r.status), `AUTHZ BYPASS: unqualified INSERT was accepted (status=${r.status})`);
		});

		// A bare JOIN target is resolved by the binder just like a bare FROM target, so it has to be
		// authorized too — otherwise the forbidden table is reachable as the right-hand side.
		test('unqualified JOIN onto the forbidden table is denied', async () => {
			const r = await client.reqAs(malloryHeaders).send({
				operation: 'sql',
				sql:
					`SELECT p.id, s.ssn FROM ${PUBLIC_TABLE} AS p ` +
					`INNER JOIN ${SECRET_TABLE} AS s ON p.id = s.id WHERE p.id = '${PUBLIC_ROW}'`,
			});

			ok(
				!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
				`AUTHZ BYPASS: an unqualified JOIN leaked the protected ssn value (status=${r.status}): ` +
					`${JSON.stringify(r.body).slice(0, 300)}`
			);
			ok(
				isDenied(r.status),
				`AUTHZ BYPASS: an unqualified JOIN reached a table the role has no grant on (status=${r.status}): ` +
					`${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		// SELECT * expansion is driven by the resolved database (updateAttributeWildcardsForRolePerms
		// reads from[0].databaseid), so it exercises the resolution write-back on the allow path.
		test('unqualified SELECT * on the forbidden table is denied', async () => {
			const r = await client.reqAs(malloryHeaders).send({ operation: 'sql', sql: `SELECT * FROM ${SECRET_TABLE}` });

			ok(
				!JSON.stringify(r.body ?? '').includes(SECRET_SSN),
				`AUTHZ BYPASS: an unqualified SELECT * leaked the protected ssn value (status=${r.status})`
			);
			ok(isDenied(r.status), `AUTHZ BYPASS: an unqualified SELECT * was accepted (status=${r.status})`);
		});

		test('unqualified SELECT * on a permitted table still resolves and returns rows', async () => {
			const r = await client.reqAs(malloryHeaders).send({ operation: 'sql', sql: `SELECT * FROM ${PUBLIC_TABLE}` });

			strictEqual(
				r.status,
				200,
				`REGRESSION: an unqualified SELECT * on a table the role CAN read was refused (status=${r.status}): ` +
					`${JSON.stringify(r.body).slice(0, 300)}`
			);
			const rows = Array.isArray(r.body) ? r.body : [];
			ok(
				rows.some((row: any) => row?.id === PUBLIC_ROW && row?.label === 'public-label'),
				`REGRESSION: unqualified SELECT * on the permitted table returned no usable rows: ` +
					`${JSON.stringify(r.body).slice(0, 300)}`
			);
		});

		test('unqualified SELECT on a permitted table still resolves and returns rows', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT id, label FROM ${PUBLIC_TABLE} WHERE id = '${PUBLIC_ROW}'` });

			strictEqual(
				r.status,
				200,
				`REGRESSION: an unqualified SELECT on a table the role CAN read was refused (status=${r.status}): ` +
					`${JSON.stringify(r.body).slice(0, 300)}`
			);
			const rows = Array.isArray(r.body) ? r.body : [];
			ok(
				rows.some((row: any) => row?.id === PUBLIC_ROW),
				`REGRESSION: unqualified SELECT on the permitted table returned no rows: ${JSON.stringify(r.body).slice(0, 300)}`
			);
		});
	}
);
