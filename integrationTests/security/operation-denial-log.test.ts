/**
 * An operation refused by the operations-API permission check: the 403 body is the structured
 * permission report, byte for byte; hdb.log carries the reason once and never `[object Object]`;
 * and a bulk load refused inside its job still reports the permission report as its `get_job` message.
 *
 * Run:
 *   npm run build && npm run test:integration -- "integrationTests/security/operation-denial-log.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const ROLE = 'denial_log_role';
const USER = { username: 'denial_log_user', password: 'Denial-log-pw-1!' };
const LOADER_ROLE = 'denial_log_loader_role';
const LOADER = { username: 'denial_log_loader', password: 'Denial-log-pw-2!' };
const TABLE = 'DenialLogDog';
const OP_AUTH_PERMS_ERROR = 'This operation is not authorized due to role restrictions and/or invalid database items';
const notInOperations = (operation: string) =>
	`Operation '${operation}' is not permitted for this role's operations configuration`;

suite('an operation refused by the permission check', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let userHeaders: Record<string, string>;
	let logPath: string;

	function readLog(): string {
		return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
	}

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		userHeaders = createHeaders(USER.username, USER.password);
		logPath = ctx.harper.logDir ? join(ctx.harper.logDir, 'hdb.log') : join(ctx.harper.dataRootDir, 'log', 'hdb.log');

		await client
			.req()
			.send({ operation: 'add_role', role: ROLE, permission: { super_user: false, operations: ['user_info'] } })
			.expect(200);
		await client
			.req()
			.send({ operation: 'add_user', role: ROLE, username: USER.username, password: USER.password, active: true })
			.expect(200);

		await client
			.req()
			.send({ operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' })
			.expect(200);
		await client
			.req()
			.send({ operation: 'insert', database: 'data', table: TABLE, records: [{ id: 1, name: 'Harper' }] })
			.expect(200);
		await client
			.req()
			.send({
				operation: 'add_role',
				role: LOADER_ROLE,
				permission: {
					super_user: false,
					data: {
						tables: {
							[TABLE]: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{ attribute_name: 'id', read: true, insert: true, update: true },
									{ attribute_name: 'name', read: true, insert: false, update: false },
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
				role: LOADER_ROLE,
				username: LOADER.username,
				password: LOADER.password,
				active: true,
			})
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('answers 403 with the permission report as the body', async () => {
		const response = await client.reqAs(userHeaders).send({ operation: 'list_users' });
		strictEqual(response.status, 403, response.text);
		strictEqual(
			response.text,
			JSON.stringify({
				error: OP_AUTH_PERMS_ERROR,
				unauthorized_access: [notInOperations('list_users')],
				invalid_schema_items: [],
			})
		);
	});

	test('is logged once, with the reason it was refused', async () => {
		const offset = readLog().length;
		const refused = await client
			.reqAs(userHeaders)
			.send({ operation: 'add_user', role: ROLE, username: 'denial_log_other', password: 'Other-pw-1!', active: true });
		strictEqual(refused.status, 403, JSON.stringify(refused.body));
		// A refusal logs every line before its response is sent, and all of them go through the main
		// thread's log in order, so a second refusal made after this one answered marks where the
		// first one's lines end.
		const marker = await client.reqAs(userHeaders).send({ operation: 'list_users' });
		strictEqual(marker.status, 403, JSON.stringify(marker.body));

		const markerLine = '403 from operation list_users';
		const deadline = Date.now() + 15_000;
		let written = readLog().slice(offset);
		while (!written.includes(markerLine) && Date.now() < deadline) {
			await sleep(100);
			written = readLog().slice(offset);
		}
		ok(written.includes(markerLine), `the marker refusal never reached ${logPath}:\n${written}`);

		const firstRefusal = written.slice(0, written.indexOf(markerLine));
		const reasonLines = firstRefusal.split('\n').filter((line) => line.includes(notInOperations('add_user')));
		strictEqual(reasonLines.length, 1, `expected the refusal reason logged once:\n${firstRefusal}`);
		ok(!written.includes('[object Object]'), `a refusal was logged as [object Object]:\n${written}`);
	});

	// The refusal happens in the job worker, and get_job has always answered it with the report
	// object as the job's message.
	test('a bulk load refused on an attribute permission keeps the report as its job message', async () => {
		const started = await client
			.reqAs(createHeaders(LOADER.username, LOADER.password))
			.send({ operation: 'csv_data_load', action: 'insert', database: 'data', table: TABLE, data: 'id,name\n2,Rex\n' });
		strictEqual(started.status, 200, JSON.stringify(started.body));

		const deadline = Date.now() + 30_000;
		let job: Record<string, any> | undefined;
		while (Date.now() < deadline) {
			const response = await client.req().send({ operation: 'get_job', id: started.body.job_id }).expect(200);
			job = response.body[0];
			if (job?.status === 'COMPLETE' || job?.status === 'ERROR') break;
			await sleep(250);
		}
		strictEqual(job?.status, 'ERROR', JSON.stringify(job));
		deepStrictEqual(job.message, {
			error: OP_AUTH_PERMS_ERROR,
			unauthorized_access: [
				{
					schema: 'data',
					table: TABLE,
					required_table_permissions: [],
					required_attribute_permissions: [{ attribute_name: 'name', required_permissions: ['insert'] }],
				},
			],
			invalid_schema_items: [],
		});
	});
});
