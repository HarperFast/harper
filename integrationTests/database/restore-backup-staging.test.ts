import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, match } from 'node:assert';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startHarper, killHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const run = promisify(execFile);
const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');
const DATABASE = 'restore_staging';
const TABLE = 'Items';
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
const JOB_TIMEOUT_MS = 120_000;
const BASE_ROWS = 50;

suite('restore_backup verifies before it replaces (harper#2965)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const baseIds = Array.from({ length: BASE_ROWS }, (_, i) => `base-${i}`);
	let backupId = 0;

	async function op(operation: Record<string, any>): Promise<any> {
		const { username, password } = ctx.harper.admin;
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
			},
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

	async function runJob(operation: Record<string, any>): Promise<any> {
		const started = await op(operation);
		strictEqual(started.status, 200, `${operation.operation} rejected: ${started.text}`);
		const jobId = /Starting job with id ([\w-]+)/.exec(started.body?.message ?? '')?.[1];
		ok(jobId, `no job id in ${started.text}`);
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

	async function createBackup(): Promise<number> {
		const job = await runJob({ operation: 'create_backup', database: DATABASE });
		strictEqual(job.status, 'COMPLETE', `create_backup failed: ${JSON.stringify(job)}`);
		const id = job.result?.backup_id ?? (typeof job.message === 'object' ? job.message?.backup_id : undefined);
		ok(Number.isInteger(id), `no backup_id in job: ${JSON.stringify(job)}`);
		return id;
	}

	async function insert(ids: string[]): Promise<void> {
		const r = await op({
			operation: 'insert',
			database: DATABASE,
			table: TABLE,
			records: ids.map((id) => ({ id, note: `note-${id}` })),
		});
		strictEqual(r.status, 200, `insert failed: ${r.text}`);
	}

	async function readIds(): Promise<string[]> {
		const r = await op({
			operation: 'search_by_value',
			database: DATABASE,
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'note'],
		});
		strictEqual(r.status, 200, `search failed: ${r.text}`);
		for (const row of r.body) strictEqual(row.note, `note-${row.id}`, `row ${row.id} not value-exact`);
		return r.body.map((row: any) => row.id).sort();
	}

	async function expectIds(expected: string[], label: string): Promise<void> {
		deepEqualSorted(await readIds(), expected, label);
	}

	function deepEqualSorted(actual: string[], expected: string[], label: string): void {
		const want = [...expected].sort();
		strictEqual(actual.length, want.length, `${label}: expected ${want.length} rows, got ${actual.length}`);
		strictEqual(actual.join(','), want.join(','), `${label}: row set differs`);
	}

	// The backups root is configurable and the default dir name is an implementation detail, so
	// locate the repository by its `private/<id>` engine directory instead of hard-coding it.
	function findBackupPrivateDir(id: number): string {
		const root = ctx.harper.dataRootDir;
		for (const top of readdirSync(root)) {
			const candidate = join(root, top, DATABASE, 'private', String(id));
			if (existsSync(candidate)) return candidate;
		}
		throw new Error(`no backup repository for ${DATABASE}#${id} under ${root}`);
	}

	function corruptManifest(id: number): void {
		const dir = findBackupPrivateDir(id);
		const manifest = readdirSync(dir).find((f) => f.startsWith('MANIFEST-'));
		ok(manifest, `no MANIFEST-* in ${dir}`);
		const fd = openSync(join(dir, manifest), 'r+');
		try {
			writeSync(fd, Buffer.alloc(64, 0x5a), 0, 64, 0);
		} finally {
			closeSync(fd);
		}
	}

	const start = () =>
		startHarper(ctx, { config: { threads: { count: 3 }, logging: { console: true, level: 'error' } } });

	async function cliRestore(id: number): Promise<{ exit: number; out: string }> {
		try {
			const r = await run(process.execPath, [HARPER_BIN, 'restore_backup', `database=${DATABASE}`, `backup_id=${id}`], {
				env: { ...process.env, ROOTPATH: ctx.harper.dataRootDir },
				timeout: JOB_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
			});
			return { exit: 0, out: `${r.stdout}\n${r.stderr}` };
		} catch (e: any) {
			return { exit: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
		}
	}

	before(async () => {
		await start();
		const t = await op({ operation: 'create_table', database: DATABASE, table: TABLE, primary_key: 'id' });
		ok(t.status === 200, `create_table failed: ${t.text}`);
		await insert(baseIds);
		backupId = await createBackup();
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('online: corrupt backup is refused and the database is untouched', async () => {
		const postIds = Array.from({ length: 10 }, (_, i) => `post-${i}`);
		await insert(postIds);
		corruptManifest(backupId);

		const job = await runJob({ operation: 'restore_backup', database: DATABASE, backup_id: backupId });
		strictEqual(job.status, 'ERROR', `restore of a corrupt backup must fail: ${JSON.stringify(job)}`);
		match(String(job.message), /was not modified/);

		await expectIds([...baseIds, ...postIds], 'after refused restore');
		await insert(['after-refusal']);
		await expectIds([...baseIds, ...postIds, 'after-refusal'], 'after write post-refusal');
	});

	test('offline CLI: corrupt backup is refused and the database is intact after restart', async () => {
		const corruptId = await createBackup();
		const before = await readIds();
		await killHarper(ctx);
		corruptManifest(corruptId);

		const { exit, out } = await cliRestore(corruptId);
		ok(exit !== 0, `CLI restore of a corrupt backup must fail; output:\n${out}`);
		match(out, /was not modified/);

		await start();
		await expectIds(before, 'after offline refusal and restart');
	});

	// The success path runs offline: online, the restore stages but is then refused at the closure check
	// while leaked handles stay open (harper#3120).
	test('offline CLI: a valid backup is staged, swapped in, and survives a restart', async () => {
		const validId = await createBackup();
		const kept = await readIds();
		await insert(['after-valid-backup']);
		await killHarper(ctx);

		const { exit, out } = await cliRestore(validId);
		strictEqual(exit, 0, `CLI restore of a valid backup failed; output:\n${out}`);

		await start();
		await expectIds(kept, 'after restore and restart');
		await insert(['after-restore']);
		await expectIds([...kept, 'after-restore'], 'writable after restore');
	});
});
