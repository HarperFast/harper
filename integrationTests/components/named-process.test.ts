/**
 * Verifies that Harper HTTP workers share one constrained child with a persisted lifetime identity.
 * Regression: https://github.com/HarperFast/harper/issues/2968
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { WORKER_COUNT, NO_FULL_WORKER_COVERAGE, assertEveryWorkerStarted } from '../database/recordCachingWorkers.ts';
import { fetchOnNewConnection, observeEveryWorker } from '../utils/connectionPerRequest.ts';

suite('named component child process identity', { skip: NO_FULL_WORKER_COVERAGE }, (ctx: ContextWithHarper) => {
	let childPid: number;
	before(async () => {
		await setupHarperWithFixture(ctx, resolve(import.meta.dirname, 'fixtures/named-process'), {
			config: { threads: { count: WORKER_COUNT }, applications: { moduleLoader: 'vm-current-context' } },
		});
		await assertEveryWorkerStarted(ctx);
	});
	after(async () => {
		if (childPid) {
			try {
				process.kill(childPid, 'SIGKILL');
			} catch {}
		}
		await teardownHarper(ctx);
	});
	test('all workers reuse the identified child', async () => {
		const processes = await observeEveryWorker(
			async () => {
				const response = await fetchOnNewConnection(`${ctx.harper.httpURL}/NamedProcess/`);
				strictEqual(response.status, 200);
				const body = (await response.json()) as { pid: number; threadId: number };
				childPid = body.pid;
				return body;
			},
			(body) => body.threadId,
			{ workerCount: WORKER_COUNT }
		);
		strictEqual(new Set(processes.map((body) => body.pid)).size, 1);
		const lines = (await readFile(join(ctx.harper.dataRootDir, 'pids/identity-sidecar.pid'), 'utf8')).split('\n');
		strictEqual(Number(lines[0]), childPid);
		ok(lines[2]?.startsWith('linux:'), 'the shared child must have a recorded birth identity');
	});
});
