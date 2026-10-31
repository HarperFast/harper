/**
 * restore_backup from a get_backup archive, end to end against a running Harper: the archive is
 * downloaded over the operations API, the data is changed, and the archive is restored through the
 * CLI's `file=` (read in place by a local server) and through a multipart upload. The database's own
 * backup repository must gain nothing, and inputs that are not an archive must change nothing.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const run = promisify(execFile);
const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');
const DATABASE = 'restore_from_archive';
const TABLE = 'Items';
const JOB_TIMEOUT_MS = 120_000;
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite('restore_backup from a get_backup archive', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let workDir: string;
	let archivePath: string;
	const archived = ['a', 'b', 'c'];

	function authorization() {
		const { username, password } = ctx.harper.admin;
		return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	}

	async function op(operation: Record<string, any>): Promise<{ status: number; body: any; text: string }> {
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': authorization() },
			body: JSON.stringify(operation),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await res.text();
		let body: any = text;
		try {
			body = JSON.parse(text);
		} catch {
			/* keep text */
		}
		return { status: res.status, body, text };
	}

	async function settled(jobId: string): Promise<any> {
		const deadline = Date.now() + JOB_TIMEOUT_MS;
		let last = '';
		while (Date.now() < deadline) {
			const r = await op({ operation: 'get_job', id: jobId });
			const record = Array.isArray(r.body) ? r.body[0] : r.body;
			if (record?.status === 'COMPLETE' || record?.status === 'ERROR') return record;
			last = r.text.slice(0, 300);
			await sleep(500);
		}
		throw new Error(`job ${jobId} did not settle within ${JOB_TIMEOUT_MS}ms; last=${last}`);
	}

	function jobIdIn(text: string): string {
		const jobId = /Starting job with id ([\w-]+)/.exec(text)?.[1];
		ok(jobId, `no job id in ${text}`);
		return jobId;
	}

	async function writeRows(ids: string[], note: string): Promise<void> {
		const r = await op({
			operation: 'upsert',
			database: DATABASE,
			table: TABLE,
			records: ids.map((id) => ({ id, note: `${note}-${id}` })),
		});
		strictEqual(r.status, 200, `upsert failed: ${r.text}`);
	}

	async function rows(): Promise<Record<string, string>> {
		const r = await op({
			operation: 'search_by_value',
			database: DATABASE,
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'note'],
		});
		strictEqual(r.status, 200, `search failed: ${r.text}`);
		return Object.fromEntries(r.body.map((row: any) => [row.id, row.note]).sort());
	}

	const archivedRows = () => Object.fromEntries(archived.map((id) => [id, `archived-${id}`]));

	async function changeEverything(): Promise<void> {
		await writeRows(archived, 'changed');
		await writeRows(['after-archive'], 'later');
		deepStrictEqual(Object.keys(await rows()).sort(), [...archived, 'after-archive'].sort());
	}

	async function managedBackups(): Promise<number> {
		const r = await op({ operation: 'list_backups', database: DATABASE });
		// a database whose repository was never created answers 404, which is just as empty
		if (r.status === 404) return 0;
		strictEqual(r.status, 200, `list_backups failed: ${r.text}`);
		return r.body.length;
	}

	function cli(...args: string[]) {
		return run(
			process.execPath,
			[
				HARPER_BIN,
				'restore_backup',
				`database=${DATABASE}`,
				...args,
				`target=${ctx.harper.operationsAPIURL}`,
				`auth_username=${ctx.harper.admin.username}`,
				`auth_password=${ctx.harper.admin.password}`,
			],
			{
				// a developer's saved `harper login` must not redirect this restore
				env: { ...process.env, HOME: workDir, HARPER_CLI_TARGET: '', CLI_TARGET: '' },
				timeout: JOB_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
			}
		);
	}

	async function upload(bytes: Buffer, name: string): Promise<{ status: number; body: any; text: string }> {
		const form = new FormData();
		form.append('operation', 'restore_backup');
		form.append('database', DATABASE);
		// the archive is the last part, after every operation field
		form.append('payload', new Blob([bytes]), name);
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { Authorization: authorization() },
			body: form,
			signal: AbortSignal.timeout(60_000),
		});
		const text = await res.text();
		let body: any = text;
		try {
			body = JSON.parse(text);
		} catch {
			/* keep text */
		}
		return { status: res.status, body, text };
	}

	before(async () => {
		workDir = mkdtempSync(join(tmpdir(), 'harper-restore-from-archive-'));
		await startHarper(ctx, { config: { threads: { count: 2 }, logging: { console: true, level: 'error' } } });
		const created = await op({ operation: 'create_table', database: DATABASE, table: TABLE, primary_key: 'id' });
		strictEqual(created.status, 200, `create_table failed: ${created.text}`);
		await writeRows(archived, 'archived');

		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': authorization() },
			body: JSON.stringify({ operation: 'get_backup', database: DATABASE }),
			signal: AbortSignal.timeout(60_000),
		});
		strictEqual(res.status, 200, `get_backup failed: ${res.status}`);
		archivePath = join(workDir, 'archive.tar.gz');
		writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
	});

	after(async () => {
		await teardownHarper(ctx);
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	test('the CLI restores file= in place on a local server, and the repository gains nothing', async () => {
		const archiveBytes = readFileSync(archivePath);
		const backupsBefore = await managedBackups();
		await changeEverything();

		const { stdout, stderr } = await cli(`file=${archivePath}`);
		doesNotUpload(`${stdout}\n${stderr}`);
		const job = await settled(jobIdIn(`${stdout}\n${stderr}`));

		strictEqual(job.status, 'COMPLETE', `restore failed: ${JSON.stringify(job)}`);
		strictEqual(job.result?.restored_from, archivePath);
		strictEqual(job.result?.backup_id, undefined, 'an archive restore names no managed backup');
		deepStrictEqual(await rows(), archivedRows());
		strictEqual(await managedBackups(), backupsBefore, 'the archive never entered the repository');
		ok(readFileSync(archivePath).equals(archiveBytes), 'the archive was read in place, not changed');
	});

	test('a multipart upload of the archive restores it', async () => {
		await changeEverything();

		const started = await upload(readFileSync(archivePath), 'archive.tar.gz');
		strictEqual(started.status, 200, started.text);
		const job = await settled(jobIdIn(started.body?.message ?? started.text));

		strictEqual(job.status, 'COMPLETE', `restore failed: ${JSON.stringify(job)}`);
		strictEqual(job.result?.restored_from, 'upload');
		deepStrictEqual(await rows(), archivedRows());
	});

	test('a file= that does not exist is refused by the CLI, which sends nothing', async () => {
		await changeEverything();
		const before = await rows();
		const missing = join(workDir, 'missing.tar.gz');

		const failure = await cli(`file=${missing}`).then(
			() => undefined,
			(error) => error
		);

		ok(failure, 'the CLI exits non-zero');
		match(
			`${failure.stdout}\n${failure.stderr}`,
			new RegExp(`file=${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} does not exist`)
		);
		deepStrictEqual(await rows(), before, 'nothing was restored');
	});

	test('an upload that is not an archive fails the job and changes nothing', async () => {
		const before = await rows();

		const started = await upload(randomBytes(4096), 'not-an-archive.tar.gz');
		strictEqual(started.status, 200, started.text);
		const job = await settled(jobIdIn(started.body?.message ?? started.text));

		strictEqual(job.status, 'ERROR');
		match(JSON.stringify(job), /is not a get_backup archive/);
		deepStrictEqual(await rows(), before, 'the database was not touched');
	});

	function doesNotUpload(output: string): void {
		ok(!/uploading it/.test(output), `a local server should read the file in place, but the CLI uploaded: ${output}`);
	}
});
