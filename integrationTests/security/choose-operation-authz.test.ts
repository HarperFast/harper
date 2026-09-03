/**
 * Two invariants of operations-API authorization, driven over the real HTTP API:
 * the principal is whatever authentication established, and the operation authorized is the
 * operation invoked. Neither is derived from a request-body field.
 *
 * `chooseOperation` hands `verifyPerms` the nested `search_operation` when present, so that an
 * export job's query is checked. `search_operation` is caller-supplied, so both the principal it
 * carries and the operation name it declares have to be ignored for those two decisions.
 *
 *   CONTROL       — plain `add_user` is refused, proving the role really lacks the grant.
 *   PRINCIPAL     — a nested `hdb_user` does not become the authorization subject.
 *   DISPATCH      — a nested `operation: 'sql'` does not decide which check runs.
 *   DISPATCH-SU   — the same, for an operation registered `requires_su`.
 *   SUBJECT       — a nested object does not become the table subject: `search_operation: {}` on a
 *                   read and on a write must not empty out the table checks.
 *   FORGED-AST    — a body-supplied `parsed_sql_object` does not stand in for an authorized parse.
 *   POSITIVE-SQL  — a direct SQL call the role is granted still works.
 *   POSITIVE-JOB  — a super_user job with a SQL `search_operation` runs to completion.
 *
 * The two POSITIVE cases matter as much as the denials: the checks are additive rather than
 * exclusive, so the fix has to leave the SQL and job paths working.
 *
 * Run:
 *   npm run build && npm run test:integration -- "integrationTests/security/choose-operation-authz.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/choose-operation-authz');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const MALLORY = { username: 'authz_mallory', password: 'Mallory-pw-2173!' };
const ROLE = 'authz_probe_role';
// Mallory's role declares `operations`, so gate 1 refuses anything outside that list before the
// table checks run. The SUBJECT and FORGED-AST cases below are about the table checks themselves, so
// they need principals that actually reach them: TABLER declares no `operations` at all, and
// EXPORTER is granted the export operation but holds no table permission.
const TABLER = { username: 'authz_tabler', password: 'Tabler-pw-2173!' };
const TABLER_ROLE = 'authz_tabler_role';
const EXPORTER = { username: 'authz_exporter', password: 'Exporter-pw-2173!' };
const EXPORTER_ROLE = 'authz_exporter_role';
const DB = 'data';
const TABLE = 'AuthzProbe';

/** Usernames each escalation attempt tries to create; none may exist afterwards. */
const ESCALATION_TARGETS = {
	principal: 'authz_escalated_principal',
	dispatch: 'authz_escalated_dispatch',
};

/** A forged principal claiming super_user, shaped like the object authentication would attach. */
const FORGED_SUPER_USER = {
	username: 'forged',
	role: { role: 'super_user', permission: { super_user: true } },
};

/**
 * Authorization refusals are 403. Asserting the exact status matters here: accepting 401 as well
 * would let these cases pass on a credential failure, i.e. without exercising the check at all.
 */
function assertForbidden(response: { status: number; body: unknown }, context: string): void {
	strictEqual(
		response.status,
		403,
		`${context}: expected 403, got ${response.status} ${JSON.stringify(response.body)}`
	);
}

suite(
	'operations-API authorization uses the authenticated principal and the invoked operation',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let malloryHeaders: Record<string, string>;
		let tablerHeaders: Record<string, string>;
		let exporterHeaders: Record<string, string>;
		// A real writable directory, so a completed export proves the job ran rather than failing on path.
		let exportDir: string;

		/** True if the operations API can see a user by that name — checked as admin. */
		async function userExists(username: string): Promise<boolean> {
			const r = await client.req().send({ operation: 'list_users' }).expect(200);
			ok(Array.isArray(r.body), `list_users did not return a list: ${JSON.stringify(r.body)}`);
			return r.body.some((u: Record<string, unknown>) => u.username === username);
		}

		// Terminal states per JOB_STATUS_ENUM (utility/hdbTerms.ts): CREATED and IN_PROGRESS are not.
		// Testing for the terminal set rather than against the in-flight set keeps a first poll that
		// lands on CREATED from being read as a finished job.
		async function waitForTerminalJob(jobId: string, timeoutMs = 30_000): Promise<Record<string, any> | undefined> {
			const deadline = Date.now() + timeoutMs;
			let job: Record<string, any> | undefined;
			while (Date.now() < deadline) {
				const r = await client.req().send({ operation: 'get_job', id: jobId }).expect(200);
				job = Array.isArray(r.body) ? r.body[0] : r.body;
				if (job?.status === 'COMPLETE' || job?.status === 'ERROR') return job;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return job;
		}

		before(async () => {
			exportDir = mkdtempSync(join(tmpdir(), 'authz-export-'));
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			malloryHeaders = createHeaders(MALLORY.username, MALLORY.password);
			tablerHeaders = createHeaders(TABLER.username, TABLER.password);
			exporterHeaders = createHeaders(EXPORTER.username, EXPORTER.password);

			// Mallory is deliberately minimal: `user_info` only, and read on the probe table so the
			// POSITIVE-SQL case has something legitimate to select. No user management, no SQL grant
			// beyond that table, and emphatically not super_user.
			await client
				.req()
				.send({
					operation: 'add_role',
					role: ROLE,
					permission: {
						super_user: false,
						operations: ['user_info', 'sql'],
						[DB]: {
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

			// No `operations` key: gate 1 is skipped, so a request from this role is decided by the table
			// checks — which is what SUBJECT exercises. Read on the probe table, nothing else, and no
			// grant of any kind on system tables.
			await client
				.req()
				.send({
					operation: 'add_role',
					role: TABLER_ROLE,
					permission: {
						super_user: false,
						[DB]: {
							tables: {
								[TABLE]: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
							},
						},
					},
				})
				.expect(200);
			await client
				.req()
				.send({
					operation: 'add_user',
					role: TABLER_ROLE,
					username: TABLER.username,
					password: TABLER.password,
					active: true,
				})
				.expect(200);

			// Granted the export operation, holding no table permission at all, so an export it is
			// allowed to *invoke* still must not read a table it cannot see.
			await client
				.req()
				.send({
					operation: 'add_role',
					role: EXPORTER_ROLE,
					permission: { super_user: false, operations: ['export_local', 'user_info', 'get_job'] },
				})
				.expect(200);
			await client
				.req()
				.send({
					operation: 'add_user',
					role: EXPORTER_ROLE,
					username: EXPORTER.username,
					password: EXPORTER.password,
					active: true,
				})
				.expect(200);

			await client
				.req()
				.send({ operation: 'insert', schema: DB, table: TABLE, records: [{ id: 'probe-1', label: 'visible' }] })
				.expect(200);
		});

		after(async () => {
			await teardownHarper(ctx);
			rmSync(exportDir, { recursive: true, force: true });
		});

		test('CONTROL — a plain add_user from a non-super_user is refused', async () => {
			const r = await client.reqAs(malloryHeaders).send({
				operation: 'add_user',
				role: 'super_user',
				username: 'authz_control_target',
				password: 'Control-pw-1!',
				active: true,
			});
			assertForbidden(r, 'plain add_user');
			strictEqual(await userExists('authz_control_target'), false);
		});

		test('PRINCIPAL — a forged nested search_operation.hdb_user does not authorize the request', async () => {
			const username = ESCALATION_TARGETS.principal;
			const r = await client.reqAs(malloryHeaders).send({
				operation: 'add_user',
				role: 'super_user',
				username,
				password: 'Escalated-pw-1!',
				active: true,
				search_operation: { operation: 'noop', hdb_user: FORGED_SUPER_USER },
			});
			assertForbidden(r, 'forged nested principal');
			strictEqual(await userExists(username), false, 'forged principal must not create an account');
		});

		test('DISPATCH — a SQL-shaped search_operation does not route add_user past verifyPerms', async () => {
			const username = ESCALATION_TARGETS.dispatch;
			const r = await client.reqAs(malloryHeaders).send({
				operation: 'add_user',
				role: 'super_user',
				username,
				password: 'Escalated-pw-2!',
				active: true,
				search_operation: { operation: 'sql', sql: 'select 1' },
			});
			assertForbidden(r, 'SQL-shaped search_operation');
			strictEqual(await userExists(username), false, 'SQL-shaped search_operation must not create an account');
		});

		test('DISPATCH-SU — a SQL-shaped search_operation does not route export_local past requires_su', async () => {
			const r = await client.reqAs(malloryHeaders).send({
				operation: 'export_local',
				path: '/tmp',
				format: 'json',
				search_operation: { operation: 'sql', sql: 'select 1' },
			});
			assertForbidden(r, 'SQL-shaped search_operation on a requires_su operation');
		});

		// A read and a write, both against a table this role has no grant on. `verifyPerms` derives the
		// tables it checks from the object it is handed, so an empty nested object must not become that
		// object — otherwise there is nothing left to check.
		test('SUBJECT — an empty search_operation does not empty out the table checks (read)', async () => {
			const r = await client.reqAs(tablerHeaders).send({
				operation: 'search_by_value',
				schema: 'system',
				table: 'hdb_user',
				search_attribute: 'username',
				search_value: '*',
				get_attributes: ['username', 'password'],
				search_operation: {},
			});
			assertForbidden(r, 'search_by_value on system.hdb_user with an empty search_operation');
		});

		test('SUBJECT — an empty search_operation does not empty out the table checks (write)', async () => {
			const r = await client.reqAs(tablerHeaders).send({
				operation: 'insert',
				schema: DB,
				table: TABLE,
				records: [{ id: 'subject-injected', label: 'should-not-write' }],
				search_operation: {},
			});
			assertForbidden(r, 'insert with an empty search_operation');

			const check = await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: DB,
					table: TABLE,
					search_attribute: 'id',
					search_value: 'subject-injected',
					get_attributes: ['id'],
				})
				.expect(200);
			strictEqual(check.body.length, 0, `denied insert still wrote a row: ${JSON.stringify(check.body)}`);
		});

		// `parsed_sql_object` carries `permissions_checked`, and the export worker re-reads it off the
		// caller's own nested object, so a body-supplied one would run an AST nothing authorized. The
		// forgery is neutralized rather than refused: the nested field is dropped and the honest `sql`
		// is what runs, which this role is allowed to export — so the assertion is about what the job
		// produced, not about the status code.
		test('FORGED-AST — a body-supplied parsed_sql_object does not select the statement that runs', async () => {
			const started = await client.reqAs(exporterHeaders).send({
				operation: 'export_local',
				path: exportDir,
				format: 'json',
				search_operation: {
					operation: 'sql',
					sql: 'select 1 as harmless',
					parsed_sql_object: {
						variant: 'select',
						permissions_checked: true,
						ast: {
							statements: [{ from: [{ databaseid: 'system', tableid: 'hdb_user' }], columns: [{ columnid: '*' }] }],
						},
					},
				},
			});
			strictEqual(started.status, 200, `expected the honest statement to be accepted: ${JSON.stringify(started.body)}`);
			const job = await waitForTerminalJob(started.body?.job_id);
			strictEqual(job?.status, 'COMPLETE', `export job did not complete: ${JSON.stringify(job)}`);

			const exported = readdirSync(exportDir)
				.map((name) => readFileSync(join(exportDir, name), 'utf8'))
				.join('');
			ok(!exported.includes('password'), 'forged AST reached the export: it contains hdb_user material');
			ok(
				exported.includes('harmless'),
				`export did not contain the honest statement's result: ${exported.slice(0, 200)}`
			);
		});

		// EXPORTER may invoke export_local (its `operations` lists it) but is not otherwise authorized for
		// the underlying read. The outer op is authorized at gate 2 without a table check, and the job
		// worker runs search_by_value with no permission check of its own, so the nested search is
		// authorized at dispatch against its real handler — which denies it. A 200 here means that nested
		// check regressed and the gate-2 export gap reopened.
		test('NESTED-NOSQL — a role granted export_local but not the underlying read cannot export', async () => {
			const r = await client.reqAs(exporterHeaders).send({
				operation: 'export_local',
				path: exportDir,
				format: 'json',
				search_operation: {
					operation: 'search_by_value',
					schema: DB,
					table: TABLE,
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['id'],
				},
			});
			assertForbidden(r, 'export_local of a table the role cannot read');
		});

		test('NESTED-SHAPE — a non-object search_operation is a 400, not a 500', async () => {
			for (const shape of ['not-an-object', 42, true, [], null]) {
				const r = await client
					.reqAs(malloryHeaders)
					.send({ operation: 'export_local', path: exportDir, format: 'json', search_operation: shape });
				strictEqual(
					r.status,
					400,
					`search_operation ${JSON.stringify(shape)}: expected 400, got ${r.status} ${JSON.stringify(r.body)}`
				);
			}
		});

		// An object that names no supported operation ({} or a bogus op) must fail at request time, not
		// dereference `search_operation.operation` in the worker or become an asynchronously-failed job.
		// Shape validation runs before authorization, so an un-granted role still gets the 400.
		test('NESTED-OP — an object search_operation without a supported operation is a 400', async () => {
			for (const search_operation of [{}, { operation: 'not_a_real_op' }, { operation: '' }]) {
				const r = await client
					.reqAs(malloryHeaders)
					.send({ operation: 'export_local', path: exportDir, format: 'json', search_operation });
				strictEqual(
					r.status,
					400,
					`search_operation ${JSON.stringify(search_operation)}: expected 400, got ${r.status} ${JSON.stringify(r.body)}`
				);
			}
		});

		test('POSITIVE-SQL — a direct SQL call the role is granted still succeeds', async () => {
			const r = await client
				.reqAs(malloryHeaders)
				.send({ operation: 'sql', sql: `SELECT id FROM ${DB}.${TABLE} WHERE id = 'probe-1'` })
				.expect(200);
			ok(Array.isArray(r.body) && r.body.length === 1, `expected one row, got ${JSON.stringify(r.body)}`);
		});

		// A 200 here means only that the job was accepted. The job worker re-parses the nested SQL and
		// runs the AST check again, so the export can still be refused after the API has answered —
		// which is the case that matters, since the check that runs there was previously unable to
		// deny at all. Poll to a terminal state.
		test('POSITIVE-JOB — a super_user export_local with a SQL search_operation completes', async () => {
			const started = await client.req().send({
				operation: 'export_local',
				path: exportDir,
				format: 'json',
				search_operation: { operation: 'sql', sql: `SELECT id FROM ${DB}.${TABLE}` },
			});
			strictEqual(started.status, 200, `expected the job to start: ${JSON.stringify(started.body)}`);
			const jobId = started.body?.job_id;
			ok(jobId, `expected a job_id, got ${JSON.stringify(started.body)}`);

			const job = await waitForTerminalJob(jobId);
			strictEqual(job?.status, 'COMPLETE', `export job did not complete: ${JSON.stringify(job)}`);
		});

		// The non-SQL counterpart to POSITIVE-JOB: the nested-read authorization added for the NESTED-NOSQL
		// denial must still let a principal that CAN read the table export it. super_user passes both the
		// outer export check and the nested search_by_value check, so the job runs to completion.
		test('POSITIVE-NOSQL — a super_user export_local with a search_by_value search_operation completes', async () => {
			const started = await client.req().send({
				operation: 'export_local',
				path: exportDir,
				format: 'json',
				search_operation: {
					operation: 'search_by_value',
					schema: DB,
					table: TABLE,
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['id'],
				},
			});
			strictEqual(started.status, 200, `expected the job to start: ${JSON.stringify(started.body)}`);
			const jobId = started.body?.job_id;
			ok(jobId, `expected a job_id, got ${JSON.stringify(started.body)}`);

			const job = await waitForTerminalJob(jobId);
			strictEqual(job?.status, 'COMPLETE', `export job did not complete: ${JSON.stringify(job)}`);
		});
	}
);
