/**
 * P-130 / QA-174 — Blob unlink / record-delete ordering under expiration-scan force-commit.
 *
 * Field incident #1364: a @table with `expiration: N` and a required `Blob` attribute,
 * loaded heavily enough that the BACKGROUND EXPIRATION SCAN exceeds the long-transaction
 * threshold and gets force-committed mid-pass. The claim is that the blob-file unlink and
 * the RocksDB/LMDB record delete can DIVERGE, leaving EITHER:
 *   (a) a LIVE record pointing at a DELETED blob file (orphaned-ref DEFECT), or
 *   (b) a blob FILE on disk with no referencing record (orphaned-file leak).
 *
 * Why this is structurally plausible (read of resources/RecordEncoder.ts:839 removeEntry +
 * resources/blob.ts:493 deleteBlob, both at SHA 7aaa5a152):
 *   removeEntry(): deleteBlobsInObject(value) -> deleteBlob() does
 *                  `setTimeout(() => unlink(filePath), deletionDelay=500ms)` — a
 *                  fire-and-forget unlink DECOUPLED from the transaction — and only THEN
 *                  store.remove(key, options) queues the record delete INTO the per-eviction
 *                  DatabaseTransaction (Table.ts:1589 evict()). The long-txn monitor
 *                  (DatabaseTransaction.ts:489, interval = storage.maxTransactionOpenTime)
 *                  force-commits/aborts open eviction txns. If the unlink fires but the
 *                  record delete does not durably commit, you get an orphaned-ref.
 *
 * LEVERS to push the force-commit path:
 *   - storage.maxTransactionOpenTime: tiny (force-commit monitor fires every few ms)
 *   - storage.debugLongTransactions: true (surfaces "Transaction was open too long" log line)
 *   - threads.count: 4 (cleanup scan runs on the LAST worker; multi-worker contention)
 *   - many large file-backed blobs on a short TTL so the sweep range is large.
 *
 * CROSS-CHECK:
 *   - reconcile (server-side): read every SURVIVING record's blob bytes. A live record whose
 *     blob file was unlinked surfaces here as readError / empty / sha-mismatch == orphaned-ref.
 *   - disk walk (test-side): count blob files under {rootPath}/blobs/data and compare against the
 *     count of surviving records. Files >> records (after settle) == orphaned-file leak.
 *   - control table BlobKeep (no TTL) must remain byte-exact (no wrong-file unlink).
 *
 * EXPLORATORY: hard-fail only on a clear orphaned-ref DEFECT (live record, unreadable blob) or
 * control-table data loss. Orphaned-file accumulation and force-commit confirmation are recorded.
 *
 * NOTE (LMDB): the LMDB leg is skipped because the force-commit threshold isn't crossed on LMDB
 * and the F-005/#1287 cleanup-scan crash can surface. Skipped until #1287 is resolved on LMDB.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   npm run test:integration -- "integrationTests/database/blob-expiration-unlink-order.test.ts"
 * Harper SHA: 7aaa5a152 (main)
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import {
	setupHarperWithFixture,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-expiration-unlink-order');

// Tuning. 64KB > the 8KB file-storage threshold, so every blob is file-backed.
const BLOB_SIZE = 64 * 1024;
const EXPIRE_COUNT = 1500; // records on the TTL table — large sweep range to cross the long-txn threshold
const KEEP_COUNT = 20; // no-TTL control records
const TTL_SECS = 6; // matches schema expiration: 6

// Run both engines. The harness honors HARPER_STORAGE_ENGINE; default is RocksDB.
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

// LMDB: the force-commit threshold isn't crossed on LMDB and the F-005/#1287 cleanup-scan crash
// can surface; skipped until #1287 is resolved on LMDB.
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun' || ENGINE === 'lmdb';

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

/** Best-effort: find hdb.log under rootPath and count force-commit lines. */
async function countForceCommits(rootPath: string): Promise<{ found: boolean; count: number; path?: string }> {
	// The integration harness writes per-suite logs into a SUBDIR of
	// HARPER_INTEGRATION_TEST_LOG_DIR (named after the suite); hdb.log there holds the
	// "Transaction was open too long" lines. Without that env, Harper logs go to the
	// runner's captured stdout (visible inline) and there is no on-disk file to grep.
	const roots: string[] = [];
	const logDirEnv = process.env.HARPER_INTEGRATION_TEST_LOG_DIR;
	if (logDirEnv) roots.push(logDirEnv);
	roots.push(join(rootPath, 'log'), rootPath);

	async function findLog(d: string, depth: number): Promise<string | undefined> {
		if (depth > 4) return;
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isFile() && e.name === 'hdb.log') return p;
		}
		for (const e of entries) {
			if (e.isDirectory() && e.name !== 'blobs' && e.name !== 'node_modules') {
				const found = await findLog(join(d, e.name), depth + 1);
				if (found) return found;
			}
		}
	}

	for (const root of roots) {
		const p = await findLog(root, 0);
		if (p) {
			try {
				const txt = await readFile(p, 'utf8');
				const expire = (txt.match(/Transaction was open too long.*from table: BlobExpire/g) || []).length;
				const total = (txt.match(/Transaction was open too long/g) || []).length;
				return { found: true, count: expire || total, path: p };
			} catch {
				/* try next root */
			}
		}
	}
	return { found: false, count: 0 };
}

suite(`QA-174 blob unlink/record-delete ordering [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
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

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 4 },
				storage: {
					debugLongTransactions: true,
					// Tiny long-txn window: the monitor force-commits any eviction/read txn that
					// stays open longer than this. 1ms makes the force-commit path as easy to hit
					// as possible — even a fast eviction txn can be caught mid-commit.
					maxTransactionOpenTime: 1,
				},
				logging: { root: 'log', level: 'debug' },
			},
			env: ENGINE === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {},
		});
		client = createApiClient(ctx.harper);

		const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
		rootPath = cfg.body.rootPath;
		ok(rootPath, 'get_configuration must return rootPath');
		blobRootDir = join(rootPath, 'blobs', 'data');
		findings.push(`engine=${ENGINE} rootPath=${rootPath}`);

		// Workers register REST routes async after "started" — poll before asserting.
		// Probe the exported TABLE route (custom Resource routes can answer 404 to GET).
		await restartHttpWorkers(client, '/BlobExpire/', 120_000);
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log(`\n[QA-174][${ENGINE}] FINDINGS`);
		for (const f of findings) console.log('  ' + f);
	});

	test('expiration-scan force-commit does not orphan blob refs or files', async () => {
		// 1) Plant no-TTL control blobs (must survive the sweep byte-exact).
		for (let i = 0; i < KEEP_COUNT; i++) {
			const r = await op({ action: 'store', table: 'keep', key: `keep-${i}`, size: BLOB_SIZE, seed: `keep-${i}` }).expect(200);
			ok(r.body.ok, `control store keep-${i} failed`);
		}

		// 2) Load EXPIRE_COUNT large file-backed blobs on the TTL table. Write in parallel
		//    batches so the whole load finishes well inside the TTL window — otherwise the
		//    earliest records start expiring/evicting before the load completes.
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

		// Baseline: control blobs must be byte-exact BEFORE the sweep (rules out a flaky
		// writer and makes the post-sweep keep check meaningful).
		const keepBaseline = await op({ action: 'reconcile', table: 'keep' }).expect(200);
		ok(
			keepBaseline.body.total === KEEP_COUNT &&
				keepBaseline.body.intact === KEEP_COUNT &&
				keepBaseline.body.orphanedRef === 0,
			`control blobs not byte-exact at baseline: total=${keepBaseline.body.total}, intact=${keepBaseline.body.intact}, ` +
				`orphanedRef=${keepBaseline.body.orphanedRef}`
		);

		const afterWrite = await diskFiles(blobRootDir);
		const countAfterWrite = await op({ action: 'count', table: 'expire' }).expect(200);
		findings.push(
			`after write: ${countAfterWrite.body.count} expire records, ${afterWrite.files} files / ` +
				`${(afterWrite.bytes / 1024 / 1024).toFixed(1)}MB (loaded ${EXPIRE_COUNT}; some early ones may already be evicting)`
		);
		// Sanity: the bulk of records and their file-backed blobs landed. We allow slack for
		// records that already began expiring during the (sub-TTL) load window.
		ok(
			countAfterWrite.body.count >= EXPIRE_COUNT * 0.8,
			`expected ~${EXPIRE_COUNT} expire records right after load, got ${countAfterWrite.body.count}`
		);
		ok(
			afterWrite.files >= EXPIRE_COUNT * 0.8,
			`blobs not file-backed as expected: only ${afterWrite.files} files for ${EXPIRE_COUNT} blobs`
		);

		// 3) Wait for TTL to just elapse, then sample MID-SWEEP. The sweep runs on the
		//    last worker; with debugLongTransactions + a 1ms maxTransactionOpenTime, the
		//    per-eviction txns are candidates for force-commit. We reconcile at each step
		//    so a TRANSIENT orphaned-ref (blob file unlinked, record delete not yet
		//    committed) is caught while records are partially evicted — not just at the
		//    quiescent end state where it may have self-healed.
		await sleep((TTL_SECS - 1) * 1_000);

		let expireCount = EXPIRE_COUNT;
		const traj: string[] = [];
		let midSweepBadRefs: any[] = [];
		for (let t = 0; t < 16; t++) {
			await sleep(2_000);
			const recon = await op({ action: 'reconcile', table: 'expire' }).expect(200);
			expireCount = recon.body.total;
			const d = await diskFiles(blobRootDir);
			traj.push(`+${(t + 1) * 2}s: ${expireCount}recs/${recon.body.orphanedRef}orph/${d.files}files`);
			const bad = (recon.body.records || []).filter(
				(r: any) => r.readError || r.bytesLen === 0 || r.shaMatch === false
			);
			if (bad.length > midSweepBadRefs.length) midSweepBadRefs = bad;
			if (expireCount === 0) {
				// give the decoupled 500ms unlink timers a moment to drain, then one more sample
				await sleep(3_000);
				const d2 = await diskFiles(blobRootDir);
				traj.push(`settle: 0recs/${d2.files}files`);
				break;
			}
		}
		findings.push(`sweep trajectory: ${traj.join(' | ')}`);
		if (midSweepBadRefs.length) {
			findings.push(`MID-SWEEP ORPHANED-REF SAMPLES: ${JSON.stringify(midSweepBadRefs.slice(0, 5))}`);
		}

		// 4) Confirm the force-commit actually fired.
		const fc = await countForceCommits(rootPath);
		if (fc.found) {
			findings.push(`force-commit log: ${fc.count}× "Transaction was open too long" in ${fc.path}`);
			if (fc.count === 0) {
				findings.push('NOTE: log present but zero force-commit lines — sweep may not have crossed the threshold');
			}
		} else {
			findings.push('force-commit log: hdb.log not located — could not confirm force-commit firing');
		}

		// 5) CROSS-CHECK orphaned-ref: read every SURVIVING expire-record's blob server-side.
		const recon = await op({ action: 'reconcile', table: 'expire' }).expect(200);
		findings.push(
			`reconcile(expire): total=${recon.body.total} intact=${recon.body.intact} orphanedRef=${recon.body.orphanedRef}`
		);
		const finalBadRefs = (recon.body.records || []).filter(
			(r: any) => r.readError || r.bytesLen === 0 || r.shaMatch === false
		);
		// The defect can be TRANSIENT (visible only mid-sweep) or STABLE (visible at the
		// end). Union both: any live record with an unreadable blob at ANY sample is a hit.
		const badRefs = finalBadRefs.length ? finalBadRefs : midSweepBadRefs;
		if (finalBadRefs.length) {
			findings.push(`FINAL ORPHANED-REF SAMPLES: ${JSON.stringify(finalBadRefs.slice(0, 5))}`);
		}

		// 6) CROSS-CHECK orphaned-file: surviving records vs files on disk (after settle).
		const finalDisk = await diskFiles(blobRootDir);
		const keepRecon = await op({ action: 'reconcile', table: 'keep' }).expect(200);
		const survivingRecords = recon.body.total + keepRecon.body.total;
		const excessFiles = finalDisk.files - survivingRecords;
		findings.push(
			`disk vs records: ${finalDisk.files} files vs ${survivingRecords} surviving records ` +
				`(expire=${recon.body.total}, keep=${keepRecon.body.total}) -> excess=${excessFiles}`
		);

		// 7) Control table integrity — no wrong-file unlink, no data loss.
		findings.push(
			`reconcile(keep): total=${keepRecon.body.total} intact=${keepRecon.body.intact} orphanedRef=${keepRecon.body.orphanedRef}`
		);

		// ── VERDICT ──────────────────────────────────────────────────────────────
		if (badRefs.length > 0) {
			findings.push(
				`VERDICT: ORPHANED-REF DEFECT — ${badRefs.length} live record(s) point at a missing/empty blob file ` +
					`(${finalBadRefs.length ? 'STABLE' : 'TRANSIENT mid-sweep'}, ${ENGINE})`
			);
		} else if (expireCount > 0) {
			findings.push(
				`VERDICT: INCONCLUSIVE/STUCK — ${expireCount} expire records did not get swept; no orphaned-ref observed among them`
			);
		} else if (excessFiles > Math.max(5, survivingRecords * 0.5)) {
			findings.push(
				`VERDICT: ORPHANED-FILE LEAK — ${excessFiles} blob files remain with no referencing record after sweep (${ENGINE})`
			);
		} else {
			findings.push(`VERDICT: CLEAN — unlink/record-delete stayed consistent under force-commit (EXPECTED, ${ENGINE})`);
		}

		// ── HARD GATES ───────────────────────────────────────────────────────────
		// (a) The orphaned-ref DEFECT — this is the QA-174 incident. Live record, dead blob.
		ok(
			badRefs.length === 0,
			`ORPHANED-REF DEFECT: ${badRefs.length} surviving expire record(s) have unreadable/empty/mismatched blobs ` +
				`under expiration-scan force-commit (${ENGINE}): ${JSON.stringify(badRefs.slice(0, 5))}`
		);
		// (b) Control table must be fully intact (no cross-table wrong-file unlink, no loss).
		ok(
			keepRecon.body.total === KEEP_COUNT && keepRecon.body.orphanedRef === 0 && keepRecon.body.intact === KEEP_COUNT,
			`CONTROL TABLE DAMAGE: keep total=${keepRecon.body.total}/${KEEP_COUNT}, intact=${keepRecon.body.intact}, ` +
				`orphanedRef=${keepRecon.body.orphanedRef} — sweep unlinked a no-TTL blob or lost a control record (${ENGINE})`
		);
	});
});
