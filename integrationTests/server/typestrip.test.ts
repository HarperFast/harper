/**
 * PR #562: native TypeStrip CLI and worker startup serve real REST reads and writes,
 * with the same compiled CommonJS behavior and configured worker restrictions.
 */
import { suite, test, before, after } from 'node:test';
// oxlint-disable-next-line no-restricted-imports -- repository task requires strict assertions
import { deepStrictEqual, strictEqual, ok } from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { waitFor } from '../../unitTests/waitFor.js';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

for (const mode of ['compiled', 'typestrip']) {
	suite(`REST workers (${mode})`, (ctx: ContextWithHarper) => {
		before(async () => {
			await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'typestrip'), {
				config: {
					threads: { count: 2 },
					authentication: { operationTokenTimeout: '2h', refreshTokenTimeout: '3h' },
					applications: { allowedBuiltinModules: ['worker_threads'] },
				},
				env: {
					HARPER_SQL_ENGINE: 'legacy',
					...(mode === 'typestrip' ? { NODE_OPTIONS: '--conditions=typestrip' } : {}),
				},
				harperBinPath: resolve(
					import.meta.dirname,
					`../../${mode === 'typestrip' ? 'bin/harper.ts' : 'dist/bin/harper.js'}`
				),
			});
		});
		after(async () => {
			await teardownHarper(ctx);
		});

		test('loads cold SQL for date searches, direct queries and export jobs, preserving authorization', async () => {
			const headers = {
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			};
			async function operation(body: object, authorization = headers.Authorization) {
				const response = await fetch(ctx.harper.operationsAPIURL, {
					method: 'POST',
					headers: { ...headers, Authorization: authorization },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(30000),
				});
				return { status: response.status, body: await response.json() };
			}
			const jobs = await operation({
				operation: 'search_jobs_by_start_date',
				from_date: '2000-01-01',
				to_date: '2100-01-01',
			});
			strictEqual(jobs.status, 200, JSON.stringify(jobs.body));
			ok(Array.isArray(jobs.body));
			const sql = `SELECT username FROM system.hdb_user WHERE username = '${ctx.harper.admin.username.replaceAll("'", "''")}'`;
			const query = await operation({ operation: 'sql', sql });
			strictEqual(query.status, 200, JSON.stringify(query.body));
			deepStrictEqual(query.body, [{ username: ctx.harper.admin.username }]);
			const exported = await operation({
				operation: 'export_local',
				path: ctx.harper.dataRootDir,
				filename: 'cold-sql',
				format: 'json',
				search_operation: { operation: 'sql', sql },
			});
			strictEqual(exported.status, 200, JSON.stringify(exported.body));
			await waitFor(
				async () => {
					const result = await operation({ operation: 'get_job', id: exported.body.job_id });
					strictEqual(result.status, 200);
					const job = result.body[0];
					if (job?.status !== 'COMPLETE' && job?.status !== 'ERROR') return false;
					strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
					return true;
				},
				{ timeout: 30000, interval: 100 }
			);
			deepStrictEqual(JSON.parse(await readFile(join(ctx.harper.dataRootDir, 'cold-sql.json'), 'utf8')), query.body);
			strictEqual(
				(
					await operation({
						operation: 'add_role',
						role: 'cold_sql_denied',
						permission: { super_user: false, operations: ['user_info'] },
					})
				).status,
				200
			);
			strictEqual(
				(
					await operation({
						operation: 'add_user',
						role: 'cold_sql_denied',
						username: 'cold_sql_denied',
						password: 'Cold-sql-pw-1!',
						active: true,
					})
				).status,
				200
			);
			const denied = await operation(
				{ operation: 'sql', sql },
				`Basic ${Buffer.from('cold_sql_denied:Cold-sql-pw-1!').toString('base64')}`
			);
			strictEqual(denied.status, 403, JSON.stringify(denied.body));
			ok(JSON.stringify(denied.body).includes("Operation 'sql' is not permitted"));

			const row = { id: 'sql-permissions', value: 'protected' };
			const inserted = await operation({ operation: 'insert', database: 'data', table: 'Probe', records: [row] });
			strictEqual(inserted.status, 200, JSON.stringify(inserted.body));
			for (const [role, tables] of [
				['cold_sql_table_denied', {}],
				[
					'cold_sql_attribute_reader',
					{
						Probe: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [
								{ attribute_name: 'id', read: true, insert: false, update: false },
								{ attribute_name: 'value', read: false, insert: false, update: false },
							],
						},
					},
				],
			] as const) {
				const addedRole = await operation({
					operation: 'add_role',
					role,
					permission: { super_user: false, operations: ['sql'], data: { tables } },
				});
				strictEqual(addedRole.status, 200, JSON.stringify(addedRole.body));
				const addedUser = await operation({
					operation: 'add_user',
					role,
					username: role,
					password: 'Cold-sql-pw-1!',
					active: true,
				});
				strictEqual(addedUser.status, 200, JSON.stringify(addedUser.body));
			}
			const probeSql = "SELECT * FROM data.Probe WHERE id = 'sql-permissions'";
			const tableDenied = await operation(
				{ operation: 'sql', sql: probeSql },
				`Basic ${Buffer.from('cold_sql_table_denied:Cold-sql-pw-1!').toString('base64')}`
			);
			strictEqual(tableDenied.status, 403, JSON.stringify(tableDenied.body));
			ok(!JSON.stringify(tableDenied.body).includes("Operation 'sql' is not permitted"));
			const filtered = await operation(
				{ operation: 'sql', sql: probeSql },
				`Basic ${Buffer.from('cold_sql_attribute_reader:Cold-sql-pw-1!').toString('base64')}`
			);
			strictEqual(filtered.status, 200, JSON.stringify(filtered.body));
			deepStrictEqual(filtered.body, [{ id: row.id }]);
		});

		test('serves requests in workers and persists a REST record', async () => {
			const headers = {
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			};
			const request = (path: string, options = {}) =>
				fetch(`${ctx.harper.httpURL}${path}`, {
					...options,
					headers,
					signal: AbortSignal.timeout(10000),
				});
			const runtime = await request('/Runtime/');
			strictEqual(runtime.status, 200);
			const info = await runtime.json();
			strictEqual(info.isMainThread, false);
			ok(info.threadId > 0);
			ok(info.workerIndex === 0 || info.workerIndex === 1);
			strictEqual(info.noServerStart, false);
			const record = { id: 'source-execution', value: mode };
			const write = await request('/Probe/source-execution', { method: 'PUT', body: JSON.stringify(record) });
			strictEqual(write.status, 204);
			const read = await request('/Probe/source-execution');
			strictEqual(read.status, 200);
			deepStrictEqual(await read.json(), record);
		});

		test('uses the configured token lifetimes', async () => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					operation: 'create_authentication_tokens',
					username: ctx.harper.admin.username,
					password: ctx.harper.admin.password,
				}),
				signal: AbortSignal.timeout(10000),
			});
			strictEqual(response.status, 200);
			const tokens = await response.json();
			for (const [name, seconds] of [
				['operation_token', 7200],
				['refresh_token', 10800],
			] as const) {
				const payload = JSON.parse(Buffer.from(tokens[name].split('.')[1], 'base64url').toString());
				strictEqual(payload.exp - payload.iat, seconds);
			}
		});

		test('enforces the configured builtin allowlist in application code', async () => {
			const response = await fetch(`${ctx.harper.httpURL}/BuiltinCheck/`, {
				headers: {
					Authorization: `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				},
				signal: AbortSignal.timeout(10000),
			});
			strictEqual(response.status, 500);
			ok((await response.text()).includes('Module node:fs is not allowed'));
		});
	});
}
