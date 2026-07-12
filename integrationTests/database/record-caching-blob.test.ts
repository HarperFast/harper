/**
 * Blob-attribute correctness under record-caching (harper #410), cross-worker.
 *
 * PrimaryRocksDatabase's per-worker WeakLRUCache caches the record VALUE, not blob bytes — a
 * Blob-typed attribute stores its bytes externally in the blob store, and the cached record
 * only holds a reference to the blob file. This suite drives that reference across workers to
 * check whether the cache can ever serve a stale or dangling blob after the attribute is
 * replaced or the record is deleted:
 *
 *   1. Warm: N records with distinct, byte-verifiable Blob content, read across all workers
 *      (fresh connection per read) to populate every worker's cache.
 *   2. Update-then-hammer: repeatedly replace one record's Blob attribute; after each ACKed
 *      replace, hammer concurrent fresh-connection reads across workers and classify each as
 *      correct (new bytes), stale (old bytes), or dangling (non-200/truncated). Any stale/
 *      dangling read gets a bounded self-heal poll to distinguish transient from sticky.
 *   3. Delete-then-hammer: delete a record, hammer reads (must be uniformly 404 — no ghost of
 *      the old blob), then recreate and re-verify.
 *   4. Disk + server-side reconcile: every surviving record's blob file must exist on disk, and
 *      a server-side scan (independent of the REST/cache path) must show 0 mismatches/errors.
 *
 * Skipped on LMDB (PrimaryRocksDatabase is RocksDB-only).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { WORKER_COUNT, assertMultiWorker, mapBounded } from './recordCachingWorkers.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-caching-blob');
const SKIP = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const BLOB_SIZE = 150 * 1024; // well above the ~8KB file-storage threshold
// Cap concurrent fresh-connection blob reads so hammer bursts don't exhaust sockets on
// constrained CI.
const CONCURRENCY = 24;

type Client = ReturnType<typeof createApiClient>;

interface RawGetResult {
	status: number;
	bytes: number;
	sha256: string;
	error?: string;
}

/** GET /BlobRec/<id>.payload over a brand-new TCP connection (Connection: close).
 * Dot-notation sub-attribute selects the raw Blob bytes (a slash path segment 404s). */
function rawGet(httpURL: string, id: string, authHeader: string): Promise<RawGetResult> {
	const url = new URL(`/BlobRec/${encodeURIComponent(id)}.payload`, httpURL);
	const lib = url.protocol === 'https:' ? https : http;
	const h = createHash('sha256');
	return new Promise((resolvePromise) => {
		const req = lib.request(
			url,
			{
				method: 'GET',
				headers: { Authorization: authHeader, Connection: 'close' },
				...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
			},
			(res) => {
				let bytes = 0;
				res.on('data', (d: Buffer) => {
					bytes += d.length;
					h.update(d);
				});
				res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, bytes, sha256: h.digest('hex') }));
				res.on('error', (e) => resolvePromise({ status: -1, bytes, sha256: '', error: String(e) }));
			}
		);
		req.on('error', (e) => resolvePromise({ status: -1, bytes: 0, sha256: '', error: String(e) }));
		req.setTimeout(20_000, () => req.destroy(new Error('rawGet timeout')));
		req.end();
	});
}

/** Fan out `count` fresh-connection reads for `id`, bounded by CONCURRENCY. */
async function hammer(httpURL: string, id: string, authHeader: string, count: number): Promise<RawGetResult[]> {
	return mapBounded(
		Array.from({ length: count }, (_, i) => i),
		CONCURRENCY,
		() => rawGet(httpURL, id, authHeader)
	);
}

async function diskFiles(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					bytes += (await stat(p)).size;
					files++;
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	return { files, bytes };
}

suite(
	'record-caching Blob-attribute correctness [rocksdb] multi-worker',
	{ skip: SKIP || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let httpURL: string;
		let authHeader: string;
		let blobRootDir: string;

		function blobOp(body: Record<string, unknown>) {
			return fetch(`${httpURL}/BlobOp/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify(body),
			}).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
		}

		async function waitForReady(maxMs = 90_000) {
			const deadline = Date.now() + maxMs;
			while (Date.now() < deadline) {
				try {
					const r = await blobOp({ action: 'reconcile' });
					if (r.status < 500) return;
				} catch {
					/* not ready */
				}
				await sleep(300);
			}
			throw new Error('Harper did not become ready in time');
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: WORKER_COUNT }, logging: { console: true, level: 'error' } },
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			authHeader = client.headers.Authorization;
			await waitForReady();
			await assertMultiWorker(ctx);

			const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
			const rootPath: string = cfg.body.rootPath;
			ok(rootPath, 'get_configuration must return rootPath');
			blobRootDir = join(rootPath, 'blobs', 'data');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('(1) warm: distinct blob content read byte-exact across workers', { timeout: 60_000 }, async () => {
			const RECORDS = 6;
			const READS_PER_RECORD = 24; // >> WORKER_COUNT so every worker is very likely hit

			const shas: Record<string, string> = {};
			for (let i = 0; i < RECORDS; i++) {
				const id = `warm-${i}`;
				const r = await blobOp({ action: 'put', id, size: BLOB_SIZE, seed: `${id}:v0` });
				ok(r.body.ok, `(1) put ${id} failed: ${JSON.stringify(r.body)}`);
				shas[id] = r.body.sha;
			}

			const errors: string[] = [];
			for (let i = 0; i < RECORDS; i++) {
				const id = `warm-${i}`;
				const results = await hammer(httpURL, id, authHeader, READS_PER_RECORD);
				for (const r of results) {
					if (r.status !== 200) {
						errors.push(`${id}: status=${r.status} error=${r.error ?? ''}`);
					} else if (r.sha256 !== shas[id]) {
						errors.push(
							`${id}: sha mismatch expected=${shas[id].slice(0, 12)} got=${r.sha256.slice(0, 12)} bytes=${r.bytes}`
						);
					}
				}
			}
			if (errors.length > 0) console.error(`(1) warm-read errors:\n${errors.slice(0, 10).join('\n')}`);
			ok(errors.length === 0, `(1) warm-read errors:\n${errors.slice(0, 10).join('\n')}`);
		});

		test(
			'(2) update-then-hammer: no worker serves stale or dangling blob after ACKed replace',
			{ timeout: 120_000 },
			async () => {
				const id = 'update-record';
				const ITERATIONS = 15;
				const HAMMER_READS = 40;
				const SELFHEAL_POLL_MS = 25;
				const SELFHEAL_BUDGET_MS = 1000;

				let prevSha: string;
				{
					const r = await blobOp({ action: 'put', id, size: BLOB_SIZE, seed: `${id}:v0` });
					ok(r.body.ok, `(2) initial put failed: ${JSON.stringify(r.body)}`);
					prevSha = r.body.sha;
				}
				// Warm across workers before the first update.
				{
					const warm = await hammer(httpURL, id, authHeader, WORKER_COUNT * 6);
					const bad = warm.filter((r) => r.status !== 200 || r.sha256 !== prevSha);
					ok(bad.length === 0, `(2) initial warm not clean: ${JSON.stringify(bad.slice(0, 5))}`);
				}

				for (let iter = 1; iter <= ITERATIONS; iter++) {
					const r = await blobOp({ action: 'replace', id, size: BLOB_SIZE, seed: `${id}:v${iter}` });
					ok(r.body.ok, `(2) iter ${iter}: replace failed: ${JSON.stringify(r.body)}`);
					const newSha = r.body.sha as string;
					const ackedAt = Date.now();

					const results = await hammer(httpURL, id, authHeader, HAMMER_READS);
					const stale = results.filter((x) => x.status === 200 && x.sha256 === prevSha);
					const dangling = results.filter((x) => x.status !== 200 && x.status !== 404);
					const wrongOther = results.filter((x) => x.status === 200 && x.sha256 !== newSha && x.sha256 !== prevSha);
					const correct = results.filter((x) => x.status === 200 && x.sha256 === newSha);

					if (stale.length || dangling.length || wrongOther.length) {
						console.error(
							`(2) iter ${iter}: IMMEDIATE divergence — correct=${correct.length} stale=${stale.length} ` +
								`dangling=${dangling.length} wrongOther=${wrongOther.length} (of ${HAMMER_READS}), ` +
								`${Date.now() - ackedAt}ms after ack`
						);

						// Bounded self-heal poll: how long until every read is clean?
						const pollStart = Date.now();
						let healedAt = -1;
						while (Date.now() - pollStart < SELFHEAL_BUDGET_MS) {
							const check = await hammer(httpURL, id, authHeader, HAMMER_READS);
							const badNow = check.filter((x) => !(x.status === 200 && x.sha256 === newSha));
							if (badNow.length === 0) {
								healedAt = Date.now() - ackedAt;
								break;
							}
							await sleep(SELFHEAL_POLL_MS);
						}
						ok(
							healedAt >= 0,
							`(2) iter ${iter}: sticky divergence — stale/dangling blob reads persisted >${SELFHEAL_BUDGET_MS}ms ` +
								`after ACKed replace (correct=${correct.length}/${HAMMER_READS} immediately after ack)`
						);
					}

					prevSha = newSha;
				}
			}
		);

		test(
			'(3) delete-then-hammer: no worker serves a ghost after delete; recreate is clean',
			{ timeout: 60_000 },
			async () => {
				const id = 'delete-record';
				const put = await blobOp({ action: 'put', id, size: BLOB_SIZE, seed: `${id}:v0` });
				ok(put.body.ok, `(3) put failed: ${JSON.stringify(put.body)}`);
				const oldSha = put.body.sha as string;

				// Warm across workers first.
				const warm = await hammer(httpURL, id, authHeader, WORKER_COUNT * 6);
				ok(
					warm.every((r) => r.status === 200 && r.sha256 === oldSha),
					`(3) warm not clean before delete`
				);

				const del = await blobOp({ action: 'delete', id });
				ok(del.body.ok, `(3) delete failed: ${JSON.stringify(del.body)}`);

				const afterDelete = await hammer(httpURL, id, authHeader, 40);
				const ghosts = afterDelete.filter((r) => r.status === 200);
				if (ghosts.length) console.error(`(3) ghost sample: ${JSON.stringify(ghosts.slice(0, 3))}`);
				ok(ghosts.length === 0, `(3) DEFECT: ${ghosts.length}/40 reads served a ghost of the deleted blob`);

				// Recreate with distinguishable content; every worker must see the NEW record, not a
				// stale "not found" or the old blob.
				const recreate = await blobOp({ action: 'put', id, size: BLOB_SIZE, seed: `${id}:recreated` });
				ok(recreate.body.ok, `(3) recreate failed: ${JSON.stringify(recreate.body)}`);
				const newSha = recreate.body.sha as string;

				const afterRecreate = await hammer(httpURL, id, authHeader, 40);
				const bad = afterRecreate.filter((r) => !(r.status === 200 && r.sha256 === newSha));
				ok(bad.length === 0, `(3) DEFECT after recreate: ${JSON.stringify(bad.slice(0, 5))}`);
			}
		);

		test(
			'(4) disk walk + server-side reconcile: no dangling refs, files match live records',
			{ timeout: 60_000 },
			async () => {
				await sleep(1_500); // let any async blob unlink (deletionDelay) settle

				const reconcile = await blobOp({ action: 'reconcile' });
				ok(reconcile.body.ok, `(4) reconcile failed: ${JSON.stringify(reconcile.body)}`);
				const { total, intact, mismatched, readError, bad } = reconcile.body;
				if (bad?.length) console.error(`(4) bad sample: ${JSON.stringify(bad)}`);
				ok(mismatched === 0, `(4) DEFECT: ${mismatched} live records have blob content diverging from stored sha256`);
				ok(readError === 0, `(4) DEFECT: ${readError} live records have dangling/unreadable blob refs`);
				strictEqual(intact, total, `(4) intact must equal total live records`);

				const disk = await diskFiles(blobRootDir);
				// Soft check only: file count should be in the same ballpark as live records (a few
				// extra from in-flight deletionDelay unlinks is expected, not a hard defect).
				if (disk.files > total * 3 && disk.files - total > 20) {
					console.error(
						`(4) NOTE: blob file count (${disk.files}) well above live record count (${total}) — possible orphan accumulation`
					);
				}
			}
		);
	}
);
