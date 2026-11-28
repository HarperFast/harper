// requires-isolation
/**
 * Regression anchor for HarperFast/harper#4503 ("Keep replica deadlines with their records"):
 * verifies in-header HAS_REPLICA_DEADLINE across 24 KB file-backed Blobs (read-renewal retains
 * the same blob fileId, describe_table replica_size_estimate includes blob bytes, demotion reclaims
 * unreferenced blobs), dual table TTL (expiration+eviction) x replicaExpiration two-pass lifecycle,
 * create_backup / restore_backup(on_restart: true) deadline+blob preservation, and LMDB omission
 * of replica_count/replica_size_estimate.
 *
 * Coverage: B=file-backed-24KB-Blob x C=replicaDeadline+expiration+eviction x
 *           F=read-renewal+demotion+create_backup+restore_backup x H=threads:2 x storage-engine=rocksdb+lmdb.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';

import {
	createHarperContext,
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
	type StartedHarperTestContext,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/replica-deadline-blob-lifecycle');
const CORE_DIR = resolve(import.meta.dirname, '../../dist');
const BLOB_SIZE = 24 * 1024;
const BLOB_RETENTION_MS = 200;

async function blobDiskInventory(dir: string): Promise<{ files: number; bytes: number; paths: string[] }> {
	const paths: string[] = [];
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch (err: any) {
			if (err?.code === 'ENOENT') return;
			throw err;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					const st = await stat(p);
					bytes += st.size;
					paths.push(p);
				} catch (err: any) {
					if (err?.code !== 'ENOENT') throw err;
				}
			}
		}
	}
	await walk(dir);
	paths.sort();
	return { files: paths.length, bytes, paths };
}

async function until<T>(
	label: string,
	timeoutMs: number,
	probe: () => Promise<T | undefined>,
	intervalMs = 150
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			const val = await probe();
			if (val !== undefined) return val;
		} catch (err) {
			lastErr = err;
		}
		await delay(intervalMs);
	}
	throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? `; last error: ${lastErr}` : ''}`);
}

async function waitForBlobCount(
	dir: string,
	expectedFiles: number,
	{ timeoutMs = 4000, minStableMs = 2500, intervalMs = 150 } = {}
) {
	const start = Date.now();
	let cur = await blobDiskInventory(dir);
	let stableSince = start;
	while (cur.files !== expectedFiles && Date.now() - start < timeoutMs) {
		await delay(intervalMs);
		const next = await blobDiskInventory(dir);
		if (next.files !== cur.files || next.bytes !== cur.bytes) stableSince = Date.now();
		cur = next;
		if (Date.now() - stableSince >= minStableMs) break;
	}
	return cur;
}

const skipRocksSuite = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

suite(
	'replicaDeadline lifecycle across file-backed Blobs, dual TTL, and backup/restore',
	{ skip: skipRocksSuite },
	(ctx: ContextWithHarper) => {
		let owner: StartedHarperTestContext;
		let ownerClient: ReturnType<typeof createApiClient>;
		let readerClient: ReturnType<typeof createApiClient>;

		const makeOptions = (shard: number) => ({
			config: {
				replication: { shards: [0, 1], shard },
				storage: { blobRetention: BLOB_RETENTION_MS },
				threads: { count: shard === 0 ? 1 : 2 },
			},
			env: {
				REPLICA_FIXTURE_CORE: CORE_DIR,
				...(shard === 1
					? {
							REPLICA_FIXTURE_OWNER: owner.harper.httpURL,
							REPLICA_FIXTURE_AUTH: ownerClient.headers.Authorization,
							HARPER_EXIT_ON_RESTART: '1',
						}
					: {}),
			},
		});

		async function op(targetClient: ReturnType<typeof createApiClient>, body: Record<string, unknown>) {
			const res = await targetClient.req().send(body);
			return { status: res.status, body: res.body, text: res.text };
		}

		async function postFixture(targetURL: string, headers: Record<string, string>, body: Record<string, unknown>) {
			const res = await request(targetURL).post('/ReplicaBlobFixture/').set(headers).send(body);
			strictEqual(res.status, 200, `POST /ReplicaBlobFixture/ (${body.action}) failed: ${res.status} ${res.text}`);
			return res.body;
		}

		async function getFixture(targetURL: string, headers: Record<string, string>, params: Record<string, string>) {
			const qs = new URLSearchParams(params).toString();
			const res = await request(targetURL).get(`/ReplicaBlobFixture/?${qs}`).set(headers);
			strictEqual(res.status, 200, `GET /ReplicaBlobFixture/?${qs} failed: ${res.status} ${res.text}`);
			return res.body;
		}

		const ownerPost = (body: Record<string, unknown>) => postFixture(owner.harper.httpURL, ownerClient.headers, body);
		const ownerGet = (params: Record<string, string>) => getFixture(owner.harper.httpURL, ownerClient.headers, params);
		const ownerLoads = async (table: string, id: string): Promise<number> =>
			(await ownerGet({ action: 'ownerLoads', table, id })).count;
		const readerPost = (body: Record<string, unknown>) => postFixture(ctx.harper.httpURL, readerClient.headers, body);
		const readerGet = (params: Record<string, string>) => getFixture(ctx.harper.httpURL, readerClient.headers, params);

		async function waitReady(targetURL: string, headers: Record<string, string>) {
			await until('ReplicaBlobFixture ping', 30_000, async () => {
				const res = await request(targetURL).get('/ReplicaBlobFixture/?action=ping').set(headers);
				return res.status === 200 && res.body?.ok ? true : undefined;
			});
		}

		async function findReplicaKeys(table: string, prefix: string, count: number): Promise<string[]> {
			return readerGet({ action: 'keys', table, prefix, local: 'false', count: String(count) });
		}

		async function admitReplica(table: string, id: string, recordFields: Record<string, unknown>, verifyBlob = false) {
			const putRes = await ownerPost({ action: 'putOwner', table, id, ...recordFields });
			await readerPost({ action: 'seedStubs', table, ids: [id] });
			const readRes = await readerPost({ action: 'readRecord', table, id, verifyBlob });
			strictEqual(readRes.found, true, `admitReplica readRecord failed for ${table}/${id}`);
			return { putRes, readRes };
		}

		async function describeTable(database: string, table: string, exactCount: boolean) {
			const res = await op(readerClient, {
				operation: 'describe_table',
				database,
				table,
				exact_count: exactCount,
			});
			strictEqual(res.status, 200, `describe_table ${database}.${table} failed: ${res.text}`);
			return res.body;
		}

		async function runJob(body: Record<string, unknown>) {
			const started = await op(readerClient, body);
			strictEqual(started.status, 200, `start job ${body.operation} failed: ${started.text}`);
			const jobId = /Starting job with id ([\w-]+)/.exec(started.body?.message ?? '')?.[1];
			ok(jobId, `no job id in ${started.text}`);
			return {
				jobId,
				waitSettled: () =>
					until(`job ${jobId}`, 60_000, async () => {
						const r = await op(readerClient, { operation: 'get_job', id: jobId });
						const rec = Array.isArray(r.body) ? r.body[0] : r.body;
						return rec?.status === 'COMPLETE' || rec?.status === 'ERROR' ? rec : undefined;
					}),
			};
		}

		before(async () => {
			owner = await setupHarperWithFixture(createHarperContext('replica-blob-owner'), FIXTURE_PATH, makeOptions(0));
			ownerClient = createApiClient(owner.harper);
			await waitReady(owner.harper.httpURL, ownerClient.headers);

			await setupHarperWithFixture(ctx, FIXTURE_PATH, makeOptions(1));
			readerClient = createApiClient(ctx.harper);
			await waitReady(ctx.harper.httpURL, readerClient.headers);

			await ownerPost({ action: 'setReader', reader: new URL(ctx.harper.httpURL).hostname });
		});

		after(async () => {
			try {
				if (ctx.harper) await teardownHarper(ctx);
			} finally {
				if (owner) await teardownHarper(owner);
			}
		});

		for (const { label, db, table, sharded } of [
			{ label: 'audit: false, legacy residency', db: 'repblob_noaudit', table: 'MediaNoAudit', sharded: false },
			{ label: 'audit: true, @sharded', db: 'repblob_audit', table: 'MediaAudit', sharded: true },
		]) {
			test(`24KB Blob replica renewal, describe_table size, and expiration demotion (${label})`, async () => {
				const blobDir = join(ctx.harper.dataRootDir, 'blobs', db);
				const [hotId, coldId] = await findReplicaKeys(table, `blob-${db}`, 2);

				const hotAdmit = await admitReplica(
					table,
					hotId,
					{ tag: 'media-tag', note: 'hot-media', blobSeed: `${db}-hot`, blobSize: BLOB_SIZE },
					true
				);
				await admitReplica(
					table,
					coldId,
					{ tag: 'media-tag', note: 'cold-media', blobSeed: `${db}-cold`, blobSize: BLOB_SIZE },
					true
				);

				const initialDisk = await blobDiskInventory(blobDir);
				const hotBefore = await readerGet({ action: 'inspect', table, id: hotId, verifyBlob: 'true' });
				const coldBefore = await readerGet({ action: 'inspect', table, id: coldId, verifyBlob: 'true' });
				const descBothExact = await describeTable(db, table, true);

				strictEqual(initialDisk.files, 2);
				ok(initialDisk.bytes >= 2 * BLOB_SIZE);
				strictEqual(hotBefore.flags.replica, true);
				strictEqual(hotBefore.flags.fullWriteHead, true);
				strictEqual(hotBefore.flags.hasReplicaDeadline, true);
				strictEqual(hotBefore.flags.hasBlobs, true);
				strictEqual(hotBefore.blobSha256, hotAdmit.putRes.blobSha256);
				strictEqual(coldBefore.flags.replica, true);
				strictEqual(coldBefore.flags.hasBlobs, true);
				if (sharded) {
					strictEqual(descBothExact.replica_count, 2);
					ok(descBothExact.replica_size_estimate >= 2 * BLOB_SIZE);
				}

				await until(
					`${label}: cold demotion while hot renews`,
					15_000,
					async () => {
						const r = await readerPost({ action: 'readRecord', table, id: hotId, verifyBlob: true });
						strictEqual(r.found, true);
						strictEqual(r.blobSha256, hotAdmit.putRes.blobSha256);
						const c = await readerGet({ action: 'inspect', table, id: coldId });
						return c.flags?.invalidated ? true : undefined;
					},
					250
				);

				const hotAfter = await readerGet({ action: 'inspect', table, id: hotId, verifyBlob: 'true' });
				const hotSourceLoads = await ownerLoads(table, hotId);
				const coldAfter = await readerGet({ action: 'inspect', table, id: coldId });
				const diskAfterDemote = await waitForBlobCount(blobDir, 1, { timeoutMs: 4000, minStableMs: 2500 });

				const descAfterDefault = sharded
					? await until(`${label}: default describe_table`, 8_000, async () => {
							const d = await describeTable(db, table, false);
							return d.replica_count === 1 ? d : undefined;
						})
					: await describeTable(db, table, false);
				const descAfterExact = await describeTable(db, table, true);
				const tagSearch = await readerGet({ action: 'searchTag', table, tag: 'media-tag' });

				ok(hotAfter.replicaDeadline > hotBefore.replicaDeadline, 'hot deadline must advance on renewal');
				strictEqual(hotAfter.version, hotBefore.version, 'hot version must stay unchanged on renewal');
				strictEqual(hotSourceLoads, 1, 'hot replica must not reload from owner');
				strictEqual(hotAfter.flags.hasBlobs, true, 'hot HAS_BLOBS must remain set');
				strictEqual(hotAfter.blobFileId, hotBefore.blobFileId, 'hot blob fileId must stay identical');
				strictEqual(hotAfter.blobSha256, hotAdmit.putRes.blobSha256, 'hot blob bytes must match');

				strictEqual(coldAfter.flags.invalidated, true, 'cold must demote to INVALIDATED');
				strictEqual(coldAfter.flags.replica, false, 'cold REPLICA must clear');
				strictEqual(coldAfter.flags.hasReplicaDeadline, false, 'cold HAS_REPLICA_DEADLINE must clear');
				strictEqual(coldAfter.flags.hasBlobs, false, 'cold HAS_BLOBS must clear');
				ok(tagSearch.indexIds.includes(coldId), 'demoted coldId must remain in secondary tag index');
				if (sharded) {
					ok(descAfterDefault.replica_size_estimate >= BLOB_SIZE);
					ok(descAfterExact.replica_size_estimate >= BLOB_SIZE);
				} else {
					strictEqual(descAfterExact.replica_count, undefined);
				}
				strictEqual(diskAfterDemote.files, 1, 'cold blob file must be reclaimed on demotion');
				ok(
					diskAfterDemote.paths.every(
						(p) => p.endsWith('/' + hotAfter.blobFileId) || p.endsWith('\\' + hotAfter.blobFileId)
					),
					'remaining blob file must match hot blobFileId'
				);
			});
		}

		test('table expiration(2s)+eviction(2s) x replicaExpiration(60s) + 24KB Blob two-pass lifecycle', async () => {
			const db = 'repblob_dual';
			const table = 'DualTtl';
			const blobDir = join(ctx.harper.dataRootDir, 'blobs', db);
			const [repId] = await findReplicaKeys(table, 'dual', 1);

			await admitReplica(table, repId, { tag: 'dual-ttl-tag', blobSeed: 'dual-ttl-blob', blobSize: BLOB_SIZE }, true);

			const afterAdmit = await readerGet({ action: 'inspect', table, id: repId, verifyBlob: 'true' });
			const diskAfterAdmit = await blobDiskInventory(blobDir);
			strictEqual(diskAfterAdmit.files, 1);
			strictEqual(afterAdmit.flags.replica, true);
			strictEqual(afterAdmit.flags.hasExpiration, true);
			strictEqual(afterAdmit.flags.hasReplicaDeadline, true);
			strictEqual(afterAdmit.flags.hasBlobs, true);
			strictEqual(afterAdmit.replicaDeadline, afterAdmit.expiresAt, 'replicaDeadline must cap at shorter expiresAt');

			const pass1 = await until(
				'pass 1 demotion to INVALIDATED stub',
				6_000,
				async () => {
					const s = await readerGet({ action: 'inspect', table, id: repId });
					return s.exists && s.flags?.invalidated ? s : undefined;
				},
				100
			);
			const betweenGet = await readerClient.reqRest(`/${table}/${repId}`);
			const loadsBetween = await ownerLoads(table, repId);
			const diskBetweenPasses = await waitForBlobCount(blobDir, 0, { timeoutMs: 2500, minStableMs: 1500 });

			const pass2 = await until(
				'pass 2 full eviction of expired stub',
				8_000,
				async () => {
					const s = await readerGet({ action: 'inspect', table, id: repId });
					return !s.exists ? s : undefined;
				},
				150
			);
			const tagSearchAfterPass2 = await readerGet({ action: 'searchTag', table, tag: 'dual-ttl-tag' });

			strictEqual(pass1.flags.invalidated, true);
			strictEqual(pass1.flags.replica, false);
			strictEqual(pass1.flags.hasReplicaDeadline, false);
			strictEqual(betweenGet.status, 404);
			strictEqual(loadsBetween, 1);
			strictEqual(diskBetweenPasses.files, 0);
			strictEqual(pass2.exists, false);
			strictEqual(tagSearchAfterPass2.indexIds.includes(repId), false);
		});

		test('create_backup + restore_backup preserves HAS_REPLICA_DEADLINE, replicaDeadline, and 24KB Blob across restart', async () => {
			const db = 'repblob_backup';
			const table = 'BackupTarget';
			const [repId] = await findReplicaKeys(table, 'backup', 1);

			const admit = await admitReplica(
				table,
				repId,
				{ tag: 'backup-tag', blobSeed: 'backup-replica-blob', blobSize: BLOB_SIZE },
				true
			);
			await readerPost({ action: 'flushTable', table });

			const preBackup = await readerGet({ action: 'inspect', table, id: repId, verifyBlob: 'true' });
			strictEqual(preBackup.flags.replica, true);
			strictEqual(preBackup.flags.hasReplicaDeadline, true);
			strictEqual(preBackup.flags.hasBlobs, true);
			strictEqual(preBackup.blobSha256, admit.putRes.blobSha256);

			const backupJob = await runJob({ operation: 'create_backup', database: db });
			const backupResult = await backupJob.waitSettled();
			strictEqual(backupResult.status, 'COMPLETE');
			const backupId = backupResult.result?.backup_id;
			ok(Number.isInteger(backupId));

			await readerPost({ action: 'clearTable', table });
			const clearedState = await readerGet({ action: 'inspect', table, id: repId });
			strictEqual(clearedState.exists, false);

			const firstProcess = ctx.harper.process;
			const exited = new Promise<void>((resolveExit) => {
				if (firstProcess.exitCode !== null || firstProcess.signalCode !== null) resolveExit();
				else firstProcess.once('exit', () => resolveExit());
			});
			const restoreJob = await runJob({
				operation: 'restore_backup',
				database: db,
				backup_id: backupId,
				on_restart: true,
			});

			await Promise.race([
				exited,
				delay(45_000).then(() => {
					throw new Error('Reader did not exit for restore_backup on_restart=true');
				}),
			]);

			await startHarper(ctx, makeOptions(1));
			readerClient = createApiClient(ctx.harper);
			await waitReady(ctx.harper.httpURL, readerClient.headers);

			const restoreResult = await restoreJob.waitSettled();
			strictEqual(restoreResult.status, 'COMPLETE');

			const postRestore = await readerGet({ action: 'inspect', table, id: repId, verifyBlob: 'true' });
			const demotedAfterRestore = await until(
				'restored replica demotion on expiry',
				30_000,
				async () => {
					const s = await readerGet({ action: 'inspect', table, id: repId });
					return s.flags?.invalidated ? s : undefined;
				},
				250
			);

			strictEqual(postRestore.exists, true);
			strictEqual(postRestore.flags.replica, true);
			strictEqual(postRestore.flags.fullWriteHead, true);
			strictEqual(postRestore.flags.hasReplicaDeadline, true);
			strictEqual(postRestore.flags.hasBlobs, true);
			strictEqual(postRestore.replicaDeadline, preBackup.replicaDeadline);
			strictEqual(postRestore.version, preBackup.version);
			strictEqual(postRestore.blobSha256, admit.putRes.blobSha256);
			strictEqual(demotedAfterRestore.flags.invalidated, true);
			strictEqual(demotedAfterRestore.flags.hasReplicaDeadline, false);
		});
	}
);

suite('LMDB control: replicaExpiration table omits replica_count and replica_size_estimate', () => {
	let lmdbCtx: StartedHarperTestContext;
	let lmdbClient: ReturnType<typeof createApiClient>;

	before(async () => {
		lmdbCtx = await setupHarperWithFixture(createHarperContext('replica-blob-lmdb'), FIXTURE_PATH, {
			config: {
				replication: { shards: [0], shard: 0 },
				storage: { blobRetention: BLOB_RETENTION_MS },
				threads: { count: 2 },
			},
			env: {
				HARPER_STORAGE_ENGINE: 'lmdb',
				REPLICA_FIXTURE_CORE: CORE_DIR,
			},
		});
		lmdbClient = createApiClient(lmdbCtx.harper);
		await until('LMDB fixture ping', 30_000, async () => {
			const res = await request(lmdbCtx.harper.httpURL).get('/ReplicaBlobFixture/?action=ping').set(lmdbClient.headers);
			return res.status === 200 && res.body?.ok ? true : undefined;
		});
	});

	after(async () => {
		if (lmdbCtx) await teardownHarper(lmdbCtx);
	});

	test('LMDB table with replicaExpiration serves cleanly and omits replica stats', async () => {
		const mdbPath = join(lmdbCtx.harper.dataRootDir, 'database', 'repblob_lmdb_ctrl.mdb');
		ok(existsSync(mdbPath), `Expected LMDB file at ${mdbPath}`);

		await request(lmdbCtx.harper.httpURL)
			.post('/ReplicaBlobFixture/')
			.set(lmdbClient.headers)
			.send({ action: 'putOwner', table: 'LmdbReplicaOpt', id: 'lmdb-1', tag: 'lmdb-tag', note: 'ok' })
			.expect(200);
		const readRes = await lmdbClient.reqRest('/LmdbReplicaOpt/lmdb-1').expect(200);
		strictEqual(readRes.body.note, 'ok');

		const descDefault = (
			await lmdbClient.req().send({
				operation: 'describe_table',
				database: 'repblob_lmdb_ctrl',
				table: 'LmdbReplicaOpt',
				exact_count: false,
			})
		).body;
		const descExact = (
			await lmdbClient.req().send({
				operation: 'describe_table',
				database: 'repblob_lmdb_ctrl',
				table: 'LmdbReplicaOpt',
				exact_count: true,
			})
		).body;

		strictEqual(descDefault.engine, 'lmdb');
		strictEqual(descDefault.replica_count, undefined);
		strictEqual(descDefault.replica_size_estimate, undefined);
		strictEqual(descExact.replica_count, undefined);
		strictEqual(descExact.replica_size_estimate, undefined);
	});
});
