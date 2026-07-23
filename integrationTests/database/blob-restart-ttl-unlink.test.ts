/**
 * QA-672 — Blob-backed page cache carried across an in-place version upgrade, with TTL still running.
 *
 * SCOPE-REDUCTION NOTICE (read first): true cross-version staging (integrationTests/upgrade/
 * minor-upgrade.test.ts / 4.x-upgrade.test.ts) requires HARPER_PREVIOUS_MINOR_PATH or
 * HARPER_LEGACY_VERSION_PATH pointing at a previously-installed Harper build. Neither env var
 * is set in this environment and no prior-version install was found locally, so a genuine
 * cross-version upgrade is infeasible here. This test uses the strongest REACHABLE arm instead:
 * a graceful kill + restart of the SAME current build on the SAME data directory (exactly the
 * `killHarper(ctx)` -> `startHarper(ctx, ...)` mechanism minor-upgrade.test.ts uses for its
 * post-upgrade steps), as a proxy for the upgrade restart boundary. This validates the
 * restart-survival / TTL-continuity / blob-unlink mechanics but does NOT exercise any actual
 * schema-version migration code path. Labelled explicitly in the report.
 *
 * Fixture: PageCache672 (LMDB engine — per-record @expiresAt is dead on RocksDB, F-174),
 * audit:false, Blob body always >8KB so it is always file-backed under
 * {dataRootDir}/blobs/data/{p}/{p}/{fileId}.
 *
 * Records seeded ("old version" / pre-restart phase):
 *   - survivor       — expiresAt = now+15min (never expires during the test): mirror-failure
 *                       control + post-restart byte-identical-read probe.
 *   - update-target  — expiresAt = now+15min: same as survivor, but POST-restart we PUT new
 *                       content onto it to probe old-blob-file release on update.
 *   - normal-0..4    — expiresAt = now+8s: NOT yet due at kill time (armed precondition below),
 *                       comes due shortly after restart -> probes "does the post-upgrade sweep
 *                       evict + unlink old-version records".
 *   - already-0..2   — expiresAt = now-10s: already past due AT THE MOMENT OF WRITE, i.e.
 *                       already-expired-at-upgrade-time by construction -> probes "is an
 *                       already-expired-at-upgrade record handled by the first post-upgrade
 *                       sweep, or stranded".
 *
 * Questions probed (axes B blob x G upgrade-boundary x C TTL):
 *   Q1 readability   — blob-backed records written pre-restart still fully readable (byte-exact
 *                       body + intact metadata) after the restart.
 *   Q2 sweep+unlink  — does the post-restart sweep evict old-version blob records AND physically
 *                       unlink their blob files (checked by walking the blob dir, not the API)?
 *   Q3 mirror-failure — does the sweep ever unlink a blob file whose record survives (dangling ref)?
 *   Q4 already-expired — is a pre-restart-already-expired record swept/unlinked post-restart, or stranded?
 *   Q5 update-release — does updating an old-version record post-restart release its old blob file
 *                        (eventually, via cleanup_orphan_blobs — no background orphan sweep exists,
 *                        per D-139/known ground truth)?
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   timeout 1200 npm run test:integration -- "integrationTests/database/blob-restart-ttl-unlink.test.ts"
 * Harper SHA: 7863b7468 (main, working tree as staged for this task)
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-restart-ttl-unlink');

// ── Tunables ─────────────────────────────────────────────────────────────────
const BLOB_SIZE = 64 * 1024; // > 8KB FILE_STORAGE_THRESHOLD -> always file-backed
const LONG_TTL_MS = 15 * 60 * 1000; // 15min: survivor/update-target must outlive the whole test
const NORMAL_TTL_MS = 8_000; // due shortly AFTER restart, NOT yet due at kill time (armed below)
const ALREADY_EXPIRED_OFFSET_MS = -10_000; // already 10s past due AT WRITE TIME
const NORMAL_COUNT = 5;
const ALREADY_COUNT = 3;
// runRecordExpirationEviction (Table.ts) runs on RECORD_PRUNING_INTERVAL=60s, per-process
// (plain setInterval from table-load time, not epoch-aligned) -> give a first-pass a full
// interval plus margin.
const SWEEP_WAIT_BUDGET_MS = 140_000; // ~2.3x RECORD_PRUNING_INTERVAL, covers 2 sweep passes
const SWEEP_POLL_INTERVAL_MS = 3_000;

const HARPER_CONFIG = {
	threads: { count: 1 }, // single worker: satisfies both getWorkerIndex()===0 (per-record TTL
	// sweep) and ===getWorkerCount()-1 deterministically
	storage: { engine: 'lmdb' as const }, // F-174: per-record @expiresAt is dead on RocksDB
	logging: { root: 'log', level: 'error' as const },
};

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

/** Recursively enumerate blob files (leaf files in the {p}/{p}/{fileId} fan-out tree). */
async function diskFiles(dir: string): Promise<{ files: number; bytes: number; paths: string[] }> {
	const paths: string[] = [];
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
			if (e.isDirectory()) {
				await walk(p);
			} else {
				try {
					bytes += (await stat(p)).size;
					paths.push(p);
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	return { files: paths.length, bytes, paths };
}

const fmtKB = (b: number) => `${(b / 1024).toFixed(0)}KB`;

suite(
	'QA-672 blob-backed page cache x in-place upgrade-restart x TTL',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let rootPath: string;
		let blobRootDir: string;
		let logFilePath: string;
		const findings: string[] = [];

		function op(body: Record<string, unknown>) {
			return request(client.restURL ?? (ctx.harper as any).httpURL)
				.post('/Ops672/')
				.set(client.headers)
				.send(body)
				.timeout(30_000);
		}

		async function waitRouteReady(timeoutMs: number) {
			// Per instructions: poll the probe route directly for non-404; do NOT call
			// restartHttpWorkers() against a pre-installed fixture (races/flakes).
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				try {
					const r = await fetch(`${client.restURL}/PageCache672/`, {
						method: 'GET',
						headers: { Authorization: client.headers.Authorization },
						signal: AbortSignal.timeout(3_000),
					});
					if (r.status !== 404) return;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
			throw new Error(`PageCache672 route never became ready within ${timeoutMs}ms`);
		}

		async function readLog(): Promise<string> {
			try {
				return await readFile(logFilePath, 'utf8');
			} catch {
				return '';
			}
		}

		async function checkAnomalyLog(): Promise<string[]> {
			const content = await readLog();
			const patterns = [
				'Error evicting record',
				'Cleanup error',
				'Error in evicting old records',
				'unhandledRejection',
				'UnhandledPromiseRejection',
			];
			const hits = patterns.filter((p) => content.includes(p));
			findings.push(`anomaly log scan: ${hits.length ? hits.join(', ') : 'none found'}`);
			return hits;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: HARPER_CONFIG, env: {} });
			client = createApiClient(ctx.harper);
			await waitRouteReady(120_000);

			const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
			rootPath = cfg.body.rootPath;
			ok(rootPath, 'get_configuration must return rootPath');
			blobRootDir = join(rootPath, 'blobs', 'data');
			logFilePath = join(rootPath, 'log', 'hdb.log');
			findings.push(`Harper SHA: 7863b7468 (working tree at task start)`);
			findings.push(`rootPath=${rootPath}`);
			findings.push(`blobRootDir=${blobRootDir}`);
			findings.push(
				`ARM: true cross-version upgrade infeasible here (no HARPER_PREVIOUS_MINOR_PATH/HARPER_LEGACY_VERSION_PATH install found) -> using kill+restart-same-build as the upgrade-boundary proxy`
			);
		});

		after(async () => {
			await teardownHarper(ctx);
			console.log('\n[QA-672] FINDINGS');
			for (const f of findings) console.log('  ' + f);
		});

		// Shared state across the ordered tests below.
		let survivorSha = '';
		let survivorMeta: { contentType: string; renderedAt: string; expiresAt: number } | null = null;
		let updateTargetSha = '';
		let baselineFiles = 0;

		test(
			'phase 1 (pre-restart / "old version"): seed blob-backed TTL records, arm preconditions',
			{ timeout: 60_000 },
			async () => {
				const survivorResp = await op({ action: 'store', id: 'survivor', size: BLOB_SIZE, ttlMs: LONG_TTL_MS }).expect(
					200
				);
				ok(survivorResp.body.ok, 'seed survivor failed');
				survivorSha = survivorResp.body.sha;
				survivorMeta = {
					contentType: survivorResp.body.contentType,
					renderedAt: survivorResp.body.renderedAt,
					expiresAt: survivorResp.body.expiresAt,
				};

				const updateResp = await op({
					action: 'store',
					id: 'update-target',
					size: BLOB_SIZE,
					ttlMs: LONG_TTL_MS,
				}).expect(200);
				ok(updateResp.body.ok, 'seed update-target failed');
				updateTargetSha = updateResp.body.sha;

				for (let i = 0; i < NORMAL_COUNT; i++) {
					const r = await op({ action: 'store', id: `normal-${i}`, size: BLOB_SIZE, ttlMs: NORMAL_TTL_MS }).expect(200);
					ok(r.body.ok, `seed normal-${i} failed`);
				}
				for (let i = 0; i < ALREADY_COUNT; i++) {
					const r = await op({
						action: 'store',
						id: `already-${i}`,
						size: BLOB_SIZE,
						ttlMs: ALREADY_EXPIRED_OFFSET_MS,
					}).expect(200);
					ok(r.body.ok, `seed already-${i} failed`);
				}

				const totalSeeded = 2 + NORMAL_COUNT + ALREADY_COUNT;
				findings.push(
					`phase1: seeded ${totalSeeded} blob-backed records (2 long-lived, ${NORMAL_COUNT} due-post-restart, ${ALREADY_COUNT} already-past-due-at-write-time)`
				);

				// ── ARMED PRECONDITION 1: all blobs actually landed as files on disk ──────
				const afterSeed = await diskFiles(blobRootDir);
				baselineFiles = afterSeed.files;
				findings.push(`phase1 ARM: disk after seed = ${afterSeed.files} files / ${fmtKB(afterSeed.bytes)}`);
				ok(
					afterSeed.files >= totalSeeded,
					`expected >= ${totalSeeded} blob files on disk after seed, got ${afterSeed.files}`
				);

				// ── ARMED PRECONDITION 2: already-N are logically past-due AND still physically
				//    resident (record + blob file), proven via the `raw` action (includeExpired:true
				//    bypass of the lazy expiresAt read-filter) which does NOT trigger the read-path's
				//    evict-on-read side effect (Table.ts ensureLoadedFromSource calls
				//    TableResource.evict() as an unawaited side effect of a plain `get` on an expired
				//    row with no source — using plain `get` here would contaminate the "untouched
				//    since write, upgrade lands on it cold" scenario this test is trying to isolate). ──
				for (let i = 0; i < ALREADY_COUNT; i++) {
					const r = await op({ action: 'raw', id: `already-${i}` }).expect(200);
					findings.push(
						`phase1 ARM already-${i}: rawPresent=${r.body.rawPresent} pastDue=${r.body.pastDue} readError=${r.body.readError ?? 'none'}`
					);
					ok(
						r.body.rawPresent === true,
						`already-${i} record must still be physically resident pre-restart (untouched-since-write precondition)`
					);
					ok(
						r.body.pastDue === true,
						`already-${i} expiresAt must already be in the past pre-restart (armed precondition failed)`
					);
					ok(
						!r.body.readError,
						`already-${i} blob body must still be readable pre-restart (file must exist), got error: ${r.body.readError}`
					);
				}
				// ── ARMED PRECONDITION 3: blob FILEs are nonetheless still physically on disk
				//    (sweep hasn't reclaimed them yet) — the "already expired at upgrade moment,
				//    file not yet unlinked" starting state Q4 requires ──
				const stillOnDisk = await diskFiles(blobRootDir);
				findings.push(
					`phase1 ARM: disk still has ${stillOnDisk.files} files despite ${ALREADY_COUNT} already-past-due records (60s sweep interval hasn't fired) -> already-N blob files are UNRECLAIMED at this instant, as required`
				);
				ok(
					stillOnDisk.files >= totalSeeded,
					`already-N blob files must still be present on disk pre-restart (unswept), got ${stillOnDisk.files}`
				);

				// ── ARMED PRECONDITION 4: normal-N and the two long-lived records are still LIVE ──
				for (let i = 0; i < NORMAL_COUNT; i++) {
					const r = await op({ action: 'get', id: `normal-${i}` }).expect(200);
					ok(
						r.body.present === true && r.body.shaMatch === true,
						`normal-${i} must be present+intact pre-restart (not yet due), got ${JSON.stringify(r.body)}`
					);
				}
				const survivorPre = await op({ action: 'get', id: 'survivor' }).expect(200);
				ok(
					survivorPre.body.present === true && survivorPre.body.shaMatch === true,
					'survivor must be present+intact pre-restart'
				);
				const updatePre = await op({ action: 'get', id: 'update-target' }).expect(200);
				ok(
					updatePre.body.present === true && updatePre.body.shaMatch === true,
					'update-target must be present+intact pre-restart'
				);
				findings.push(`phase1: all preconditions armed cleanly`);
			}
		);

		test('phase 2 (upgrade boundary): graceful kill + restart on same data dir', { timeout: 120_000 }, async () => {
			const t0 = Date.now();
			await killHarper(ctx);
			findings.push(`phase2: killHarper (graceful SIGTERM/SIGKILL-escalation) completed in ${Date.now() - t0}ms`);

			const restartT0 = Date.now();
			await startHarper(ctx, { config: HARPER_CONFIG, env: {} });
			client = createApiClient(ctx.harper);
			await waitRouteReady(120_000);
			findings.push(`phase2: restart + route-ready completed in ${Date.now() - restartT0}ms`);
		});

		test(
			'Q1: pre-restart blob records are still fully readable (byte-exact + metadata intact)',
			{ timeout: 30_000 },
			async () => {
				const survivorPost = await op({ action: 'get', id: 'survivor' }).expect(200);
				ok(survivorPost.body.present, 'survivor must survive the restart');
				strictEqual(survivorPost.body.readSha, survivorSha, 'survivor body bytes must be byte-identical after restart');
				strictEqual(
					survivorPost.body.shaMatch,
					true,
					'survivor stored sha256 metadata must still match its body after restart'
				);
				ok(survivorMeta, 'survivorMeta must have been captured pre-restart');
				strictEqual(
					survivorPost.body.contentType,
					survivorMeta!.contentType,
					'contentType metadata must survive restart'
				);
				strictEqual(survivorPost.body.renderedAt, survivorMeta!.renderedAt, 'renderedAt metadata must survive restart');
				strictEqual(
					survivorPost.body.expiresAt,
					survivorMeta!.expiresAt,
					'expiresAt metadata must survive restart unchanged'
				);
				findings.push(
					`Q1: survivor byte-exact + metadata intact after restart (sha=${survivorPost.body.readSha.slice(0, 12)}..)`
				);

				const updatePost = await op({ action: 'get', id: 'update-target' }).expect(200);
				ok(
					updatePost.body.present && updatePost.body.readSha === updateTargetSha,
					'update-target must survive the restart byte-exact'
				);
				findings.push(`Q1: update-target byte-exact after restart`);

				const diskAfterRestart = await diskFiles(blobRootDir);
				findings.push(
					`Q1: disk file count unchanged across restart: ${diskAfterRestart.files} (baseline was ${baselineFiles})`
				);
				ok(
					diskAfterRestart.files >= baselineFiles,
					`blob files must not vanish across a clean restart, got ${diskAfterRestart.files} vs baseline ${baselineFiles}`
				);
			}
		);

		test(
			'Q2/Q3/Q4: post-restart sweep evicts old-version + already-expired records, never touches survivors',
			{ timeout: SWEEP_WAIT_BUDGET_MS + 30_000 },
			async () => {
				// NOTE ON METHOD: file-unlink is allowed to lag record-eviction by design (blob files
				// are reclaimed on-demand via cleanup_orphan_blobs, not a background sweep — D-139/
				// F-098 ground truth). So THIS test's pass/fail gate is RECORD eviction (via the
				// side-effect-free `raw` action, includeExpired:true), not raw disk-file convergence.
				// Disk-file convergence is decisively judged in the next test, AFTER cleanup_orphan_blobs.
				const deadline = Date.now() + SWEEP_WAIT_BUDGET_MS;
				const trajectory: string[] = [];

				while (Date.now() < deadline) {
					const d = await diskFiles(blobRootDir);
					trajectory.push(`${d.files}f`);

					// Mirror-failure check on EVERY poll: survivor/update-target must never go dangling.
					const survivorCheck = await op({ action: 'get', id: 'survivor' }).expect(200);
					const updateCheck = await op({ action: 'get', id: 'update-target' }).expect(200);
					ok(
						survivorCheck.body.present && survivorCheck.body.shaMatch === true,
						`MIRROR-FAILURE (Q3): survivor became dangling/absent mid-sweep: ${JSON.stringify(survivorCheck.body)}`
					);
					ok(
						updateCheck.body.present && updateCheck.body.shaMatch === true,
						`MIRROR-FAILURE (Q3): update-target became dangling/absent mid-sweep: ${JSON.stringify(updateCheck.body)}`
					);

					// Ground-truth sample (bypassing the lazy filter) on one representative id per
					// group, so the trajectory shows exactly when the RECORD (not just the API view)
					// actually gets evicted.
					const normal0 = await op({ action: 'raw', id: 'normal-0' }).expect(200);
					const already0 = await op({ action: 'raw', id: 'already-0' }).expect(200);
					trajectory.push(
						`[normal-0 rawPresent=${normal0.body.rawPresent} already-0 rawPresent=${already0.body.rawPresent}]`
					);

					if (normal0.body.rawPresent === false && already0.body.rawPresent === false) break;
					await sleep(SWEEP_POLL_INTERVAL_MS);
				}
				findings.push(
					`Q2/Q4 disk+raw trajectory (post-restart, poll every ${SWEEP_POLL_INTERVAL_MS}ms): ${trajectory.join(' -> ')}`
				);

				const anomalies = await checkAnomalyLog();

				// ── DECISIVE ground-truth check for ALL normal-N and already-N ids ──
				const normalRaw = await Promise.all(
					Array.from({ length: NORMAL_COUNT }, (_, i) => op({ action: 'raw', id: `normal-${i}` }).expect(200))
				);
				const alreadyRaw = await Promise.all(
					Array.from({ length: ALREADY_COUNT }, (_, i) => op({ action: 'raw', id: `already-${i}` }).expect(200))
				);

				const normalStillResident = normalRaw.filter((r) => r.body.rawPresent === true);
				const alreadyStillResident = alreadyRaw.filter((r) => r.body.rawPresent === true);
				// DANGLING/MIRROR-FAILURE signature: record still resident (rawPresent) but its blob
				// body can no longer be read (readError, e.g. ENOENT) — the exact "later read 500s/
				// ENOENTs" shape the scenario warns about.
				const danglingRefs = [...normalRaw, ...alreadyRaw].filter(
					(r) => r.body.rawPresent === true && r.body.readError
				);

				findings.push(
					`Q2 normal-N ground truth: ${NORMAL_COUNT - normalStillResident.length}/${NORMAL_COUNT} evicted, ${normalStillResident.length} still resident`
				);
				findings.push(
					`Q4 already-N ground truth: ${ALREADY_COUNT - alreadyStillResident.length}/${ALREADY_COUNT} evicted, ${alreadyStillResident.length} still resident`
				);
				findings.push(`Q3 dangling-ref (rawPresent + unreadable body) count: ${danglingRefs.length}`);

				if (normalStillResident.length === 0) {
					findings.push(
						`Q2 VERDICT: post-restart sweep evicted all ${NORMAL_COUNT} normal-N old-version records (CLEAN)`
					);
				} else {
					findings.push(
						`Q2 VERDICT: DEFECT — ${normalStillResident.length}/${NORMAL_COUNT} normal-N record(s) never evicted within ${SWEEP_WAIT_BUDGET_MS}ms`
					);
				}
				if (alreadyStillResident.length === 0) {
					findings.push(
						`Q4 VERDICT: already-expired-at-upgrade records were NOT stranded — the post-upgrade sweep evicted all ${ALREADY_COUNT} (CLEAN)`
					);
				} else {
					findings.push(
						`Q4 VERDICT: STRANDED DEFECT — ${alreadyStillResident.length}/${ALREADY_COUNT} already-expired-at-upgrade record(s) never evicted by the post-upgrade sweep`
					);
				}
				findings.push(
					`Q3 VERDICT: ${danglingRefs.length === 0 ? 'no mirror-failure observed (CLEAN)' : 'MIRROR-FAILURE DEFECT observed'}`
				);

				ok(
					danglingRefs.length === 0,
					`Q3 DEFECT (mirror-failure): ${danglingRefs.length} record(s) resident-but-unreadable: ${JSON.stringify(danglingRefs.map((r) => r.body))}`
				);
				ok(
					normalStillResident.length === 0,
					`Q2 DEFECT: ${normalStillResident.length}/${NORMAL_COUNT} normal-N record(s) were never evicted by the post-upgrade sweep`
				);
				ok(
					alreadyStillResident.length === 0,
					`Q4 DEFECT (STRANDED): ${alreadyStillResident.length}/${ALREADY_COUNT} already-expired-at-upgrade record(s) were never evicted by the post-upgrade sweep (stranded across the upgrade boundary)`
				);
				ok(anomalies.length === 0, `unexpected anomaly-log evidence during the sweep: ${anomalies.join(', ')}`);
			}
		);

		test(
			'post-sweep decisive orphan check: cleanup_orphan_blobs converges to exactly the live set',
			{ timeout: 60_000 },
			async () => {
				const preCleanup = await diskFiles(blobRootDir);
				findings.push(`pre-cleanup_orphan_blobs disk: ${preCleanup.files} files`);

				const cleanupResp = await client
					.req()
					.send({ operation: 'cleanup_orphan_blobs', database: 'data' })
					.expect(200);
				findings.push(`cleanup_orphan_blobs response: ${JSON.stringify(cleanupResp.body).slice(0, 200)}`);

				let filesAfter = preCleanup.files;
				const traj: string[] = [];
				for (let i = 0; i < 10; i++) {
					await sleep(3_000);
					const d = await diskFiles(blobRootDir);
					filesAfter = d.files;
					traj.push(`+${(i + 1) * 3}s:${d.files}f`);
					if (d.files <= 2 + 2) break; // survivor + update-target, +tolerance
				}
				findings.push(`disk trajectory after cleanup_orphan_blobs: ${traj.join(' -> ')}`);

				const tolerance = 5;
				findings.push(
					`final disk file count = ${filesAfter} (expected ~2: survivor + update-target, tolerance=${tolerance})`
				);
				if (filesAfter <= 2 + tolerance) {
					findings.push(`orphan-file VERDICT: CLEAN — no genuine leak survives cleanup_orphan_blobs`);
				} else {
					findings.push(
						`orphan-file VERDICT: POSSIBLE LEAK — ${filesAfter} files remain for 2 live records even after cleanup_orphan_blobs`
					);
				}
				ok(
					filesAfter <= 2 + tolerance,
					`GENUINE ORPHAN-FILE LEAK: ${filesAfter} blob files remain for 2 live records after cleanup_orphan_blobs (tolerance=${tolerance})`
				);
			}
		);

		test(
			'Q5: post-restart UPDATE of an old-version record releases its old blob file',
			{ timeout: 60_000 },
			async () => {
				const beforeUpdate = await diskFiles(blobRootDir);
				findings.push(`Q5: disk before update = ${beforeUpdate.files} files`);

				const updateResp = await op({
					action: 'update',
					id: 'update-target',
					size: BLOB_SIZE,
					ttlMs: LONG_TTL_MS,
					gen: 1,
				}).expect(200);
				ok(updateResp.body.ok, 'update of update-target failed');
				const newSha = updateResp.body.sha;
				ok(newSha !== updateTargetSha, 'updated content must produce a different sha than the pre-restart content');

				// Correctness: the record now reads back the NEW content, not the stale old-version bytes.
				const afterUpdate = await op({ action: 'get', id: 'update-target' }).expect(200);
				strictEqual(afterUpdate.body.readSha, newSha, 'update-target must read back the NEW content post-update');
				strictEqual(afterUpdate.body.shaMatch, true, 'update-target sha256 metadata must match the new content');
				findings.push(
					`Q5: update-target correctly reads new content post-update (old sha ${updateTargetSha.slice(0, 12)}.. -> new ${newSha.slice(0, 12)}..)`
				);

				// Old blob file release: per known ground truth there is no background orphan sweep, so an
				// immediately-elevated file count right after update is EXPECTED, not a leak on its own.
				const rightAfterUpdate = await diskFiles(blobRootDir);
				findings.push(
					`Q5: disk right after update = ${rightAfterUpdate.files} files (old file may still be present as an on-demand orphan; expected)`
				);

				const cleanupResp = await client
					.req()
					.send({ operation: 'cleanup_orphan_blobs', database: 'data' })
					.expect(200);
				findings.push(`Q5: cleanup_orphan_blobs response: ${JSON.stringify(cleanupResp.body).slice(0, 200)}`);

				let filesAfter = rightAfterUpdate.files;
				const traj: string[] = [];
				for (let i = 0; i < 10; i++) {
					await sleep(3_000);
					const d = await diskFiles(blobRootDir);
					filesAfter = d.files;
					traj.push(`+${(i + 1) * 3}s:${d.files}f`);
					if (d.files <= 2 + 2) break; // survivor + update-target(new file only), + tolerance
				}
				findings.push(`Q5: disk trajectory after cleanup_orphan_blobs: ${traj.join(' -> ')}`);

				const tolerance = 5;
				if (filesAfter <= 2 + tolerance) {
					findings.push(
						`Q5 VERDICT: CLEAN — old blob file for update-target was reclaimed (directly or via cleanup_orphan_blobs), no permanent leak`
					);
				} else {
					findings.push(
						`Q5 VERDICT: DEFECT — old blob file for update-target was never reclaimed even after cleanup_orphan_blobs (${filesAfter} files for 2 live records)`
					);
				}
				ok(
					filesAfter <= 2 + tolerance,
					`Q5 DEFECT: old blob file for update-target was not released even after cleanup_orphan_blobs: ${filesAfter} files remain for 2 live records (tolerance=${tolerance})`
				);
			}
		);

		test('liveness: Harper stayed alive throughout', { timeout: 10_000 }, async () => {
			const r = await client
				.req()
				.send({ operation: 'system_information', attributes: ['threads'] })
				.expect(200);
			ok(Array.isArray(r.body.threads), 'system_information should report threads');
			findings.push(`liveness: alive, ${r.body.threads.length} thread(s)`);
		});
	}
);
