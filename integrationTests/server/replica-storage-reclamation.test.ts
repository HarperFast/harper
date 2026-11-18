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

import {
	createHarperContext,
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
	type StartedHarperTestContext,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'replica-storage-reclamation');
const INTERVAL_MS = 1000;
let replicaIds: string[], ownedId: string;
const skipSuite = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

suite('replicas under storage pressure', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	let owner: StartedHarperTestContext;
	let ownerClient: ReturnType<typeof createApiClient>;
	const options = (shard: number) => ({
		config: {
			replication: { shards: [0, 1], shard },
			STORAGE_RECLAMATION_THRESHOLD: 0.001,
			STORAGE_RECLAMATION_INTERVAL: `${INTERVAL_MS / 1000}s`,
		},
		env: {
			REPLICA_FIXTURE_CORE: resolve(import.meta.dirname, '../../dist'),
			...(shard === 1
				? {
						REPLICA_FIXTURE_OWNER: owner.harper.httpURL,
						REPLICA_FIXTURE_AUTH: ownerClient.headers.Authorization,
					}
				: {}),
		},
	});
	before(async () => {
		owner = await setupHarperWithFixture(createHarperContext('replica-owner'), FIXTURE_PATH, options(0));
		ownerClient = createApiClient(owner.harper);
		await setupHarperWithFixture(ctx, FIXTURE_PATH, options(1));
		client = createApiClient(ctx.harper);
		await request(owner.harper.httpURL)
			.post('/ReplicaFixture/')
			.set(ownerClient.headers)
			.send({ reader: new URL(ctx.harper.httpURL).hostname })
			.expect(200);
		replicaIds = (await client.reqRest('/ReplicaFixture/?keys=pressure').expect(200)).body;
		[ownedId] = (await client.reqRest('/ReplicaFixture/?keys=local&local=true').expect(200)).body;
	});
	after(async () => {
		try {
			if (ctx.harper) await teardownHarper(ctx);
		} finally {
			if (owner) await teardownHarper(owner);
		}
	});

	const quotaPath = () => join(ctx.harper.dataRootDir, 'quota-status.json');
	const reportFullQuota = () =>
		writeFileSync(quotaPath(), JSON.stringify({ usedBytes: 1000, quotaBytes: 1000, updatedAt: Date.now() }));
	const reportNoPressure = () => rmSync(quotaPath(), { force: true });

	async function admit(ids: string[], table = 'Reclaimable', validUntil?: number) {
		for (const id of ids)
			await request(owner.harper.httpURL)
				.put(`/${table}/${id}`)
				.set(ownerClient.headers)
				.send({ id, name: 'indexed', body: 'from the owner', validUntil })
				.expect((response: any) => ok(response.status < 300, response.text));
		await request(ctx.harper.httpURL).post('/ReplicaFixture/').set(client.headers).send({ ids, table }).expect(200);
		for (const id of ids) {
			const read = await client.reqRest(`/${table}/${id}`).expect(200);
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
		// a replica younger than the 30 s minimum age stays under any pressure
		const deadline = Date.now() + 60_000;
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
			.put(`/Reclaimable/${ownedId}`)
			.set(client.headers)
			.send({ id: ownedId, name: 'indexed', body: 'mine' })
			.expect((response: any) => ok(response.status < 300, response.text));
		await admit(replicaIds);
		await waitForReplicaCount(replicaIds.length);
		await delay(INTERVAL_MS * 3);
		const description = await replicaCount();
		strictEqual(description.replica_count, replicaIds.length);
		ok(description.replica_size_estimate > 0, JSON.stringify(description));
		for (const id of replicaIds) strictEqual((await stored(id)).body, 'from the owner');
	});

	test('demotes replicas to stubs on a full quota, leaving owned rows', async () => {
		reportFullQuota();
		await waitForReplicaCount(0);
		for (const id of replicaIds) deepStrictEqual(await stored(id), { name: 'indexed', body: null });
		deepStrictEqual(await stored(ownedId), { name: 'indexed', body: 'mine' });
		strictEqual((await replicaCount()).replica_size_estimate, 0);
	});

	test('a later read fetches a demoted record again, and it stays once the pressure is gone', async () => {
		reportNoPressure();
		await delay(INTERVAL_MS * 3);
		strictEqual((await client.reqRest(`/Reclaimable/${replicaIds[0]}`).expect(200)).body.body, 'from the owner');
		await waitForReplicaCount(1);
		await delay(INTERVAL_MS * 3);
		strictEqual((await replicaCount()).replica_count, 1);
		strictEqual((await stored(replicaIds[0])).body, 'from the owner');
		strictEqual((await stored(replicaIds[1])).body, null);
	});
	const header = async (id: string) =>
		(await client.reqRest(`/ReplicaFixture/?table=Sliding&header=1&id=${id}`).expect(200)).body;
	async function until(condition: () => Promise<boolean>) {
		const end = Date.now() + 15000;
		while (!(await condition())) {
			ok(Date.now() < end, 'timed out waiting for replica maintenance');
			await delay(100);
		}
	}

	test('read hits renew one row while cleanup demotes its idle neighbor', async () => {
		const [hot, cold] = replicaIds;
		await admit([hot, cold], 'Sliding');
		const original = await header(hot);
		ok(original.deadline > Date.now());
		strictEqual(original.sourceLoads, 1);
		await until(async () => {
			strictEqual((await client.reqRest(`/Sliding/${hot}`).expect(200)).body.body, 'from the owner');
			return (await header(cold)).stub;
		});
		const renewed = await header(hot);
		ok(renewed.deadline > original.deadline);
		strictEqual(renewed.sourceLoads, original.sourceLoads);
		strictEqual(renewed.replica, true);
		strictEqual(renewed.body, 'from the owner');
	});

	test('a record with a shorter own expiry stops being served on that expiry', async () => {
		const id = replicaIds[2],
			expiry = Date.now() + 2000;
		await admit([id], 'Sliding', expiry);
		const row = await header(id);
		strictEqual(row.replica, true, JSON.stringify(row));
		strictEqual(row.expiresAt, expiry, JSON.stringify(row));
		await until(async () => Date.now() > expiry);
		await client.reqRest(`/Sliding/${id}`).expect(404);
	});

	test('cleanup demotes an overdue replica after restart without a write', async () => {
		const id = replicaIds[3];
		await admit([id], 'Sliding');
		const deadline = (await header(id)).deadline;
		ok(deadline > Date.now());
		await killHarper(ctx);
		await delay(Math.max(0, deadline - Date.now() + 10));
		await startHarper(ctx, options(1));
		client = createApiClient(ctx.harper);
		await until(async () => (await header(id)).stub);
	});
});
