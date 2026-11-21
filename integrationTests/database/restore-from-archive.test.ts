/**
 * restore_backup from a get_backup archive, driven through the CLI against a built server: `harper
 * get_backup` downloads the archive, and `harper restore_backup file=` uploads it, online, into a
 * database that does not exist yet, at the next startup, and with Harper stopped. Harper runs with
 * HARPER_EXIT_ON_RESTART, so the restart an on_restart restore requests exits the process, and the test
 * starts it again on the same data directory.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, notDeepStrictEqual, ok, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
	killHarper,
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const run = promisify(execFile);
const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');
const FIXTURE_PATH = resolve(import.meta.dirname, 'restore-from-archive');
const DATABASE = 'archive_restore';
const CLONE = 'archive_restore_clone';
const OPTIONS = {
	config: { threads: { count: 2 }, logging: { console: true, level: 'error' } },
	env: { HARPER_EXIT_ON_RESTART: '1' },
};
const JOB_TIMEOUT_MS = 120_000;
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite('restore_backup restores a get_backup archive (harper#2639)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const scratch = mkdtempSync(join(tmpdir(), 'harper-archive-restore-'));
	const archive = join(scratch, `${DATABASE}.tar.gz`);
	let archived: Record<string, any>;

	function authorization() {
		const { username, password } = ctx.harper.admin;
		return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
	}

	async function post(url: string, body: Record<string, any>): Promise<{ status: number; body: any; text: string }> {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': authorization() },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await res.text();
		let parsed: any = text;
		try {
			parsed = JSON.parse(text);
		} catch {
			/* keep text */
		}
		return { status: res.status, body: parsed, text };
	}

	const op = (operation: Record<string, any>) => post(ctx.harper.operationsAPIURL, operation);

	async function blobs(database: string, body: Record<string, any>): Promise<any> {
		const r = await post(`${ctx.harper.httpURL}/ArchiveRestoreBlobs/`, { database, ...body });
		strictEqual(r.status, 200, `${body.action} on ${database} failed: ${r.text}`);
		return r.body;
	}

	async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
		const deadline = Date.now() + JOB_TIMEOUT_MS;
		let last: unknown;
		while (Date.now() < deadline) {
			try {
				const value = await probe();
				if (value !== undefined) return value;
			} catch (error) {
				last = error;
			}
			await sleep(250);
		}
		throw new Error(`${what} did not happen within ${JOB_TIMEOUT_MS}ms; last error: ${last}`);
	}

	const settledJob = (jobId: string) =>
		until(`job ${jobId} settling`, async () => {
			const r = await op({ operation: 'get_job', id: jobId });
			const record = Array.isArray(r.body) ? r.body[0] : r.body;
			return record?.status === 'COMPLETE' || record?.status === 'ERROR' ? record : undefined;
		});

	/** The CLI as an operator runs it: online against the server's URL, or offline with no target. */
	async function cli(args: string[], { online = true } = {}): Promise<{ exit: number; out: string }> {
		const { username, password } = ctx.harper.admin;
		const target = online
			? [`target=${ctx.harper.operationsAPIURL}`, `auth_username=${username}`, `auth_password=${password}`]
			: [];
		try {
			const r = await run(process.execPath, [HARPER_BIN, ...args, ...target], {
				// a developer's saved login or CLI target must not redirect these commands
				env: {
					...process.env,
					ROOTPATH: ctx.harper.dataRootDir,
					HOME: scratch,
					HARPER_CLI_TARGET: '',
					CLI_TARGET: '',
				},
				timeout: JOB_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
			});
			return { exit: 0, out: `${r.stdout}\n${r.stderr}` };
		} catch (e: any) {
			return { exit: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
		}
	}

	function jobIdOf(out: string): string {
		const jobId = /job_id: ([\w-]+)/.exec(out)?.[1];
		ok(jobId, `no job id in the CLI output:\n${out}`);
		return jobId;
	}

	/** The job completes once the restore publishes; the staging, with what it replaced, is removed right after. */
	const stagingRemoved = () =>
		until('the staging removal', async () => (stagingLeft().length === 0 ? true : undefined));

	function stagingLeft(): string[] {
		const left: string[] = [];
		const visit = (directory: string, depth: number) => {
			if (depth > 4 || !existsSync(directory)) return;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const path = join(directory, entry.name);
				if (entry.name.endsWith('.staged')) left.push(...readdirSync(path).map((id) => join(path, id)));
				else visit(path, depth + 1);
			}
		};
		visit(ctx.harper.dataRootDir, 0);
		return left;
	}

	async function createDatabase(database: string): Promise<void> {
		// declared up front, so no write redeclares the table and leaks a handle an online restore must close
		const t = await op({
			operation: 'create_table',
			database,
			table: 'Items',
			primary_key: 'id',
			attributes: [{ name: 'id', is_primary_key: true }, { name: 'label', indexed: true }, { name: 'data' }],
		});
		strictEqual(t.status, 200, `create_table failed: ${t.text}`);
	}

	async function restartedBy(request: () => Promise<{ exit: number; out: string }>) {
		const firstProcess = ctx.harper.process;
		const exited = new Promise<void>((resolveExit) => {
			if (firstProcess.exitCode !== null || firstProcess.signalCode !== null) resolveExit();
			else firstProcess.once('exit', () => resolveExit());
		});
		const result = await request();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			exited,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('Harper did not restart for the pending restore')), JOB_TIMEOUT_MS);
			}),
		]).finally(() => clearTimeout(timer));
		await startHarper(ctx, OPTIONS);
		return result;
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		await createDatabase(DATABASE);
		await until('the component route', async () => {
			const r = await post(`${ctx.harper.httpURL}/ArchiveRestoreBlobs/`, { database: DATABASE, action: 'snapshot' });
			return r.status === 200 ? true : undefined;
		});
		await blobs(DATABASE, { action: 'put', id: 'a', label: 'archived', seed: 'a-archived' });
		await blobs(DATABASE, { action: 'put', id: 'b', label: 'archived', seed: 'b-archived', size: 300 * 1024 });
		await blobs(DATABASE, { action: 'put', id: 'c', label: 'archived' });
		archived = await blobs(DATABASE, { action: 'snapshot' });
		ok(archived.a.size > 0 && archived.b.size > 0, `precondition: records with blobs: ${JSON.stringify(archived)}`);
		const downloaded = await cli(['get_backup', `database=${DATABASE}`, `out=${archive}`]);
		strictEqual(downloaded.exit, 0, downloaded.out);
		ok(existsSync(archive), downloaded.out);
	});

	after(async () => {
		await teardownHarper(ctx);
		rmSync(scratch, { recursive: true, force: true });
	});

	async function diverge(database: string) {
		await blobs(database, { action: 'put', id: 'a', label: 'live', seed: `a-live-${Date.now()}` });
		await blobs(database, { action: 'delete', id: 'b' });
		await blobs(database, { action: 'put', id: 'd', label: 'live' });
		const live = await blobs(database, { action: 'snapshot' });
		notDeepStrictEqual(live, archived, 'precondition: the live state differs from the archive');
		return live;
	}

	test('online: replaces the database, blobs included, and leaves no staging', async () => {
		await diverge(DATABASE);
		const restored = await cli(['restore_backup', `database=${DATABASE}`, `file=${archive}`]);
		strictEqual(restored.exit, 0, restored.out);
		match(restored.out, /archive_sha256: [0-9a-f]{64}/);
		const job = await settledJob(jobIdOf(restored.out));
		strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		strictEqual(job.result?.restored_from, 'upload');
		deepStrictEqual(await blobs(DATABASE, { action: 'snapshot' }), archived, 'exact records and blob bytes');
		await stagingRemoved();
	});

	test('online: restores into a database that does not exist yet', async () => {
		const restored = await cli(['restore_backup', `database=${CLONE}`, `file=${archive}`]);
		strictEqual(restored.exit, 0, restored.out);
		const job = await settledJob(jobIdOf(restored.out));
		strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		deepStrictEqual(await blobs(CLONE, { action: 'snapshot' }), archived);
		await stagingRemoved();
	});

	test('a corrupt archive leaves the database serving and unchanged', async () => {
		const live = await diverge(DATABASE);
		const corrupt = join(scratch, 'corrupt.tar.gz');
		const bytes = readFileSync(archive);
		writeFileSync(corrupt, bytes.subarray(0, bytes.length - 64));
		const refused = await cli(['restore_backup', `database=${DATABASE}`, `file=${corrupt}`]);
		ok(refused.exit !== 0, `a truncated archive must be refused:\n${refused.out}`);
		match(refused.out, /not a whole get_backup archive|end-of-archive/);
		deepStrictEqual(await blobs(DATABASE, { action: 'snapshot' }), live);
		await stagingRemoved();
	});

	test('an upload refused before it is read is answered at once, and the CLI exits', async () => {
		// far larger than the socket buffers, so the refusal arrives while most of the body is unsent
		const big = join(scratch, 'big.tar.gz');
		writeFileSync(big, Buffer.alloc(256 * 1024 * 1024));
		const started = Date.now();
		const refused = await cli(['restore_backup', `database=${DATABASE}`, `file=${big}`, 'target_database=other']);
		const elapsed = Date.now() - started;
		ok(refused.exit !== 0, `a refused upload must fail the command:\n${refused.out}`);
		match(refused.out, /omit\s+'target_database'/);
		ok(elapsed < 30_000, `the CLI took ${elapsed}ms to report the refusal`);
		rmSync(big, { force: true });
		await stagingRemoved();
	});

	test('an upload refused partway, with most of it unsent, is answered with the refusal rather than a reset', async () => {
		// not an archive: refused at its first tar header, while the socket buffers hold a fraction of it
		const noise = join(scratch, 'noise.tar.gz');
		writeFileSync(noise, randomBytes(64 * 1024 * 1024));
		const started = Date.now();
		const refused = await cli(['restore_backup', `database=${DATABASE}`, `file=${noise}`]);
		const elapsed = Date.now() - started;
		rmSync(noise, { force: true });
		ok(refused.exit !== 0, `a refused upload must fail the command:\n${refused.out}`);
		match(refused.out, /not a whole get_backup archive/);
		ok(elapsed < 30_000, `the CLI took ${elapsed}ms to report the refusal`);
		await stagingRemoved();
	});

	test('on_restart=true: the next startup swaps the proven archive in', async () => {
		await diverge(DATABASE);
		const requested = await restartedBy(() =>
			cli(['restore_backup', `database=${DATABASE}`, `file=${archive}`, 'on_restart=true'])
		);
		strictEqual(requested.exit, 0, requested.out);
		const job = await settledJob(jobIdOf(requested.out));
		strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		ok(Number.isInteger(job.result?.pre_restore_backup_id), `a rollback copy is kept: ${JSON.stringify(job)}`);
		const after = await until('the component route after the restart', async () => {
			const r = await post(`${ctx.harper.httpURL}/ArchiveRestoreBlobs/`, { database: DATABASE, action: 'snapshot' });
			return r.status === 200 && !r.body.missing ? r.body : undefined;
		});
		deepStrictEqual(after, archived);
		await stagingRemoved();
	});

	test('offline: restores the archive with Harper stopped', async () => {
		await diverge(DATABASE);
		await killHarper(ctx);
		const restored = await cli(['restore_backup', `database=${DATABASE}`, `file=${archive}`], { online: false });
		strictEqual(restored.exit, 0, restored.out);
		match(restored.out, /restored_to:/);
		await startHarper(ctx, OPTIONS);
		const after = await until('the component route after the start', async () => {
			const r = await post(`${ctx.harper.httpURL}/ArchiveRestoreBlobs/`, { database: DATABASE, action: 'snapshot' });
			return r.status === 200 && !r.body.missing ? r.body : undefined;
		});
		deepStrictEqual(after, archived);
		await stagingRemoved();
	});
});
