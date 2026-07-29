/**
 * QA-802 — Blob GC vs audit-log expiry (harper#708, "Blob GC: files not deleted on
 * audit-log expiry when using RocksDB audit store").
 *
 * #708's claim: `scheduleAuditCleanup()` (resources/auditStore.ts) branches on the audit
 * store type; for RocksDB it calls `rootStore.purgeLogs()` and returns WITHOUT ever calling
 * `removeAuditEntry()` — the function that invokes the blob-file delete callbacks — so blob
 * files supposedly accumulate forever once a blob-bearing record is deleted.
 *
 * SOURCE READ at SHA d112560b6 says the picture is more nuanced:
 *  - RecordEncoder.ts recordUpdater() (used by BOTH SQL and REST/JS deletes, since Table.ts's
 *    `_writeDelete` funnels through it) calls `deleteBlobsInObject(existingEntry.value, ...)`
 *    SYNCHRONOUSLY on any delete whose prior entry carried HAS_BLOBS — independent of audit
 *    engine and independent of auditRetention. This landed 2026-07-14 (commit 6e8d3647a,
 *    fixing #641, an unrelated update-path data-loss bug) — AFTER #708 was filed
 *    (2026-05-21) but it isn't excluded for type==='delete', so it may have incidentally
 *    fixed #708's headline scenario too.
 *  - Table.ts's OWN periodic `scheduleCleanup()` (armed here via `scanInterval` without
 *    `expiration`, so live records never auto-evict) always treats RocksDB deleted-tombstone
 *    removal as active (`removeDeletedRecords = !audit || isRocksDB`, Table.ts:5824) —
 *    independent of the auditStore.ts RocksDB branch under test. That scan's `removeEntry()`
 *    call operates on a null-value tombstone though, so it can't be the blob-deletion path
 *    (blob deletion needs the entry's prior VALUE, already gone by tombstone time).
 *  - QA-047 (audit-retention.test.ts) already established that RocksDB's `purgeLogs` purges
 *    whole LOG FILES, not per-entry, and won't touch a still-active (not-yet-rolled) file
 *    within a short test window — a confound distinct from the delete-callback question.
 *
 * This experiment tests empirically, on disk, rather than trusting either the issue's
 * static-analysis premise or the RecordEncoder.ts read above:
 *   Arm A: delete a live blob-bearing record via SQL DELETE (the issue's exact repro),
 *          trajectory-sample the on-disk blob dir through the deletionDelay, the
 *          auditRetention window, and a hard restart.
 *   Arm B: audit-only expiry with the record still LIVE (repeated overwrite so old audit
 *          PUT entries age out) — the current blob must never be touched; PUT-type audit
 *          entries never invoke the delete-callback (auditStore.ts removeAuditEntry only
 *          special-cases type==='delete'), so this is the negative control.
 * ENGINE SCOPE — read before trusting this as an A/B. In CI this file pins the DEFAULT
 * engine only (RocksDB); the engine is selected process-wide by HARPER_STORAGE_ENGINE, so a
 * single test file cannot run both. The LMDB leg was run manually during QA and also showed
 * zero net leak, which is what refutes harper#708's "RocksDB-specific" framing — but that
 * result is QA evidence, not something this file asserts. To re-run the LMDB leg, set
 * HARPER_STORAGE_ENGINE=lmdb (see Reproduction below).
 *
 * Layout probed directly on disk: {dataRootDir}/blobs/{db}/{p}/{p}/{fileId} (db="data",
 * the default database for a table with no explicit `database:` in its @table directive).
 *
 * Reproduction:
 *   cd <harper checkout>
 *   npm run test:integration -- "integrationTests/database/blob-delete-reclaim-audit-expiry.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/blob-delete-reclaim-audit-expiry.test.ts"
 * Harper SHA at promotion: 80ef45996 (main)
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-delete-reclaim-audit-expiry');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const skipSuite = process.platform === 'win32';

const BLOB_SIZE = 256 * 1024; // file-backed (well above the inline threshold), small for a fast N-rep loop
const AUDIT_RETENTION_SECONDS = 3; // short so the automatic cleanup loop / purgeLogs window fits a test
const N = 20; // reps for the delete arm — quantifies leak rate per N deletes

const HARPER_CONFIG = {
	logging: { auditLog: true, auditRetention: AUDIT_RETENTION_SECONDS },
};
const HARPER_ENV = ENGINE === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {};

/** Recursively count files + sum bytes under a blob storage tree. Disk truth, not API truth. */
async function diskUsage(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return; // dir not created yet
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

const fmtKB = (b: number) => (b / 1024).toFixed(0) + 'KB';

suite(`QA-802 blob GC vs audit-log expiry (harper#708) [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	const findings: string[] = [];

	const blobRoot = () => join(ctx.harper.dataRootDir, 'blobs', 'data');

	async function waitReady() {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Doc/').timeout(3_000);
				if (probe.status !== 404) return;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: HARPER_CONFIG, env: HARPER_ENV });
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		await waitReady();
	});

	after(async () => {
		await teardownHarper(ctx);
		// eslint-disable-next-line no-console
		console.log(`\n[QA-802 ${ENGINE}] FINDINGS`);
		for (const f of findings) console.log('  ' + f);
	});

	function op(body: Record<string, unknown>) {
		return request(httpURL).post('/DocOps/').set(client.headers).send(body);
	}
	function sql(sqlStr: string) {
		return client.req().send({ operation: 'sql', sql: sqlStr });
	}

	// ── Arm A: record deletion via SQL — trajectory through deletionDelay, audit expiry, restart ──
	test(
		`Arm A [${ENGINE}]: SQL-deleted blob-bearing records — disk trajectory to restart`,
		{ timeout: 120_000 },
		async () => {
			const keys = Array.from({ length: N }, (_, i) => `del-${i}`);
			const base = await diskUsage(blobRoot());

			for (const key of keys) {
				const r = await op({ action: 'store', key, size: BLOB_SIZE, seed: key }).expect(200);
				ok(r.body.ok, `store ${key} failed: ${JSON.stringify(r.body)}`);
			}
			const afterStore = await diskUsage(blobRoot());
			strictEqual(
				afterStore.files - base.files,
				N,
				`expected ${N} new blob files after store, got delta ${afterStore.files - base.files}`
			);

			// Delete via SQL — the exact reproduction path #708 describes.
			for (const key of keys) {
				const r = await sql(`DELETE FROM data.Doc WHERE key = '${key}'`);
				strictEqual(r.status, 200, `SQL DELETE ${key} failed: ${r.text}`);
			}

			// Trajectory: sample disk usage across the deletionDelay (500ms) and the auditRetention
			// window (+ scanInterval cycles) so we can tell "never", "immediate", and "delayed until
			// audit expiry" apart, rather than guessing from a single end-state snapshot.
			const traj: Array<{ t: number; files: number; bytes: number }> = [];
			const start = Date.now();
			const sampleUntilMs = (AUDIT_RETENTION_SECONDS + 1) * 1000 + 15_000; // retention + scan-cycle margin
			while (Date.now() - start < sampleUntilMs) {
				await sleep(2_000);
				const u = await diskUsage(blobRoot());
				traj.push({ t: Date.now() - start, ...u });
			}
			// Hard restart against the SAME data dir — does a restart reconcile anything the
			// live-process path did not?
			const dataRootDir = ctx.harper.dataRootDir;
			const hostname = ctx.harper.hostname;
			await killHarper(ctx as any, { graceMs: 200 });
			ctx.harper = { dataRootDir, hostname } as any;
			await startHarper(ctx as any, { config: HARPER_CONFIG, env: HARPER_ENV });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			await waitReady();
			const afterRestart = await diskUsage(blobRoot());

			// Explicit documented workaround: cleanup_orphan_blobs.
			const cleanup = await client.req().send({ operation: 'cleanup_orphan_blobs', database: 'data' });
			await sleep(5_000);
			const afterCleanupOp = await diskUsage(blobRoot());

			const trajStr = traj.map((s) => `+${(s.t / 1000).toFixed(0)}s=${s.files}f/${fmtKB(s.bytes)}`).join(', ');
			findings.push(
				`Arm A [${ENGINE}] N=${N}x${fmtKB(BLOB_SIZE)} SQL-deleted: base=${base.files}f, afterStore=${afterStore.files}f, ` +
					`trajectory: ${trajStr}, afterRestart=${afterRestart.files}f/${fmtKB(afterRestart.bytes)}, ` +
					`cleanup_orphan_blobs(${JSON.stringify(cleanup.body)})->afterCleanupOp=${afterCleanupOp.files}f/${fmtKB(afterCleanupOp.bytes)}`
			);

			const netLeakedFiles = afterCleanupOp.files - base.files;
			const netLeakedBytes = afterCleanupOp.bytes - base.bytes;
			findings.push(
				`Arm A [${ENGINE}] VERDICT: net leaked after delete+audit-expiry+restart+cleanup_orphan_blobs = ` +
					`${netLeakedFiles} files / ${fmtKB(netLeakedBytes)} (${N} deletes => ${((netLeakedFiles / N) * 100).toFixed(0)}% retained) ` +
					(netLeakedFiles <= 0 ? '— RECLAIMED (no leak observed)' : '— LEAK CONFIRMED on disk')
			);
			// Exploratory: record the numbers as findings above; do not hard-fail the suite on a
			// leak (that IS the phenomenon under study), but do assert the harness measured
			// something sane (store actually created files) so a broken probe doesn't silently
			// report a false negative.
			ok(afterStore.files > base.files, 'sanity: store should have created on-disk blob files');
		}
	);

	// ── Arm B: audit-only expiry, record still LIVE — must never lose/corrupt the current blob ──
	test(
		`Arm B [${ENGINE}]: overwrite churn ages out PUT audit entries — live blob must survive`,
		{ timeout: 60_000 },
		async () => {
			const key = 'live-1';
			let expectedSha = '';
			for (let i = 0; i < 6; i++) {
				const r = await op({ action: 'store', key, size: BLOB_SIZE, seed: `${key}-${i}` }).expect(200);
				expectedSha = r.body.expectedSha;
				await sleep(600); // let each overwrite's prior-blob unlink (deletionDelay ~500ms) settle
			}
			const afterChurn = await diskUsage(blobRoot());

			// Wait past auditRetention (+ scan cycles) so the now-aged PUT audit entries from the
			// earlier overwrites are eligible for cleanup. removeAuditEntry() only special-cases
			// type==='delete' (auditStore.ts), so a PUT-type entry's expiry should never invoke a
			// blob delete-callback — this is the negative control for the "audit reference outliving
			// reclamation" framing in #708.
			await sleep((AUDIT_RETENTION_SECONDS + 1) * 1000 + 15_000);
			const afterExpiry = await diskUsage(blobRoot());

			const v = await op({ action: 'verify', key }).expect(200);
			strictEqual(
				v.body.present,
				true,
				'DEFECT: live record vanished after audit-only expiry (record was never deleted)'
			);
			strictEqual(v.body.match, true, `DEFECT: live blob corrupted after audit-only expiry: ${JSON.stringify(v.body)}`);
			strictEqual(v.body.storedSha, expectedSha, 'DEFECT: live blob sha mismatch after audit-only expiry');

			findings.push(
				`Arm B [${ENGINE}] live record churned 6x then aged past audit retention: afterChurn=${afterChurn.files}f/${fmtKB(afterChurn.bytes)}, ` +
					`afterExpiry=${afterExpiry.files}f/${fmtKB(afterExpiry.bytes)}, live blob intact=${v.body.match} (EXPECTED: survives, ~1 file)`
			);
			// A single live key should settle to ~1 file (the current blob); prior overwrite
			// generations are reclaimed by the update-path retainedFileIds guard, not by audit expiry.
			findings.push(
				afterExpiry.files <= 2
					? `Arm B [${ENGINE}] VERDICT: settled to ${afterExpiry.files} file(s) — no orphan growth from audit-only expiry (EXPECTED)`
					: `Arm B [${ENGINE}] VERDICT: ${afterExpiry.files} files remain — unexpected growth, investigate`
			);
		}
	);

	test('instance stayed alive throughout', async () => {
		const r = await client
			.req()
			.send({ operation: 'system_information', attributes: ['threads'] })
			.expect(200);
		ok(Array.isArray(r.body.threads), 'system_information should report threads (instance alive)');
	});
});
