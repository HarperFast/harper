/**
 * Replicas give way under storage pressure (harper#4101), on real workers: a full quota reported through
 * quota-status.json demotes them back to stubs on the thread that owns the sweep, owned rows stay, a later read fetches
 * the record again, and describe_table reports the count. RocksDB only.
 *
 *   npm run test:integration -- "integrationTests/server/replica-storage-reclamation.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'replica-storage-reclamation');
const INTERVAL_MS = 1000;
const REPLICA_IDS = ['a', 'b', 'c', 'd', 'e'];
const skipSuite = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

suite('replicas under storage pressure', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			// a threshold no real disk is below, so only the quota file below reports pressure
			config: { STORAGE_RECLAMATION_THRESHOLD: 0.001, STORAGE_RECLAMATION_INTERVAL: `${INTERVAL_MS / 1000}s` },
			env: {},
		});
		client = createApiClient(ctx.harper);
	});
	after(async () => {
		await teardownHarper(ctx);
	});

	const quotaPath = () => join(ctx.harper.dataRootDir, 'quota-status.json');
	const reportFullQuota = () =>
		writeFileSync(quotaPath(), JSON.stringify({ usedBytes: 1000, quotaBytes: 1000, updatedAt: Date.now() }));
	const reportNoPressure = () => rmSync(quotaPath(), { force: true });

	async function admit(ids: string[]) {
		await request(ctx.harper.httpURL).post('/ReplicaFixture/').set(client.headers).send({ ids }).expect(200);
		for (const id of ids) {
			const read = await client.reqRest(`/Reclaimable/${id}`).expect(200);
			strictEqual(read.body.body, 'from the owner');
		}
	}
	async function stored(id: string) {
		return (await client.reqRest(`/ReplicaFixture/?id=${id}`).expect(200)).body;
	}
	async function replicaCount() {
		const description = await client.req().send({
			operation: 'describe_table',
			database: 'replicareclamation',
			table: 'Reclaimable',
			exact_count: true,
		});
		strictEqual(description.status, 200, description.text);
		return description.body;
	}
	async function waitForReplicaCount(expected: number) {
		const deadline = Date.now() + 30_000;
		let count: number | undefined;
		while (Date.now() < deadline) {
			count = (await replicaCount()).replica_count;
			if (count === expected) return;
			await delay(100);
		}
		strictEqual(count, expected, 'replica_count');
	}

	test('keeps replicas while free space is above the threshold, and reports their count', async () => {
		await request(ctx.harper.httpURL)
			.put('/Reclaimable/owned')
			.set(client.headers)
			.send({ id: 'owned', name: 'indexed', body: 'mine' })
			.expect((response: any) => ok(response.status < 300, response.text));
		await admit(REPLICA_IDS);
		await waitForReplicaCount(REPLICA_IDS.length);
		await delay(INTERVAL_MS * 3);
		const description = await replicaCount();
		strictEqual(description.replica_count, REPLICA_IDS.length);
		ok(description.replica_size_estimate > 0, JSON.stringify(description));
		for (const id of REPLICA_IDS) strictEqual((await stored(id)).body, 'from the owner');
	});

	test('demotes replicas to stubs on a full quota, leaving owned rows', async () => {
		reportFullQuota();
		await waitForReplicaCount(0);
		for (const id of REPLICA_IDS) deepStrictEqual(await stored(id), { name: 'indexed', body: null });
		deepStrictEqual(await stored('owned'), { name: 'indexed', body: 'mine' });
		strictEqual((await replicaCount()).replica_size_estimate, 0);
	});

	test('a later read fetches a demoted record again, and it stays once the pressure is gone', async () => {
		reportNoPressure();
		await delay(INTERVAL_MS * 3);
		strictEqual((await client.reqRest('/Reclaimable/a').expect(200)).body.body, 'from the owner');
		await waitForReplicaCount(1);
		await delay(INTERVAL_MS * 3);
		strictEqual((await replicaCount()).replica_count, 1);
		strictEqual((await stored('a')).body, 'from the owner');
		strictEqual((await stored('b')).body, null);
	});
});
