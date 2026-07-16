/**
 * QA-592 — blob x concurrency: N concurrent writers REPLACE the same blob record.
 *
 * Scenario: a digital-asset service where N concurrent writers repeatedly REPLACE the
 * SAME blob-valued record with fresh multi-MB payloads (well above the file-storage
 * threshold, so every write is file-backed).
 *
 *   1. Last-write-wins / no torn reads: does a reader ever see a torn/partial blob, or a
 *      blob whose bytes belong to neither of the written versions? Every write stamps its
 *      OWN sha256 into the SAME record as the blob in one atomic put(), so a reader can
 *      self-check consistency without needing to know which writer/seq is "current".
 *   2. Orphaned blob files: after the storm settles, does `{dataRootDir}/blobs/` contain
 *      files for superseded versions that were never unlinked? Disk files are counted
 *      directly (not inferred from logs) and compared against the known-live-record count
 *      (`control`, written once, + `hot`'s current version == 2).
 *
 * Unlike a quick single settle-check, this polls disk file count over an EXTENDED window
 * (up to 40s past the storm) to distinguish "cleanup just needs more time" from "count is
 * stuck and will never converge" — and it still runs the post-delete check even if the
 * settle check fails, so a single run yields maximal diagnostic signal.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   npm run test:integration -- "integrationTests/database/qa592-blob-concurrent-writers.test.ts"
 * Harper SHA: 3dbcf7b9e (main)
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa592-blob-concurrent-writers');

const WRITER_COUNT = 10;
const ITERS_PER_WRITER = 8; // 80 total REPLACEs of the same key
const READER_COUNT = 4;
const PAYLOAD_SIZE = 2 * 1024 * 1024; // 2MB, well above the file-storage threshold

const SETTLE_STEP_MS = 2_000;
const SETTLE_MAX_STEPS = 20; // up to 40s of polling — deliberately much longer than a quick sanity check

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

/** Recursively count leaf files (blob files live at the bottom of a fan-out dir tree). */
async function countFiles(dir: string): Promise<number> {
	let n = 0;
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
					await stat(p);
					n++;
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	return n;
}

async function listFiles(dir: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
	const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
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
					const s = await stat(p);
					out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	out.sort((a, b) => a.mtimeMs - b.mtimeMs);
	return out;
}

/** Poll `fn` until it returns `target` or the budget runs out; returns the observed trajectory. */
async function pollUntil(
	fn: () => Promise<number>,
	target: number,
	stepMs: number,
	maxSteps: number
): Promise<number[]> {
	const trajectory: number[] = [await fn()];
	for (let i = 0; i < maxSteps && trajectory[trajectory.length - 1] !== target; i++) {
		await sleep(stepMs);
		trajectory.push(await fn());
	}
	return trajectory;
}

suite(
	'QA-592 blob x concurrency: N writers REPLACE the same record (writers variant)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let blobsRoot: string;
		let mainBlobDir: string;
		let dbName: string;
		const findings: string[] = [];
		// Storage engine is decided by HARPER_STORAGE_ENGINE / STORAGE_ENGINE config on the Harper
		// child process; the integration-testing harness forwards the outer test process's env
		// (spawn merges `{ ...process.env, ...harperEnv }`), so this reads the same value the child sees.
		const storageEngine = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb (default)';

		// Heavy concurrent load occasionally trips a transient transport-level hiccup
		// (ECONNRESET / socket hang up) unrelated to the invariants under test — retry those
		// rather than letting the whole storm fail on a connection blip.
		async function op(body: Record<string, unknown>) {
			let lastErr: any;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					return await request(client.restURL ?? (ctx.harper as any).httpURL)
						.post('/AssetOps/')
						.set(client.headers)
						.timeout(30_000)
						.send(body);
				} catch (e: any) {
					lastErr = e;
					const transient = /ECONNRESET|socket hang up|ECONNREFUSED|EPIPE/i.test(String(e?.message ?? e));
					if (!transient) throw e;
					await sleep(50 * (attempt + 1));
				}
			}
			throw lastErr;
		}

		async function opOk(body: Record<string, unknown>) {
			const r = await op(body);
			ok(r.status === 200, `request failed: ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`);
			return r;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 4 }, logging: { root: 'log', level: 'info' } },
				env: {},
			});
			client = createApiClient(ctx.harper);

			const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
			const rootPath = cfg.body.rootPath;
			ok(rootPath, 'get_configuration must return rootPath');
			blobsRoot = join(rootPath, 'blobs');

			// Workers register REST routes async after "started" — poll before asserting.
			await restartHttpWorkers(client, '/Asset/', 120_000);
			findings.push(
				`storage engine: ${storageEngine} (HARPER_STORAGE_ENGINE=${process.env.HARPER_STORAGE_ENGINE ?? '<unset>'})`
			);
		});

		after(async () => {
			await teardownHarper(ctx);
			console.log('\n[QA-592 writers] FINDINGS');
			for (const f of findings) console.log('  ' + f);
		});

		test('concurrent REPLACE storm on one key + concurrent readers: consistency and orphan-file convergence', async () => {
			const seedControl = await opOk({ action: 'write', key: 'control', writer: -1, seq: 0, size: PAYLOAD_SIZE });
			ok(seedControl.body.ok, 'seed write for control key failed');
			const hotSeed = await opOk({ action: 'write', key: 'hot', writer: -1, seq: -1, size: PAYLOAD_SIZE });
			ok(hotSeed.body.ok, 'seed write for hot key failed');
			await sleep(500);

			const dbDirs = (await readdir(blobsRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
			ok(
				dbDirs.length >= 1,
				`expected a default-database blob dir under ${blobsRoot}, found: ${JSON.stringify(dbDirs.map((e) => e.name))}`
			);
			dbName = dbDirs[0].name;
			mainBlobDir = join(blobsRoot, dbName);
			findings.push(`blob dir under test: ${mainBlobDir} (database: ${dbName})`);

			// Ground truth: every sha256 this test successfully wrote to `hot` (client-observed 200s).
			const writtenShas = new Set<string>();
			writtenShas.add(hotSeed.body.sha256);

			let totalReads = 0;
			const mismatches: any[] = [];
			const readErrors: any[] = [];
			const sizeMismatches: any[] = [];
			let stormOver = false;

			async function writerLoop(writerId: number) {
				for (let seq = 0; seq < ITERS_PER_WRITER; seq++) {
					const r = await op({ action: 'write', key: 'hot', writer: writerId, seq, size: PAYLOAD_SIZE });
					ok(
						r.status === 200 && r.body.ok,
						`writer ${writerId} seq ${seq} failed: ${r.status} ${JSON.stringify(r.body)}`
					);
					writtenShas.add(r.body.sha256);
				}
			}

			async function readerLoop() {
				while (!stormOver) {
					const r = await op({ action: 'read', key: 'hot' });
					totalReads++;
					if (r.status !== 200 || !r.body.ok) {
						readErrors.push({ status: r.status, body: r.body });
					} else if (!r.body.found) {
						readErrors.push({ note: 'hot key unexpectedly absent mid-storm' });
					} else if (r.body.readError) {
						readErrors.push({ readError: r.body.readError, writer: r.body.writer, seq: r.body.seq });
					} else {
						if (r.body.shaMatch !== true) {
							mismatches.push({
								declared: r.body.declaredSha,
								actual: r.body.actualSha,
								writer: r.body.writer,
								seq: r.body.seq,
							});
						}
						if (r.body.bytesLen !== PAYLOAD_SIZE) {
							sizeMismatches.push({ bytesLen: r.body.bytesLen, writer: r.body.writer, seq: r.body.seq });
						}
					}
				}
			}

			const writers = Array.from({ length: WRITER_COUNT }, (_, i) => writerLoop(i));
			const readers = Array.from({ length: READER_COUNT }, () => readerLoop());

			await Promise.all(writers);
			stormOver = true;
			await Promise.all(readers);

			findings.push(
				`storm: ${WRITER_COUNT} writers x ${ITERS_PER_WRITER} iters = ${WRITER_COUNT * ITERS_PER_WRITER} REPLACEs on 'hot', ` +
					`${totalReads} concurrent reads (${READER_COUNT} reader loops)`
			);
			findings.push(
				`torn/mismatched reads: ${mismatches.length}, size mismatches: ${sizeMismatches.length}, read errors: ${readErrors.length}`
			);
			if (mismatches.length) findings.push(`MISMATCH SAMPLES: ${JSON.stringify(mismatches.slice(0, 5))}`);
			if (sizeMismatches.length) findings.push(`SIZE MISMATCH SAMPLES: ${JSON.stringify(sizeMismatches.slice(0, 5))}`);
			if (readErrors.length) findings.push(`READ ERROR SAMPLES: ${JSON.stringify(readErrors.slice(0, 5))}`);

			const final = await opOk({ action: 'read', key: 'hot' });
			const finalSelfConsistent = final.body.found && final.body.shaMatch === true;
			const finalIsWrittenVersion = finalSelfConsistent && writtenShas.has(final.body.actualSha);
			findings.push(
				`final 'hot' record: writer=${final.body.writer} seq=${final.body.seq} sha=${final.body.actualSha}, ` +
					`self-consistent=${finalSelfConsistent}, matches a written version=${finalIsWrittenVersion}`
			);

			// ── Orphan-file convergence: poll for up to 40s so a slow-but-eventual cleanup is
			// distinguished from a genuine stuck leak. Run this (and the post-delete check) even if
			// earlier assertions would have failed, so one run yields the full diagnostic picture.
			const settleTrajectory = await pollUntil(() => countFiles(mainBlobDir), 2, SETTLE_STEP_MS, SETTLE_MAX_STEPS);
			const filesAfterSettle = settleTrajectory[settleTrajectory.length - 1];
			findings.push(
				`disk files after settle (pre-delete), sampled every ${SETTLE_STEP_MS}ms up to ${(SETTLE_MAX_STEPS * SETTLE_STEP_MS) / 1000}s: ` +
					`${settleTrajectory.join(' -> ')} (expected to converge to 2: control + current hot)`
			);
			if (filesAfterSettle !== 2) {
				const listing = await listFiles(mainBlobDir);
				findings.push(
					`LEFTOVER FILE LISTING (${listing.length}): ` +
						JSON.stringify(
							listing.map((f) => ({ path: f.path.slice(mainBlobDir.length), size: f.size, mtimeMs: f.mtimeMs }))
						)
				);
			}

			const del = await opOk({ action: 'delete', key: 'hot' });
			ok(del.body.ok, 'delete of hot failed');
			const deleteTrajectory = await pollUntil(() => countFiles(mainBlobDir), 1, SETTLE_STEP_MS, 6);
			const filesAfterDelete = deleteTrajectory[deleteTrajectory.length - 1];
			findings.push(
				`disk files after deleting 'hot', sampled every ${SETTLE_STEP_MS}ms: ${deleteTrajectory.join(' -> ')} (expected to converge to 1: control only)`
			);
			if (filesAfterDelete !== 1) {
				const listing = await listFiles(mainBlobDir);
				findings.push(
					`LEFTOVER FILE LISTING AFTER DELETE (${listing.length}): ` +
						JSON.stringify(
							listing.map((f) => ({ path: f.path.slice(mainBlobDir.length), size: f.size, mtimeMs: f.mtimeMs }))
						)
				);
			}

			// ── Decisive check: does the on-demand cleanup_orphan_blobs sweep reclaim what the
			// inline (racy) path left behind, or are these files permanently unreferenced?
			// `hot` is now deleted, so nothing should reference any of the leftover files — the
			// expected post-cleanup floor is 1 (control only). Invoked only once, here, at the final
			// stuck state, so the pre-cleanup trajectories above stay an untouched record of the
			// inline path's behavior.
			let filesAfterCleanup = filesAfterDelete;
			let cleanupTrajectory: number[] = [filesAfterDelete];
			if (filesAfterDelete !== 1) {
				// A dry run must report the orphan condition without acting on it: this is the only way to
				// measure stranded bytes without also reclaiming them (harper#1832 ask #2). Asserted here,
				// where orphans are known to exist, and before the destructive sweep below.
				const dryRunResp = await client.req().send({
					operation: 'cleanup_orphan_blobs',
					database: dbName,
					dryRun: true,
				});
				findings.push(
					`cleanup_orphan_blobs dryRun invoked: status=${dryRunResp.status} body=${JSON.stringify(dryRunResp.body)}`
				);
				ok(dryRunResp.status === 200, `dryRun cleanup_orphan_blobs failed: ${dryRunResp.status}`);
				// The sweep is async (the op returns immediately), so give it room to finish, then confirm
				// it left every file in place.
				await sleep(5_000);
				const filesAfterDryRun = await countFiles(mainBlobDir);
				findings.push(
					`disk files after cleanup_orphan_blobs dryRun: ${filesAfterDryRun} (expected unchanged at ${filesAfterDelete})`
				);
				ok(
					filesAfterDryRun === filesAfterDelete,
					`DRY RUN DEFECT: cleanup_orphan_blobs with dryRun deleted files — expected the count to stay at ${filesAfterDelete}, found ${filesAfterDryRun}`
				);

				const cleanupResp = await client.req().send({ operation: 'cleanup_orphan_blobs', database: dbName });
				findings.push(
					`cleanup_orphan_blobs invoked (database=${dbName}): status=${cleanupResp.status} body=${JSON.stringify(cleanupResp.body)}`
				);
				cleanupTrajectory = await pollUntil(() => countFiles(mainBlobDir), 1, SETTLE_STEP_MS, 15);
				filesAfterCleanup = cleanupTrajectory[cleanupTrajectory.length - 1];
				findings.push(
					`disk files after cleanup_orphan_blobs, sampled every ${SETTLE_STEP_MS}ms up to 30s: ${cleanupTrajectory.join(' -> ')} ` +
						`(expected to converge to 1: control only, since 'hot' was deleted and nothing references the leftover files)`
				);
				if (filesAfterCleanup !== 1) {
					const listing = await listFiles(mainBlobDir);
					findings.push(
						`LEFTOVER FILE LISTING AFTER cleanup_orphan_blobs (${listing.length}): ` +
							JSON.stringify(
								listing.map((f) => ({ path: f.path.slice(mainBlobDir.length), size: f.size, mtimeMs: f.mtimeMs }))
							)
					);
				}
			} else {
				findings.push('cleanup_orphan_blobs skipped: inline path already converged to 1 file, nothing to reclaim');
			}
			findings.push(
				filesAfterCleanup === 1
					? 'VERDICT (Q1): cleanup_orphan_blobs RECLAIMS the leftover files -> deferred-by-design reclamation (SURPRISING-OK): the inline path loses the race under concurrency, but the on-demand sweep still covers it'
					: `VERDICT (Q1): cleanup_orphan_blobs did NOT reclaim ${filesAfterCleanup} leftover file(s) -> permanently unreferenced -> GENUINE LEAK (DEFECT)`
			);

			// ── Now assert, having already collected every diagnostic we need ──
			ok(
				mismatches.length === 0,
				`TORN READ DEFECT: ${mismatches.length} read(s) had actual bytes not matching the declared sha256 from the same snapshot: ${JSON.stringify(mismatches.slice(0, 5))}`
			);
			ok(
				sizeMismatches.length === 0,
				`TORN READ DEFECT: ${sizeMismatches.length} read(s) had wrong byte length: ${JSON.stringify(sizeMismatches.slice(0, 5))}`
			);
			ok(readErrors.length === 0, `unexpected read errors during storm: ${JSON.stringify(readErrors.slice(0, 5))}`);
			ok(finalSelfConsistent, `final record not self-consistent: ${JSON.stringify(final.body)}`);
			ok(
				finalIsWrittenVersion,
				`LWW DEFECT: final blob sha256 does not match ANY of the ${writtenShas.size} versions this test wrote — spliced/foreign content: ${JSON.stringify(final.body)}`
			);
			// Inline reclamation must reach the true floor WITHOUT cleanup_orphan_blobs (#1832): blob
			// unlink intents are durable (queued in the internal dbi, drained at-least-once), so worker
			// recycling mid-storm — this suite restarts http_workers right before the storm — no longer
			// strands superseded files. The manual sweep below stays as a backstop/dryRun check only.
			ok(
				filesAfterSettle === 2,
				`INLINE RECLAMATION DEFECT (#1832): expected the concurrent REPLACE storm to converge to 2 blob files ` +
					`(control + current hot) without cleanup_orphan_blobs, found ${filesAfterSettle} ` +
					`(trajectory: ${settleTrajectory.join(' -> ')})`
			);
			ok(
				filesAfterDelete === 1,
				`INLINE RECLAMATION DEFECT (#1832): expected 1 blob file (control only) after deleting 'hot', ` +
					`without cleanup_orphan_blobs, found ${filesAfterDelete} (trajectory: ${deleteTrajectory.join(' -> ')})`
			);
			ok(
				filesAfterCleanup === 1,
				`ORPHANED-FILE DEFECT (GENUINE LEAK): expected exactly 1 blob file (control only) after deleting 'hot' AND running cleanup_orphan_blobs, ` +
					`found ${filesAfterCleanup} in ${mainBlobDir} — these files are unreferenced by any record yet survived the on-demand reclamation sweep ` +
					`(pre-cleanup trajectory after settle: ${settleTrajectory.join(' -> ')}; after delete: ${deleteTrajectory.join(' -> ')}; after cleanup_orphan_blobs: ${cleanupTrajectory.join(' -> ')})`
			);
		});

		test('sequential control: 80 SEQUENTIAL REPLACEs on one key (no concurrency) settle to a single new file', async () => {
			// Isolates concurrency as the trigger: reproduces P-281/QA-406's green baseline (sequential
			// blob-replace settles cleanly) in THIS harness/fixture, ruling out a fixture or
			// file-storage-threshold difference as the explanation for the concurrent leg's leak.
			const baseline = await countFiles(mainBlobDir);
			const seqKey = 'seq-control';
			let lastSha: string | undefined;
			for (let seq = 0; seq < WRITER_COUNT * ITERS_PER_WRITER; seq++) {
				const r = await opOk({ action: 'write', key: seqKey, writer: -3, seq, size: PAYLOAD_SIZE });
				lastSha = r.body.sha256;
				await sleep(200); // matches P-281/QA-406 pacing — one write settles before the next starts
			}
			const afterSeqTrajectory = await pollUntil(() => countFiles(mainBlobDir), baseline + 1, SETTLE_STEP_MS, 6);
			const afterSeq = afterSeqTrajectory[afterSeqTrajectory.length - 1];
			findings.push(
				`sequential control: ${WRITER_COUNT * ITERS_PER_WRITER} SEQUENTIAL replaces on '${seqKey}' (baseline=${baseline} files before) -> ` +
					`${afterSeqTrajectory.join(' -> ')} files (expected baseline+1=${baseline + 1}, i.e. zero leaked superseded versions)`
			);
			const finalRead = await opOk({ action: 'read', key: seqKey });
			ok(
				finalRead.body.found && finalRead.body.shaMatch === true,
				`sequential control record not self-consistent: ${JSON.stringify(finalRead.body)}`
			);
			ok(
				finalRead.body.actualSha === lastSha,
				`sequential control final sha does not match the last write: ${JSON.stringify(finalRead.body)}`
			);
			if (afterSeq !== baseline + 1) {
				const listing = await listFiles(mainBlobDir);
				findings.push(
					`SEQUENTIAL CONTROL LEFTOVER FILE LISTING (${listing.length}): ` +
						JSON.stringify(
							listing.map((f) => ({ path: f.path.slice(mainBlobDir.length), size: f.size, mtimeMs: f.mtimeMs }))
						)
				);
			}
			findings.push(
				afterSeq === baseline + 1
					? 'VERDICT (Q3): sequential replace settles to exactly ONE new file, zero leaked versions — matches P-281/QA-406 (EXPECTED); concurrency is isolated as the trigger for the main leg leak'
					: `VERDICT (Q3): sequential replace leaked too (${afterSeq - baseline} extra files) — this would NOT isolate concurrency as the trigger; re-examine for a fixture/threshold difference from QA-406`
			);
			ok(
				afterSeq === baseline + 1,
				`SEQUENTIAL CONTROL FAILED: expected exactly baseline+1 (=${baseline + 1}) files after ${WRITER_COUNT * ITERS_PER_WRITER} SEQUENTIAL replaces, found ${afterSeq} — ` +
					`if this fails, the main leg's leak may not be concurrency-specific`
			);
		});
	}
);
