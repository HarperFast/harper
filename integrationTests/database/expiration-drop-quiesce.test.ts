import { after, before, suite, test } from 'node:test';
import { strictEqual } from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function postControl(body: Record<string, unknown>) {
		return request(client.restURL).post('/QuiesceControl/').set(client.headers).timeout(120_000).send(body);
	}

	async function proveDropWaitsForWorker(kind: 'indexed' | 'primary') {
		const indexed = kind === 'indexed';
		const database = indexed ? 'quiesce_indexed' : 'quiesce_primary';
		const table = indexed ? 'IndexedExpiry' : 'PrimaryExpiry';
		const runId = `${kind}-${Date.now()}`;
		await postControl({ action: 'seed', kind, database, table, id: runId }).then((response) =>
			strictEqual(response.status, 200)
		);
		const started = join(CONTROL_DIRECTORY, `${runId}.started`);
		const release = join(CONTROL_DIRECTORY, `${runId}.release`);
		const sweep = postControl({ action: 'sweep', kind, database, table, runId });
		await waitFor(() => existsSync(started), `${kind} sweep did not reach its blocked commit`);

		let dropSettled = false;
		const drop = client
			.req()
			.timeout(120_000)
			.send({ operation: 'drop_table', schema: database, table })
			.then((response) => {
				dropSettled = true;
				return response;
			});
		const described = await client.req().timeout(10_000).send({ operation: 'describe_table', schema: database, table });
		strictEqual(described.status, 200, 'the table must remain visible before cross-worker quiescence completes');
		strictEqual(dropSettled, false, 'physical drop must wait for the blocked cleanup worker');

		writeFileSync(release, 'release');
		const dropped = await drop;
		strictEqual(dropped.status, 200);
		await sweep;
	}

	test('drop_table waits for a remote indexed expiration sweep', async () => {
		await proveDropWaitsForWorker('indexed');
	});

	test('drop_table waits for a remote primary cleanup scan', async () => {
		await proveDropWaitsForWorker('primary');
	});
});
