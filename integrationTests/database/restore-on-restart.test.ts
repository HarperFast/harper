/**
 * restore_backup on_restart=true on a database a component holds: the request records an intent and
 * asks for a drained restart; the next startup applies, proves and publishes the backup before the
 * component loads. Harper runs with HARPER_EXIT_ON_RESTART, so its restart exits the process the way a
 * container restart does, and the test starts it again on the same data directory — the harness can
 * only track a process it started itself.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'restore-on-restart');
const DATABASE = 'restore_on_restart';
const OPTIONS = {
	config: { threads: { count: 2 }, logging: { console: true, level: 'error' } },
	env: { HARPER_EXIT_ON_RESTART: '1' },
};
const JOB_TIMEOUT_MS = 120_000;
const RESTART_EXIT_TIMEOUT_MS = 60_000;
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite('restore_backup on_restart restores a component-held database', { skip: skipSuite }, (ctx: ContextWithHarper) => {
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

	async function blobs(body: Record<string, any>): Promise<any> {
		const r = await post(`${ctx.harper.httpURL}/RestoreRestartBlobs/`, body);
		strictEqual(r.status, 200, `${body.action} failed: ${r.text}`);
		return r.body;
	}

	async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
		const deadline = Date.now() + timeoutMs;
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
		throw new Error(`${what} did not happen within ${timeoutMs}ms; last error: ${last}`);
	}

	function startJob(started: { status: number; body: any; text: string }): string {
		strictEqual(started.status, 200, started.text);
		const jobId = /Starting job with id ([\w-]+)/.exec(started.body?.message ?? '')?.[1];
		ok(jobId, `no job id in ${started.text}`);
		return jobId;
	}

	const settledJob = (jobId: string) =>
		until(`job ${jobId} settling`, JOB_TIMEOUT_MS, async () => {
			const r = await op({ operation: 'get_job', id: jobId });
			const record = Array.isArray(r.body) ? r.body[0] : r.body;
			return record?.status === 'COMPLETE' || record?.status === 'ERROR' ? record : undefined;
		});

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		await until('the component route', JOB_TIMEOUT_MS, async () => {
			const r = await post(`${ctx.harper.httpURL}/RestoreRestartBlobs/`, { action: 'snapshot' });
			return r.status === 200 ? true : undefined;
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('publishes the backup exactly after the restart, and keeps a rollback copy', async () => {
		await blobs({ action: 'put', id: 'a', label: 'backed-up', seed: 'a-backed-up' });
		await blobs({ action: 'put', id: 'b', label: 'backed-up' });
		const backedUp = await blobs({ action: 'snapshot' });
		ok(backedUp.a.size > 0, `precondition: the backed-up record has a blob: ${JSON.stringify(backedUp)}`);
		const backup = await settledJob(startJob(await op({ operation: 'create_backup', database: DATABASE })));
		strictEqual(backup.status, 'COMPLETE', `create_backup failed: ${JSON.stringify(backup)}`);
		const backupId = backup.result?.backup_id;
		ok(Number.isInteger(backupId), `no backup_id in ${JSON.stringify(backup)}`);

		await blobs({ action: 'put', id: 'a', label: 'live', seed: 'a-live' });
		await blobs({ action: 'delete', id: 'b' });
		await blobs({ action: 'put', id: 'c', label: 'live' });
		const live = await blobs({ action: 'snapshot' });
		ok(live.a.sha256 !== backedUp.a.sha256 && !live.b && live.c, 'precondition: the live state differs');

		const firstProcess = ctx.harper.process;
		const exited = new Promise<void>((resolveExit) => {
			if (firstProcess.exitCode !== null || firstProcess.signalCode !== null) resolveExit();
			else firstProcess.once('exit', () => resolveExit());
		});
		const jobId = startJob(
			await op({ operation: 'restore_backup', database: DATABASE, backup_id: backupId, on_restart: true })
		);

		let exitTimer: NodeJS.Timeout | undefined;
		await Promise.race([
			exited,
			new Promise((_, reject) => {
				exitTimer = setTimeout(
					() => reject(new Error('Harper did not restart for the pending restore')),
					RESTART_EXIT_TIMEOUT_MS
				);
			}),
		]).finally(() => clearTimeout(exitTimer));

		await startHarper(ctx, OPTIONS);

		const restored = await settledJob(jobId);
		strictEqual(restored.status, 'COMPLETE', `restore_backup failed: ${JSON.stringify(restored)}`);
		strictEqual(restored.result?.backup_id, backupId);
		const preRestoreId = restored.result?.pre_restore_backup_id;
		ok(Number.isInteger(preRestoreId), `no pre_restore_backup_id in ${JSON.stringify(restored)}`);

		const after = await until('the component route after the restart', JOB_TIMEOUT_MS, async () => {
			const r = await post(`${ctx.harper.httpURL}/RestoreRestartBlobs/`, { action: 'snapshot' });
			return r.status === 200 ? r.body : undefined;
		});
		deepStrictEqual(after, backedUp, 'exact records and blob bytes from the backup');

		const listed = await op({ operation: 'list_backups', database: DATABASE });
		strictEqual(listed.status, 200, listed.text);
		ok(
			listed.body.some((entry: any) => entry.backup_id === preRestoreId),
			`the pre-restore backup is listed: ${listed.text}`
		);
	});
});
