import { after, before, suite, test } from 'node:test';
import { strictEqual } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import request from 'supertest';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'expiration-drop-quiesce');
const CONTROL_DIRECTORY = mkdtempSync(join(tmpdir(), 'expiration-drop-quiesce-'));

async function waitFor(predicate: () => boolean, message: string) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(20);
	}
	throw new Error(message);
}

suite('cross-worker expiration cleanup quiesces destructive DDL', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let workerIds: number[];

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 2 }, logging: { level: 'error' } },
			env: { EXPIRATION_QUIESCE_CONTROL: CONTROL_DIRECTORY },
		} as any);
		client = createApiClient(ctx.harper);
		let ready = false;
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			try {
				const response = await request(client.restURL)
					.post('/QuiesceControl/')
					.set(client.headers)
					.timeout(2_000)
					.send({ action: 'probe' });
				if (response.status !== 404) {
					ready = true;
					break;
				}
			} catch {
				// Workers are still loading the pre-installed component.
			}
			await delay(250);
		}
		strictEqual(ready, true, 'QuiesceControl resource did not become ready');
		const probe = await postControl({ action: 'probe' });
		workerIds = probe.body.workerIds;
		strictEqual(workerIds.length, 2, 'the fixture must expose both HTTP workers for deterministic pinning');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function postControl(body: Record<string, unknown>) {
		return request(client.restURL).post('/QuiesceControl/').set(client.headers).timeout(120_000).send(body);
	}

	async function postControlOnWorker(body: Record<string, unknown>, targetThreadId: number) {
		const response = await postControl({ ...body, targetThreadId });
		strictEqual(response.body?.threadId, targetThreadId, `control action did not execute on worker ${targetThreadId}`);
		return response;
	}

	async function proveDropWaitsForWorker(kind: 'indexed' | 'primary') {
		const indexed = kind === 'indexed';
		const database = indexed ? 'quiesce_indexed' : 'quiesce_primary';
		const table = indexed ? 'IndexedExpiry' : 'PrimaryExpiry';
		const runId = `${kind}-${Date.now()}`;
		const [sweepWorkerId, ddlWorkerId] = workerIds;
		await postControl({ action: 'seed', kind, database, table, id: runId }).then((response) =>
			strictEqual(response.status, 200)
		);
		const sweepRunId = `${runId}-sweep`;
		const dropRunId = `${runId}-drop`;
		const started = join(CONTROL_DIRECTORY, `${sweepRunId}.started`);
		const release = join(CONTROL_DIRECTORY, `${runId}.release`);
		const sweep = postControlOnWorker(
			{ action: 'sweep', kind, database, table, runId: sweepRunId, releaseRunId: runId },
			sweepWorkerId
		);
		let dropSettled = false;
		const dropStarted = join(CONTROL_DIRECTORY, `${dropRunId}.started`);
		let drop: ReturnType<typeof postControlOnWorker> | undefined;
		let dropped;
		let primaryError: unknown;
		const cleanupErrors: unknown[] = [];
		try {
			await waitFor(() => existsSync(started), `${kind} sweep did not reach its blocked commit`);
			strictEqual(JSON.parse(readFileSync(started, 'utf8')).threadId, sweepWorkerId);
			drop = postControlOnWorker({ action: 'drop', database, table, runId: dropRunId }, ddlWorkerId).then(
				(response) => {
					dropSettled = true;
					return response;
				}
			);
			await waitFor(() => existsSync(dropStarted), `${kind} drop did not start on its pinned worker`);
			strictEqual(JSON.parse(readFileSync(dropStarted, 'utf8')).threadId, ddlWorkerId);
			strictEqual(sweepWorkerId === ddlWorkerId, false, 'DDL and cleanup must execute on different workers');
			await delay(100);
			strictEqual(dropSettled, false, 'physical drop must wait for the blocked cleanup worker');
		} catch (error) {
			primaryError = error;
		} finally {
			try {
				writeFileSync(release, 'release');
			} catch (error) {
				cleanupErrors.push(error);
			}
			const completions = drop ? [drop, sweep] : [sweep];
			const results = await Promise.allSettled(completions);
			if (drop && results[0].status === 'fulfilled') dropped = results[0].value;
			for (const result of results) if (result.status === 'rejected') cleanupErrors.push(result.reason);
		}
		if (primaryError) throw primaryError;
		if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `${kind} quiescence test cleanup failed`);
		strictEqual(dropped.status, 200);
		strictEqual(dropped.body.threadId, ddlWorkerId);
	}

	test('drop_table waits for a remote indexed expiration sweep', async () => {
		await proveDropWaitsForWorker('indexed');
	});

	test('drop_table waits for a remote primary cleanup scan', async () => {
		await proveDropWaitsForWorker('primary');
	});
});
