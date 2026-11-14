/**
 * The backup operations are super_user only on a running server, whatever a role lists.
 *
 * docs/reference/backups/operations.md: "All backup operations require a `super_user` role when invoked
 * through a running server". docs/reference/users-and-roles/overview.md: the managed-backup operations and
 * `get_backup` "cannot be granted by listing them".
 *
 * A role that lists the managed-backup operations passes the authorization step and is refused only by the
 * handlers' own check, so the roles here are real role records and two of them list every backup operation. Each
 * request is sent over the operations API and as an MCP operations-profile tool call, and each refusal is
 * paired with the super_user's same request taking effect. HARPER_EXIT_ON_RESTART makes an admitted
 * `on_restart` exit the process, so a restart is observable.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DATABASE = 'backup_authz';
const MISSING_DATABASE = 'backup_authz_missing';
const HTTP_COPY = 'backup_authz_http_copy';
const MCP_COPY = 'backup_authz_mcp_copy';
const TABLE = 'Items';
const PASSWORD = 'BackupAuthz-1!';
const JOB_TIMEOUT_MS = 120_000;
const RESTART_EXIT_TIMEOUT_MS = 60_000;
/** An admitted `on_restart` exits the process within a second; a refused one is given this long to. */
const NO_RESTART_WAIT_MS = 3000;
const BACKUP_OPERATIONS = [
	'create_backup',
	'list_backups',
	'verify_backup',
	'delete_backup',
	'purge_backups',
	'restore_backup',
	'get_backup',
];
const ROLE_REFUSAL = /restricted to super_user roles|not authorized due to role restrictions/;
const OPTIONS = {
	config: {
		threads: { count: 2 },
		authentication: { authorizeLocal: false },
		// an explicit allow puts the backup tools on the MCP surface; without it every call is an unknown tool
		mcp: { operations: { mountPath: '/mcp', allow: [...BACKUP_OPERATIONS, 'get_configuration'] } },
	},
	env: { HARPER_EXIT_ON_RESTART: '1', AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const CRUD = { read: true, insert: true, update: true, delete: true, attribute_permissions: [] };
const TABLE_GRANT = { [DATABASE]: { tables: { [TABLE]: CRUD } } };
const ROLES: Record<string, Record<string, unknown>> = {
	backup_authz_none: { super_user: false },
	backup_authz_crud: { super_user: false, ...TABLE_GRANT },
	backup_authz_listed: {
		super_user: false,
		operations: [...BACKUP_OPERATIONS, 'restart', 'get_job', 'get_configuration', 'read_only'],
		...TABLE_GRANT,
	},
	backup_authz_structure: {
		super_user: false,
		structure_user: true,
		operations: [...BACKUP_OPERATIONS, 'restart', 'get_job', 'create_database', 'drop_database', 'standard_user'],
		...TABLE_GRANT,
	},
};
const NON_SUPER_USERS = Object.keys(ROLES).map((role) => `${role}_user`);
const LISTED_USER = 'backup_authz_listed_user';
/** The users whose role lists every backup operation. */
const LISTING_USERS = [LISTED_USER, 'backup_authz_structure_user'];

interface BackupRequest {
	name: string;
	operation: string;
	args: Record<string, unknown>;
}

function backupRequests(backupId: number): BackupRequest[] {
	const restore = (name: string, args: Record<string, unknown>): BackupRequest => ({
		name: `restore_backup ${name}`,
		operation: 'restore_backup',
		args: { database: DATABASE, ...args },
	});
	return [
		{ name: 'create_backup', operation: 'create_backup', args: { database: DATABASE } },
		{ name: 'list_backups', operation: 'list_backups', args: { database: DATABASE } },
		{ name: 'verify_backup', operation: 'verify_backup', args: { database: DATABASE, backup_id: backupId } },
		{ name: 'delete_backup', operation: 'delete_backup', args: { database: DATABASE, backup_id: backupId } },
		{ name: 'purge_backups', operation: 'purge_backups', args: { database: DATABASE, keep_count: 0 } },
		restore('in place', { backup_id: backupId }),
		restore('target_database', { backup_id: backupId, target_database: HTTP_COPY }),
		restore('on_restart', { backup_id: backupId, on_restart: true }),
		restore('on_restart retain_previous:false', { on_restart: true, retain_previous: false }),
		restore('resume', { resume: true }),
		restore('cancel', { cancel: true }),
		restore('system', { database: 'system' }),
		{ name: 'get_backup', operation: 'get_backup', args: { database: DATABASE } },
	];
}

suite('backup operations are super_user only for real roles', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let backupId: number;

	function basicAuth(username: string): string {
		const password = username === ctx.harper.admin.username ? ctx.harper.admin.password : PASSWORD;
		return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
	}

	async function operationAs(
		username: string | null,
		operation: Record<string, unknown>
	): Promise<{ status: number; body: any; text: string; bytes: number }> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (username !== null) headers.Authorization = basicAuth(username);
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers,
			body: JSON.stringify(operation),
			signal: AbortSignal.timeout(60_000),
		});
		const buffer = Buffer.from(await res.arrayBuffer());
		const prefix = buffer.subarray(0, 4000).toString();
		// a get_backup archive is binary: describe it instead of printing it
		const text = /^[\x20-\x7e\s]*$/.test(prefix)
			? prefix
			: `<${buffer.length} bytes of ${res.headers.get('content-type')}>`;
		let body: any = text;
		try {
			body = JSON.parse(buffer.toString());
		} catch {
			// not JSON: `body` stays the text
		}
		return { status: res.status, body, text, bytes: buffer.length };
	}

	const admin = (operation: Record<string, unknown>) => operationAs(ctx.harper.admin.username, operation);

	async function withMcpClient<T>(username: string, use: (client: Client) => Promise<T>): Promise<T> {
		const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.operationsAPIURL), {
			requestInit: { headers: { Authorization: basicAuth(username) } },
		});
		const client = new Client({ name: 'backup-operations-superuser', version: '1.0.0' }, { capabilities: {} });
		try {
			await client.connect(transport);
			return await use(client);
		} finally {
			await transport.close();
		}
	}

	/** A thrown call (unknown tool, transport) is reported as not accepted, with a text no refusal pattern matches. */
	async function toolCall(
		client: Client,
		name: string,
		args: Record<string, unknown> = {}
	): Promise<{ accepted: boolean; text: string }> {
		try {
			const result: any = await client.callTool({ name, arguments: args });
			return { accepted: result.isError !== true, text: String(result.content?.[0]?.text) };
		} catch (error) {
			return { accepted: false, text: `threw: ${(error as Error).message}` };
		}
	}

	function jobIdOf(message: unknown): string {
		const jobId = /Starting job with id ([\w-]+)/.exec(String(message))?.[1];
		ok(jobId, `no job id in ${String(message)}`);
		return jobId;
	}

	async function settledJob(jobId: string): Promise<any> {
		const deadline = Date.now() + JOB_TIMEOUT_MS;
		let last = '';
		while (Date.now() < deadline) {
			const r = await admin({ operation: 'get_job', id: jobId });
			const record = Array.isArray(r.body) ? r.body[0] : r.body;
			if (record?.status === 'COMPLETE' || record?.status === 'ERROR') return record;
			last = r.text.slice(0, 300);
			await delay(500);
		}
		throw new Error(`job ${jobId} did not settle within ${JOB_TIMEOUT_MS}ms; last=${last}`);
	}

	async function completedJob(started: { status: number; body: any; text: string }): Promise<any> {
		strictEqual(started.status, 200, `job request rejected: ${started.text}`);
		const job = await settledJob(jobIdOf(started.body?.message));
		strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		return job;
	}

	async function rowIds(database = DATABASE): Promise<string> {
		const r = await admin({
			operation: 'search_by_value',
			database,
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		});
		strictEqual(r.status, 200, `search of ${database}.${TABLE} failed: ${r.text}`);
		return r.body
			.map((row: any) => row.id)
			.sort()
			.join(',');
	}

	async function backupIds(): Promise<number[]> {
		const r = await admin({ operation: 'list_backups', database: DATABASE });
		strictEqual(r.status, 200, `list_backups failed: ${r.text}`);
		return r.body.map((entry: any) => entry.backup_id).sort((a: number, b: number) => a - b);
	}

	async function jobRows(): Promise<string[]> {
		const r = await admin({
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_job',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'type', 'user'],
		});
		strictEqual(r.status, 200, `search of system.hdb_job failed: ${r.text}`);
		return r.body.map((row: any) => `${row.type}:${row.user}:${row.id}`).sort();
	}

	/** Database directories, and every restore record (intent, marker, lock) beside them. */
	function diskState(): { databases: string[]; restoreRecords: string[] } {
		const root = join(ctx.harper.dataRootDir, 'database');
		const databases: string[] = [];
		const restoreRecords: string[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.name === '`restore`') {
				for (const record of readdirSync(join(root, entry.name))) {
					if (/\.(intent|intent-tmp|restoring|dropping|tmp)$/.test(record)) restoreRecords.push(record);
				}
			} else databases.push(entry.name);
		}
		return { databases: databases.sort(), restoreRecords: restoreRecords.sort() };
	}

	function isRunning(): boolean {
		return ctx.harper.process.exitCode === null && ctx.harper.process.signalCode === null;
	}

	async function state() {
		return {
			backups: await backupIds(),
			rows: await rowIds(),
			jobs: await jobRows(),
			disk: diskState(),
			running: isRunning(),
		};
	}

	/** Statuses are asserted before the state read: an admitted request can leave an instance it cannot reach. */
	async function assertRefusedAndUnchanged(before: Awaited<ReturnType<typeof state>>, failures: string[]) {
		await delay(NO_RESTART_WAIT_MS);
		deepStrictEqual(failures, [], 'backup requests answered other than with a refusal');
		deepStrictEqual(await state(), before, 'state after the refused requests');
	}

	before(async () => {
		await startHarper(ctx, OPTIONS);
		const created = await admin({ operation: 'create_table', database: DATABASE, table: TABLE, primary_key: 'id' });
		strictEqual(created.status, 200, `create_table failed: ${created.text}`);
		const inserted = await admin({
			operation: 'insert',
			database: DATABASE,
			table: TABLE,
			records: [{ id: 'a' }, { id: 'b' }],
		});
		strictEqual(inserted.status, 200, `insert failed: ${inserted.text}`);
		const backup = await completedJob(await admin({ operation: 'create_backup', database: DATABASE }));
		backupId = backup.result?.backup_id;
		ok(Number.isInteger(backupId), `no backup_id in ${JSON.stringify(backup)}`);
		// a row the backup does not hold, so an applied restore is visible in the rows
		const later = await admin({ operation: 'insert', database: DATABASE, table: TABLE, records: [{ id: 'c' }] });
		strictEqual(later.status, 200, `insert failed: ${later.text}`);

		for (const [role, permission] of Object.entries(ROLES)) {
			const addedRole = await admin({ operation: 'add_role', role, permission });
			strictEqual(addedRole.status, 200, `add_role ${role} failed: ${addedRole.text}`);
			const addedUser = await admin({
				operation: 'add_user',
				role,
				username: `${role}_user`,
				password: PASSWORD,
				active: true,
			});
			strictEqual(addedUser.status, 200, `add_user ${role}_user failed: ${addedUser.text}`);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('credentials are required and a role operations list is honoured on both surfaces', async () => {
		const anonymous = await operationAs(null, { operation: 'describe_all' });
		strictEqual(anonymous.status, 401, `credential-less describe_all: ${anonymous.status} ${anonymous.text}`);
		const anonymousMcp = await fetch(new URL('/mcp', ctx.harper.operationsAPIURL), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anonymous', version: '0' } },
			}),
		});
		strictEqual(anonymousMcp.status, 401, `credential-less MCP initialize: ${anonymousMcp.status}`);

		// every non-super user authenticates, so a 403 below is an authorization answer
		for (const username of NON_SUPER_USERS) {
			const info = await operationAs(username, { operation: 'user_info' });
			strictEqual(info.status, 200, `${username} user_info: ${info.status} ${info.text}`);
			strictEqual(info.body?.role?.permission?.super_user, false, `${username} is not a super_user`);
		}

		// get_configuration is super_user-only and grantable: listing it admits the call, so the lists are live
		const listed = await operationAs(LISTED_USER, { operation: 'get_configuration' });
		strictEqual(listed.status, 200, `listed get_configuration: ${listed.status} ${listed.text.slice(0, 300)}`);
		const unlisted = await operationAs('backup_authz_crud_user', { operation: 'get_configuration' });
		strictEqual(unlisted.status, 403, `unlisted get_configuration: ${unlisted.status} ${unlisted.text}`);
		const listedTool = await withMcpClient(LISTED_USER, (client) => toolCall(client, 'get_configuration'));
		ok(listedTool.accepted, `listed get_configuration tool: ${listedTool.text.slice(0, 300)}`);
		const unlistedTool = await withMcpClient('backup_authz_crud_user', (client) =>
			toolCall(client, 'get_configuration')
		);
		ok(
			!unlistedTool.accepted && ROLE_REFUSAL.test(unlistedTool.text),
			`unlisted get_configuration tool: ${unlistedTool.text.slice(0, 300)}`
		);
	});

	test('operations API: every backup request from a non-super_user is refused and changes nothing', async () => {
		const before = await state();
		deepStrictEqual(before.backups, [backupId]);
		strictEqual(before.rows, 'a,b,c');
		deepStrictEqual(before.disk.restoreRecords, []);
		ok(before.running, 'precondition: Harper is running');

		const failures: string[] = [];
		for (const request of backupRequests(backupId)) {
			for (const principal of [null, ...NON_SUPER_USERS]) {
				const r = await operationAs(principal, { operation: request.operation, ...request.args });
				const expected = principal === null ? 401 : 403;
				if (r.status !== expected)
					failures.push(`${request.name} as ${principal ?? 'no credentials'}: ${r.status} ${r.text.slice(0, 200)}`);
			}
		}
		// refused before anything about the database is looked at: a missing one answers the same
		for (const username of NON_SUPER_USERS) {
			for (const operation of ['list_backups', 'restore_backup', 'create_backup']) {
				const existing = await operationAs(username, { operation, database: DATABASE });
				const missing = await operationAs(username, { operation, database: MISSING_DATABASE });
				if (existing.status !== 403 || missing.status !== 403)
					failures.push(`${operation} as ${username}: existing ${existing.status}, missing ${missing.status}`);
				if (existing.text.replaceAll(DATABASE, '<db>') !== missing.text.replaceAll(MISSING_DATABASE, '<db>'))
					failures.push(`${operation} as ${username} answers differently for a missing database`);
			}
		}
		await assertRefusedAndUnchanged(before, failures);
	});

	test('MCP operations profile: every backup tool call from a non-super_user is refused and changes nothing', async () => {
		const before = await state();
		deepStrictEqual(before.backups, [backupId]);
		strictEqual(before.rows, 'a,b,c');
		ok(before.running, 'precondition: Harper is running');

		const failures: string[] = [];
		for (const username of NON_SUPER_USERS) {
			await withMcpClient(username, async (client) => {
				for (const request of backupRequests(backupId)) {
					// get_backup streams bytes and has no tool form for any caller, so its refusal says nothing about the role
					if (request.operation === 'get_backup') continue;
					const r = await toolCall(client, request.operation, request.args);
					if (r.accepted || !ROLE_REFUSAL.test(r.text))
						failures.push(`${request.name} as ${username}: ${r.text.slice(0, 200)}`);
				}
				for (const operation of ['list_backups', 'restore_backup', 'create_backup']) {
					const existing = await toolCall(client, operation, { database: DATABASE });
					const missing = await toolCall(client, operation, { database: MISSING_DATABASE });
					if (!ROLE_REFUSAL.test(existing.text) || !ROLE_REFUSAL.test(missing.text))
						failures.push(`${operation} as ${username}: existing ${existing.text}, missing ${missing.text}`);
					if (existing.text.replaceAll(DATABASE, '<db>') !== missing.text.replaceAll(MISSING_DATABASE, '<db>'))
						failures.push(`${operation} as ${username} answers differently for a missing database`);
				}
			});
		}
		await assertRefusedAndUnchanged(before, failures);
	});

	test('control: the same requests from the super_user take effect on both surfaces', async () => {
		await withMcpClient(ctx.harper.admin.username, async (client) => {
			const listed = await toolCall(client, 'list_backups', { database: DATABASE });
			ok(listed.accepted, `list_backups tool: ${listed.text.slice(0, 300)}`);
			ok(listed.text.includes(`"backup_id":${backupId}`), `list_backups names backup ${backupId}: ${listed.text}`);

			const verified = await toolCall(client, 'verify_backup', { database: DATABASE, backup_id: backupId });
			ok(verified.accepted, `verify_backup tool: ${verified.text.slice(0, 300)}`);
			strictEqual((await settledJob(jobIdOf(verified.text))).status, 'COMPLETE');

			const created = await toolCall(client, 'create_backup', { database: DATABASE });
			ok(created.accepted, `create_backup tool: ${created.text.slice(0, 300)}`);
			const createdJob = await settledJob(jobIdOf(created.text));
			strictEqual(createdJob.status, 'COMPLETE', JSON.stringify(createdJob));
			const secondBackup = createdJob.result?.backup_id;
			deepStrictEqual(await backupIds(), [backupId, secondBackup]);

			const deleted = await toolCall(client, 'delete_backup', { database: DATABASE, backup_id: secondBackup });
			ok(deleted.accepted, `delete_backup tool: ${deleted.text.slice(0, 300)}`);
			deepStrictEqual(await backupIds(), [backupId]);

			const copied = await toolCall(client, 'restore_backup', {
				database: DATABASE,
				backup_id: backupId,
				target_database: MCP_COPY,
			});
			ok(copied.accepted, `restore_backup tool into ${MCP_COPY}: ${copied.text.slice(0, 300)}`);
			strictEqual((await settledJob(jobIdOf(copied.text))).status, 'COMPLETE');
			strictEqual(await rowIds(MCP_COPY), 'a,b', 'the copy holds the backed-up rows');
		});

		const listed = await admin({ operation: 'list_backups', database: DATABASE });
		strictEqual(listed.status, 200, listed.text);
		deepStrictEqual(
			listed.body.map((entry: any) => entry.backup_id),
			[backupId]
		);
		await completedJob(await admin({ operation: 'verify_backup', database: DATABASE, backup_id: backupId }));

		const archive = await admin({ operation: 'get_backup', database: DATABASE });
		strictEqual(archive.status, 200, `get_backup: ${archive.status} ${archive.text.slice(0, 200)}`);
		ok(archive.bytes > 100, `get_backup returned ${archive.bytes} bytes`);

		// nothing is pending, so the super_user reaches the handler's own answer instead of a 403
		for (const mode of ['resume', 'cancel']) {
			const r = await admin({ operation: 'restore_backup', database: DATABASE, [mode]: true });
			strictEqual(r.status, 404, `${mode} with nothing pending: ${r.status} ${r.text}`);
		}

		await completedJob(
			await admin({ operation: 'restore_backup', database: DATABASE, backup_id: backupId, target_database: HTTP_COPY })
		);
		strictEqual(await rowIds(HTTP_COPY), 'a,b', 'the copy holds the backed-up rows');
		strictEqual(await rowIds(), 'a,b,c', 'the source is untouched by a target_database restore');

		await completedJob(await admin({ operation: 'restore_backup', database: DATABASE, backup_id: backupId }));
		strictEqual(await rowIds(), 'a,b', 'the in-place restore removed the row written after the backup');

		const newest = (await completedJob(await admin({ operation: 'create_backup', database: DATABASE }))).result
			?.backup_id;
		const beforePurge = await backupIds();
		ok(beforePurge.length >= 2 && beforePurge.at(-1) === newest, `backups before the purge: ${beforePurge}`);
		const purged = await admin({ operation: 'purge_backups', database: DATABASE, keep_count: 1 });
		strictEqual(purged.status, 200, `purge_backups: ${purged.status} ${purged.text}`);
		deepStrictEqual(await backupIds(), [newest], 'the purge kept only the newest backup');
		backupId = newest;
	});

	test('on_restart: refused for a role that lists restore_backup, and the super_user restarts into the backup', async () => {
		const later = await admin({ operation: 'insert', database: DATABASE, table: TABLE, records: [{ id: 'd' }] });
		strictEqual(later.status, 200, `insert failed: ${later.text}`);
		const liveRows = await rowIds();
		ok(liveRows.split(',').includes('d'), `precondition: the live rows hold d: ${liveRows}`);
		const args = { database: DATABASE, backup_id: backupId, on_restart: true };
		const request = { operation: 'restore_backup', ...args };

		const firstProcess = ctx.harper.process;
		const exited = new Promise<void>((resolveExit) => {
			if (firstProcess.exitCode !== null || firstProcess.signalCode !== null) resolveExit();
			else firstProcess.once('exit', () => resolveExit());
		});

		for (const username of LISTING_USERS) {
			const refused = await operationAs(username, request);
			strictEqual(refused.status, 403, `on_restart as ${username}: ${refused.status} ${refused.text}`);
			const refusedTool = await withMcpClient(username, (client) => toolCall(client, 'restore_backup', args));
			ok(
				!refusedTool.accepted && ROLE_REFUSAL.test(refusedTool.text),
				`on_restart tool as ${username}: ${refusedTool.text.slice(0, 300)}`
			);
		}
		await delay(NO_RESTART_WAIT_MS);
		ok(firstProcess.exitCode === null && firstProcess.signalCode === null, 'a refused on_restart restarted Harper');
		deepStrictEqual(diskState().restoreRecords, [], 'a refused on_restart left a restore record');
		strictEqual(await rowIds(), liveRows);

		const started = await admin(request);
		strictEqual(started.status, 200, `on_restart as the super_user: ${started.status} ${started.text}`);
		const jobId = jobIdOf(started.body?.message);
		let exitTimer: NodeJS.Timeout | undefined;
		await Promise.race([
			exited,
			new Promise((_, reject) => {
				exitTimer = setTimeout(
					() => reject(new Error('Harper did not restart for the super_user on_restart restore')),
					RESTART_EXIT_TIMEOUT_MS
				);
			}),
		]).finally(() => clearTimeout(exitTimer));

		await startHarper(ctx, OPTIONS);
		const restored = await settledJob(jobId);
		strictEqual(restored.status, 'COMPLETE', `on_restart restore: ${JSON.stringify(restored)}`);
		strictEqual(await rowIds(), 'a,b', 'the restart published the backup');
	});
});
