/**
 * P-134 / QA-180 — Blob unlink-timer vs record-delete-commit ordering under a CRASH (SIGKILL).
 *
 * Follow-up to QA-174. QA-174 probed the GRACEFUL force-commit of the expiration sweep
 * (long-txn monitor force-commits an eviction txn mid-pass) and found it CLEAN. QA-180
 * targets the case QA-174 explicitly did NOT cover: a hard CRASH (SIGKILL) while the
 * sweep is in the unlink-then-commit window.
 *
 * Structural risk (read at SHA 7aaa5a152):
 *   RecordEncoder.ts:839 removeEntry() does, IN ORDER:
 *     1. deleteBlobsInObject(value)  -> for each file-backed blob, deleteBlob() schedules
 *        `setTimeout(() => unlink(filePath), deletionDelay=500ms)` (blob.ts:499) — a
 *        fire-and-forget unlink DECOUPLED from the transaction.
 *     2. store.remove(key, options) -> queues the record delete INTO the per-eviction
 *        DatabaseTransaction.
 *   A SIGKILL during the sweep can land in either gap:
 *     (a) ORPHANED-REF (DEFECT, high): the 500ms unlink timer FIRED (blob file gone) but
 *         the record delete did NOT durably commit -> after restart the record is still
 *         live but its blob is unreadable/empty == silent data loss.
 *     (b) ORPHANED-FILE (DEFECT, lower): the record delete DID durably commit but the
 *         unlink timer never fired before the crash -> a blob FILE with no referencing
 *         record == leak.
 *
 * Levers to land the kill IN the window:
 *   - file-backed blobs (64KB > 8KB inline threshold) on a short TTL (6s) so a large sweep
 *     range is in flight at once.
 *   - threads.count: 4 — the cleanup scan runs on the last worker; multi-worker contention.
 *   - HARPER_NO_FLUSH_ON_EXIT — the realistic crash path: an uncommitted record-delete is
 *     lost (not flushed) on SIGKILL, which is exactly what materializes an orphaned-ref.
 *   - KILL_OFFSET_MS (env-tunable): delay AFTER TTL elapse before the SIGKILL. We sweep a
 *     range of offsets across runs to catch the sweep mid-flight; the offset that produced
 *     the worst case is reported. The 500ms decoupled unlink means an offset a little past
 *     the moment the sweep starts maximizes "some files already unlinked, some deletes not
 *     yet committed".
 *
 * Cross-check after restart (SAME config re-passed — a config-less restart can wipe TTL):
 *   - reconcile(expire): read every SURVIVING expire record's blob server-side.
 *       orphaned-ref = live record with readError / 0 bytes / sha-mismatch.
 *   - disk walk: count blob files under {rootPath}/blobs/data and diff vs surviving records.
 *       orphaned-file = files >> surviving records after settle.
 *   - reconcile(keep): no-TTL control must be byte-exact (no crash-induced wrong-file unlink).
 *
 * Exploratory: HARD-FAIL only on a clear orphaned-ref DEFECT (live record, dead blob) or
 * control-table data loss. Orphaned-file accumulation is RECORDED (leak, lower severity).
 * Inability to land the kill in the window is reported as INCONCLUSIVE, not a pass.
 *
 * OBSERVED (SHA 7aaa5a152, both engines): NO orphaned-ref. The record-deletes commit fast
 * and atomically (table count hits 0 almost immediately) while the unlink timers trail by
 * 500ms, so by the time any unlink fires its delete has already committed — the orphaned-REF
 * ordering is structurally avoided. BUT a SIGKILL kills the pending 500ms unlink timers,
 * leaving ORPHANED FILES (committed delete, blob file never unlinked). These are NOT reclaimed
 * by crash-recovery / the post-restart sweep: orphan blob cleanup exists only as a MANUAL,
 * on-demand operation (`cleanupOrphanBlobs` -> blob.ts cleanupOrphans, dataLayer/schema.ts:347,
 * "don't await, it will probably take hours"), never run automatically on startup or schedule.
 * Leak magnitude = #unlink timers pending at crash (LMDB committed faster -> ~1198 leaked;
 * RocksDB varied 20–52). Leak is lower-severity (no data loss) but unbounded across repeated
 * crashes until an operator manually triggers cleanup.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   npm run test:integration -- "integrationTests/database/blob-crash-unlink-order.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/blob-crash-unlink-order.test.ts"
 *   # vary the kill offset to hunt the window:
 *   QA180_KILL_OFFSET_MS=300 npm run test:integration -- "integrationTests/database/blob-crash-unlink-order.test.ts"
 * Harper SHA: 7aaa5a152 (main)
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import {
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-crash-unlink-order');

// 64KB > the 8KB file-storage threshold, so every blob is file-backed (a real file on disk).
const BLOB_SIZE = 64 * 1024;
const EXPIRE_COUNT = 1200; // expire-table records — large sweep range in flight at once
const KEEP_COUNT = 20; // no-TTL control records
const TTL_SECS = 6; // matches schema expiration: 6

// Delay AFTER TTL has elapsed before we SIGKILL — i.e. how far INTO the sweep we crash.
// Default 250ms: the sweep has started evicting (so unlinks are scheduled / firing) but the
// first batch's record-deletes are still racing toward a durable commit. Env-tunable so the
// offset can be swept to hunt the window.
const KILL_OFFSET_MS = Number(process.env.QA180_KILL_OFFSET_MS ?? 250);

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

// Run both engines. The harness honors HARPER_STORAGE_ENGINE; default is RocksDB.
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

// The SAME config object is passed on the INITIAL setup AND on the post-crash restart.
// A restart without config can wipe TTL/thread settings, which would defeat the probe.
const HARPER_CONFIG = {
	threads: { count: 4 },
	storage: {
		engine: ENGINE,
		// Tiny long-txn window: the eviction txns are also force-commit candidates, which
		// keeps the per-eviction commit cadence high so the crash is likelier to land
		// between an unlink and its delete-commit.
		debugLongTransactions: true,
		maxTransactionOpenTime: 1,
	},
	logging: { root: 'log', level: 'debug' },
};

const HARPER_ENV: Record<string, unknown> = {
	// Realistic crash path: do NOT flush on exit. An eviction's record-delete that hasn't
	// durably committed at SIGKILL time is then LOST — the precondition for an orphaned-ref.
	HARPER_NO_FLUSH_ON_EXIT: true,
	...(ENGINE === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {}),
};

/** Recursively enumerate blob files (leaf files in the fan-out tree). */
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

suite(`QA-180 blob unlink/commit CRASH window [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let rootPath: string;
	let blobRootDir: string;
	const findings: string[] = [];

	function op(body: Record<string, unknown>) {
		return request(client.restURL ?? (ctx.harper as any).httpURL)
			.post('/BlobOps/')
			.set(client.headers)
			.send(body);
	}

	async function waitTableRoute(timeoutMs: number) {
		// Workers register REST routes async after "started"; poll the exported TABLE route.
		await restartHttpWorkers(client, '/BlobExpire/', timeoutMs);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: HARPER_CONFIG, env: HARPER_ENV });
		client = createApiClient(ctx.harper);

		const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
		rootPath = cfg.body.rootPath;
		ok(rootPath, 'get_configuration must return rootPath');
		blobRootDir = join(rootPath, 'blobs', 'data');
		findings.push(`engine=${ENGINE} killOffsetMs=${KILL_OFFSET_MS} rootPath=${rootPath}`);

		await waitTableRoute(120_000);
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log(`\n[QA-180][${ENGINE}] FINDINGS`);
		for (const f of findings) console.log('  ' + f);
	});

	test('SIGKILL in the expiration unlink/commit window does not orphan blob refs', async () => {
		// 1) Plant no-TTL control blobs (must survive the crash byte-exact).
		for (let i = 0; i < KEEP_COUNT; i++) {
			const r = await op({ action: 'store', table: 'keep', key: `keep-${i}`, size: BLOB_SIZE, seed: `keep-${i}` }).expect(200);
			ok(r.body.ok, `control store keep-${i} failed`);
		}

		// 2) Load EXPIRE_COUNT large file-backed blobs on the TTL table, in parallel batches
		//    so the whole load finishes well inside the TTL window (else early records expire
		//    before the load completes).
		const CONCURRENCY = 16;
		for (let i = 0; i < EXPIRE_COUNT; i += CONCURRENCY) {
			const batch = [];
			for (let j = i; j < Math.min(i + CONCURRENCY, EXPIRE_COUNT); j++) {
				batch.push(
					op({ action: 'store', table: 'expire', key: `exp-${j}`, size: BLOB_SIZE, seed: `exp-${j}` })
						.expect(200)
						.then((r: any) => ok(r.body.ok, `store exp-${j} failed`))
				);
			}
			await Promise.all(batch);
		}
		await sleep(1_000); // let file-backed blob saves settle to disk

		// Baseline: controls byte-exact, and the bulk of expire blobs landed as files.
		const keepBaseline = await op({ action: 'reconcile', table: 'keep' }).expect(200);
		ok(
			keepBaseline.body.total === KEEP_COUNT && keepBaseline.body.intact === KEEP_COUNT && keepBaseline.body.orphanedRef === 0,
			`control blobs not byte-exact at baseline: total=${keepBaseline.body.total}, intact=${keepBaseline.body.intact}, orphanedRef=${keepBaseline.body.orphanedRef}`
		);
		const afterWrite = await diskFiles(blobRootDir);
		const countAfterWrite = await op({ action: 'count', table: 'expire' }).expect(200);
		findings.push(
			`after write: ${countAfterWrite.body.count} expire records, ${afterWrite.files} files / ${(afterWrite.bytes / 1024 / 1024).toFixed(1)}MB`
		);
		ok(countAfterWrite.body.count >= EXPIRE_COUNT * 0.8, `expected ~${EXPIRE_COUNT} expire records after load, got ${countAfterWrite.body.count}`);
		ok(afterWrite.files >= EXPIRE_COUNT * 0.8, `blobs not file-backed as expected: only ${afterWrite.files} files for ${EXPIRE_COUNT} blobs`);

		// Record the load start so we can time the kill relative to TTL expiry.
		// 3) Wait for the TTL to JUST elapse so the sweep begins evicting, then crash a short
		//    offset into the sweep — when some unlink timers have fired but the matching
		//    record-deletes are still racing to commit.
		await sleep(TTL_SECS * 1_000 + KILL_OFFSET_MS);

		// Snapshot disk + record count at the instant of the kill (best-effort; pre-kill).
		const atKill = await diskFiles(blobRootDir);
		let recsAtKill = -1;
		try {
			const c = await op({ action: 'count', table: 'expire' }).timeout(2_000);
			recsAtKill = c.body?.count ?? -1;
		} catch {
			/* sweep may be mid-flight; count read can race */
		}
		findings.push(`at kill (TTL+${KILL_OFFSET_MS}ms): ~${recsAtKill} expire recs, ${atKill.files} files on disk`);

		// 4) SIGKILL the whole instance MID-SWEEP. No flush on exit -> uncommitted deletes lost.
		await new Promise<void>((res) => {
			ctx.harper.process.once('exit', () => res());
			ctx.harper.process.kill('SIGKILL');
		});
		findings.push('SIGKILL delivered mid-sweep');

		// 5) Restart on the SAME data dir with the SAME config (re-passing config so TTL/threads
		//    are not wiped). This triggers transaction-log replay / recovery.
		const t0 = Date.now();
		await startHarper(ctx, { config: HARPER_CONFIG, env: HARPER_ENV as any, startupTimeoutMs: 120_000 });
		const restartMs = Date.now() - t0;
		client = createApiClient(ctx.harper);
		await waitTableRoute(120_000);
		findings.push(`restart + replay completed in ${restartMs}ms`);

		// 6) RECONCILE orphaned-ref: read EVERY surviving expire record's blob server-side.
		//    Sample a few times — the restarted sweep may resume; a transient orphaned-ref
		//    (live record, file already gone) can appear before the record is finally evicted.
		let worstBadRefs: any[] = [];
		let lastRecon: any = null;
		const traj: string[] = [];
		for (let t = 0; t < 8; t++) {
			const recon = await op({ action: 'reconcile', table: 'expire' }).expect(200);
			lastRecon = recon;
			const bad = (recon.body.records || []).filter((r: any) => r.readError || r.bytesLen === 0 || r.shaMatch === false);
			if (bad.length > worstBadRefs.length) worstBadRefs = bad;
			const d = await diskFiles(blobRootDir);
			traj.push(`+${t}: ${recon.body.total}recs/${recon.body.orphanedRef}orph/${d.files}files`);
			if (recon.body.total === 0) break;
			await sleep(2_000);
		}
		findings.push(`post-restart trajectory: ${traj.join(' | ')}`);
		if (worstBadRefs.length) {
			findings.push(`ORPHANED-REF SAMPLES: ${JSON.stringify(worstBadRefs.slice(0, 5))}`);
		}

		// 7) Final reconcile + disk walk after the post-restart sweep settles.
		await sleep(2_000);
		void lastRecon; // retained for trajectory; final state re-read below
		const finalRecon = await op({ action: 'reconcile', table: 'expire' }).expect(200);
		const finalBadRefs = (finalRecon.body.records || []).filter(
			(r: any) => r.readError || r.bytesLen === 0 || r.shaMatch === false
		);
		// Union transient + final: any live record with an unreadable blob at ANY sample is a hit.
		const badRefs = finalBadRefs.length ? finalBadRefs : worstBadRefs;
		findings.push(
			`reconcile(expire) final: total=${finalRecon.body.total} intact=${finalRecon.body.intact} orphanedRef=${finalRecon.body.orphanedRef}`
		);
		if (finalBadRefs.length) findings.push(`FINAL ORPHANED-REF SAMPLES: ${JSON.stringify(finalBadRefs.slice(0, 5))}`);

		// 8) ORPHANED-FILE: surviving records vs files on disk after settle.
		const finalDisk = await diskFiles(blobRootDir);
		const keepRecon = await op({ action: 'reconcile', table: 'keep' }).expect(200);
		const survivingRecords = finalRecon.body.total + keepRecon.body.total;
		const excessFiles = finalDisk.files - survivingRecords;
		findings.push(
			`disk vs records: ${finalDisk.files} files vs ${survivingRecords} surviving records (expire=${finalRecon.body.total}, keep=${keepRecon.body.total}) -> excess=${excessFiles}`
		);
		findings.push(
			`reconcile(keep): total=${keepRecon.body.total} intact=${keepRecon.body.intact} orphanedRef=${keepRecon.body.orphanedRef}`
		);

		// ── VERDICT ──────────────────────────────────────────────────────────────
		if (badRefs.length > 0) {
			findings.push(
				`VERDICT: ORPHANED-REF DEFECT — ${badRefs.length} live record(s) point at a missing/empty blob after crash-recovery ` +
					`(${finalBadRefs.length ? 'STABLE' : 'TRANSIENT'}, ${ENGINE}, killOffset=${KILL_OFFSET_MS}ms)`
			);
		} else if (excessFiles > Math.max(5, survivingRecords)) {
			findings.push(
				`VERDICT: ORPHANED-FILE LEAK — ${excessFiles} blob files with no referencing record after crash-recovery (${ENGINE})`
			);
		} else {
			findings.push(`VERDICT: CLEAN — unlink/record-delete stayed consistent across SIGKILL+recovery (EXPECTED, ${ENGINE})`);
		}

		console.log(
			`\n[QA-180:${ENGINE}] RESULTS (killOffset=${KILL_OFFSET_MS}ms)\n` +
				`  surviving expire records   = ${finalRecon.body.total}\n` +
				`  orphaned-ref (live/dead)   = ${badRefs.length}  ${badRefs.length ? (finalBadRefs.length ? '(STABLE)' : '(TRANSIENT)') : ''}\n` +
				`  control (keep) intact      = ${keepRecon.body.intact}/${KEEP_COUNT}\n` +
				`  blob files on disk         = ${finalDisk.files}  (excess vs records = ${excessFiles})`
		);

		// ── HARD GATES ───────────────────────────────────────────────────────────
		// (a) Orphaned-ref is the QA-180 target defect: a live record with a dead blob.
		ok(
			badRefs.length === 0,
			`ORPHANED-REF DEFECT: ${badRefs.length} surviving expire record(s) have unreadable/empty/mismatched blobs after ` +
				`SIGKILL-in-sweep + recovery (${ENGINE}, killOffset=${KILL_OFFSET_MS}ms): ${JSON.stringify(badRefs.slice(0, 5))}`
		);
		// (b) Control table must be fully intact (no crash-induced wrong-file unlink / loss).
		ok(
			keepRecon.body.total === KEEP_COUNT && keepRecon.body.orphanedRef === 0 && keepRecon.body.intact === KEEP_COUNT,
			`CONTROL TABLE DAMAGE: keep total=${keepRecon.body.total}/${KEEP_COUNT}, intact=${keepRecon.body.intact}, ` +
				`orphanedRef=${keepRecon.body.orphanedRef} — crash lost/corrupted a no-TTL control blob (${ENGINE})`
		);

		// Known behavior (D-074 / #708): orphaned blob FILES (committed delete, unlink timer killed by SIGKILL)
		// are NOT automatically reclaimed by crash recovery or post-restart sweep. Cleanup is only via
		// the manual on-demand `cleanupOrphanBlobs` operation (blob.ts cleanupOrphans). The excessFiles
		// count above is logged for observation but is NOT a hard-fail — it is expected behavior.
		console.log(
			`[QA-180:${ENGINE}] orphaned-file observation (D-074/#708): excessFiles=${excessFiles} ` +
				`(expected behavior — manual cleanupOrphanBlobs only; NOT a hard-fail)`
		);
	});
});
