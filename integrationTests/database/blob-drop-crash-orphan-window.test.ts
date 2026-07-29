/**
 * QA-809 — the blob drop-path kill window: are blob files orphaned FOREVER if the process
 * dies inside it?
 *
 * Background (prior QA wave, this same checkout): `drop_table` returns to the client BEFORE
 * its blob files are unlinked. `Table.ts` dropTable() walks its own primaryStore and calls
 * `deleteBlobsInObject()` for every HAS_BLOBS entry -- deleteBlob() (blob.ts) schedules the
 * actual unlink via `setTimeout(deletionDelay=500ms)` -- BEFORE dropping the column family /
 * removing the catalog rows, and only after all of that does the op return. So there is a
 * roughly 0.5-3s window, starting the instant the op returns, in which the table's metadata is
 * already gone (column family dropped, catalog rows removed, no "interrupted drop" tombstone
 * left to resume) but its blob files are still on disk waiting on pending unlink timers.
 *
 * Static read at SHA d112560b6 relevant to what happens if the process dies IN that window:
 *  - `completeInterruptedDrop()` (resources/databases.ts:1833), the only drop-recovery path run
 *    at boot, drops any surviving column families and removes catalog rows for a table whose
 *    "dropping" tombstone is still set. It does NOT touch the blob directory or re-walk for
 *    blob references -- and by the time drop_table has already returned 200, the tombstone is
 *    long cleared and the column family long dropped, so this path is not even reachable for
 *    our kill window; there is no drop-recovery machinery of any kind for post-return blobs.
 *  - `cleanupOrphans()` (resources/blob.ts:1871, op name `cleanup_orphan_blobs`) is a genuine
 *    orphan sweep: it walks {dataRootDir}/blobs/{db}/... directly on disk (NOT scoped by
 *    table), then cross-references every SURVIVING table's live entries + audit log in that
 *    database, and unlinks whatever is unreferenced. So a dropped table's blob files ARE
 *    findable by this sweep as long as the *database* still has >=1 surviving table -- the
 *    top-of-function `for (const tableName in database) { ...; if (auditStore) break; }` loop
 *    just needs one table to resolve a store/auditStore pair to find the DB's root blob paths;
 *    an all-tables-dropped (empty) database never enters that loop (QA-697's prior finding).
 *    This fixture keeps a sibling `Keepalive` table alive in db "qa809t" for exactly that
 *    reason, matching qa805's fixture design.
 *  - `drop_database` (resources/databases.ts ~893) is reported to synchronously await a
 *    whole-directory rimraf (`deleteRootBlobPathsForDB`) before the op returns -- verified
 *    empirically below (checkpoint 2 immediately after return), not assumed.
 *
 * Design: sweep the kill delay AFTER drop_table returns -- 0ms, 100ms, 400ms, 600ms, and a
 * control that lets the unlink complete normally (no kill) -- with a four-checkpoint disk
 * ledger (files + bytes) at: before the drop / immediately after the drop returns / after a
 * full process restart / after an explicit cleanup_orphan_blobs op. Same four checkpoints for
 * drop_database, with a kill-at-0ms arm and a no-kill control.
 *
 * Oracle discipline: every arm asserts a floor before it means anything --
 *  (a) blob files actually existed before the drop (checkpoint 1 delta >= N),
 *  (b) for the kill@0ms drop_table arm specifically, files must still be present immediately
 *      after the drop returns (survived > 0) -- if this doesn't reproduce, the premise of the
 *      whole sweep (a real post-return window exists) is false and that arm hard-fails instead
 *      of silently reporting "no leak",
 *  (c) the kill is confirmed to land on a still-live process at (or after) the intended delay,
 *      not on one that already exited on its own.
 * No arm passes vacuously: 0-file arms fail loudly rather than being counted as clean.
 *
 * Reproduction:
 *   cd <harper checkout> && timeout 1200 npm run test:integration -- \
 *     "integrationTests/database/blob-drop-crash-orphan-window.test.ts"
 * Harper SHA at promotion: 80ef45996 (main)
 * Engine: default (RocksDB) only, per task scope.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-drop-crash-orphan-window');
const BLOB_SIZE = 256 * 1024; // 256KB — well above the 8KB FILE_STORAGE_THRESHOLD, always file-backed
const N = 100; // per-arm blob count; 100 x 256KB = ~25MB, leaked bytes are unmistakable
const WRITE_CONCURRENCY = 16;
const HARPER_CONFIG = { logging: { console: true, level: 'error' } };
const skipSuite = process.platform === 'win32';

interface KillArm {
	name: string;
	table: string;
	delayMs: number; // ms after drop_table returns before SIGKILL
}

const KILL_ARMS: KillArm[] = [
	{ name: 'k0', table: 'BlobTableK0', delayMs: 0 },
	{ name: 'k100', table: 'BlobTableK100', delayMs: 100 },
	{ name: 'k400', table: 'BlobTableK400', delayMs: 400 },
	{ name: 'k600', table: 'BlobTableK600', delayMs: 600 },
];

/** Recursively count files + bytes under a blob storage tree ({dataRootDir}/blobs/{db}/{p}/{p}/{fileId}). */
async function diskUsage(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return; // dir not created yet, or already removed
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

function fmt(u: { files: number; bytes: number }) {
	return `${u.files}f/${u.bytes}B`;
}

function delta(a: { files: number; bytes: number }, b: { files: number; bytes: number }) {
	return { files: a.files - b.files, bytes: a.bytes - b.bytes };
}

suite(`QA-809 drop-path kill-window sweep [rocksdb]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	const findings: string[] = [];
	const ledger: Record<string, { files: number; bytes: number }> = {};

	function blobDir(db: string) {
		return join(ctx.harper.dataRootDir, 'blobs', db);
	}

	async function waitReady(probePath: string, timeoutMs = 120_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest(probePath).timeout(2000);
				if (probe.status !== 404) return;
			} catch {
				/* not ready yet */
			}
			await sleep(250);
		}
		throw new Error(`timed out waiting for route ${probePath} to become ready`);
	}

	async function refreshClientAfterRestart() {
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		await waitReady('/Keepalive/');
	}

	/** Hard restart: SIGKILL (no grace period) then start fresh on the same dataRootDir. */
	async function killAndRestart() {
		ok(
			ctx.harper.process && ctx.harper.process.exitCode == null && !ctx.harper.process.killed,
			'process must still be alive at the intended kill instant — otherwise this arm did not test what it claims'
		);
		const dataRootDir = ctx.harper.dataRootDir;
		const hostname = ctx.harper.hostname;
		await killHarper(ctx as any, { graceMs: 0 }); // no grace period: SIGTERM then immediate SIGKILL
		(ctx as any).harper = { dataRootDir, hostname };
		await startHarper(ctx as any, { config: HARPER_CONFIG });
		await refreshClientAfterRestart();
	}

	/** Graceful restart (no kill): control arms still get a checkpoint-3 data point. */
	async function gracefulRestart() {
		const dataRootDir = ctx.harper.dataRootDir;
		const hostname = ctx.harper.hostname;
		await killHarper(ctx as any, { graceMs: 5000 });
		(ctx as any).harper = { dataRootDir, hostname };
		await startHarper(ctx as any, { config: HARPER_CONFIG });
		await refreshClientAfterRestart();
	}

	async function postBlob809(body: Record<string, unknown>) {
		const res = await fetch(`${httpURL}/Blob809/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: JSON.stringify(body),
		});
		const json = await res.json().catch(() => ({}));
		return { status: res.status, body: json };
	}

	async function storeN(db: string, table: string, prefix: string, n: number) {
		for (let i = 0; i < n; i += WRITE_CONCURRENCY) {
			const batch = [];
			for (let j = i; j < Math.min(i + WRITE_CONCURRENCY, n); j++) {
				const id = `${prefix}-${j}`;
				batch.push(
					postBlob809({ action: 'store', db, table, id, size: BLOB_SIZE, seed: id }).then((r) =>
						strictEqual(r.status, 200, `store ${db}.${table}/${id} failed: ${JSON.stringify(r.body)}`)
					)
				);
			}
			await Promise.all(batch);
		}
	}

	function opReq(body: Record<string, unknown>) {
		return client.req().timeout(120_000).send(body);
	}

	/** Poll cleanup_orphan_blobs settle for up to ~10s, returning the final reading + trajectory. */
	async function settleAfterCleanup(dir: string) {
		let final = await diskUsage(dir);
		const traj: string[] = [`+0s=${fmt(final)}`];
		for (let t = 0; t < 5; t++) {
			await sleep(2_000);
			final = await diskUsage(dir);
			traj.push(`+${(t + 1) * 2}s=${fmt(final)}`);
		}
		return { final, traj };
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: HARPER_CONFIG });
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		await waitReady('/Keepalive/');
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} catch {
			/* best-effort */
		}
		console.log(`\n[QA-809] LEDGER (checkpoint: files/bytes)`);
		for (const [k, v] of Object.entries(ledger)) console.log(`  ${k}: ${fmt(v)}`);
		console.log(`\n[QA-809] FINDINGS`);
		for (const f of findings) console.log('  ' + f);
	});

	// ── Baseline: keep a sibling table alive in "qa809t" so cleanup_orphan_blobs stays usable
	// across every drop_table arm (an empty database never resolves a store/auditStore pair). ──
	test('setup: seed Keepalive baseline in db "qa809t"', async () => {
		await storeN('qa809t', 'Keepalive', 'keep', 5);
		const usage = await diskUsage(blobDir('qa809t'));
		ledger['qa809t: 0. Keepalive baseline'] = usage;
		ok(usage.files >= 5, `expected >=5 baseline blob files, got ${usage.files}`);
	});

	async function verifyKeepaliveIntact(label: string) {
		for (let i = 0; i < 5; i++) {
			const v = await postBlob809({ action: 'verify', db: 'qa809t', table: 'Keepalive', id: `keep-${i}` });
			ok(
				(v.body as any).present && (v.body as any).size === BLOB_SIZE,
				`Keepalive/keep-${i} damaged (${label}): ${JSON.stringify(v.body)}`
			);
		}
	}

	// ── Kill-delay sweep for drop_table. ───────────────────────────────────────────────────────
	for (const arm of KILL_ARMS) {
		test(`drop_table kill@${arm.delayMs}ms: four-checkpoint ledger`, async (t) => {
			if (ctx.harper.process?.exitCode != null || ctx.harper.process?.killed) {
				t.skip('instance already down from a prior arm');
				return;
			}
			const dbBefore = await diskUsage(blobDir('qa809t'));
			await storeN('qa809t', arm.table, arm.name, N);
			const cp1 = await diskUsage(blobDir('qa809t'));
			ledger[`${arm.name}: 1. before drop_table (after write)`] = cp1;
			const wrote = delta(cp1, dbBefore);
			ok(wrote.files >= N, `floor: expected +${N} files from ${arm.table} writes before the drop, got +${wrote.files}`);

			const dropRes = await opReq({ operation: 'drop_table', schema: 'qa809t', table: arm.table });
			strictEqual(dropRes.status, 200, `drop_table ${arm.table} failed: ${JSON.stringify(dropRes.body)}`);
			const returnInstant = Date.now();

			const cp2 = await diskUsage(blobDir('qa809t'));
			ledger[`${arm.name}: 2. immediately after drop_table returns`] = cp2;
			const survivedAtReturn = delta(cp2, dbBefore).files;
			findings.push(
				`[k${arm.delayMs}] immediately after drop_table returns: ${survivedAtReturn}/${N} ${arm.table} blob files still on disk`
			);
			if (arm.delayMs === 0) {
				// Observation, not an assertion. A fix that unlinks synchronously before drop_table
				// returns closes this window entirely — an improvement, which must not turn this
				// anchor red. The invariant asserted after cleanup below holds either way; recording
				// the window state keeps a closed window visible rather than silently vacuous.
				findings.push(
					survivedAtReturn > 0
						? `[k0] post-return unlink window is OPEN: ${survivedAtReturn}/${N} ${arm.table} files survive drop_table's return.`
						: `[k0] post-return unlink window is CLOSED (0 survivors at return) — drop_table reclaims before returning; the kill arms degrade to no-op controls.`
				);
			}

			if (arm.delayMs > 0) await sleep(arm.delayMs);
			const elapsedSinceReturn = Date.now() - returnInstant;
			ok(
				elapsedSinceReturn >= arm.delayMs && elapsedSinceReturn < arm.delayMs + 3000,
				`kill did not land at the intended delay: wanted ~${arm.delayMs}ms after return, actual elapsed=${elapsedSinceReturn}ms`
			);
			const preKill = await diskUsage(blobDir('qa809t'));
			findings.push(
				`[k${arm.delayMs}] at kill instant (t+${elapsedSinceReturn}ms since return): ${delta(preKill, dbBefore).files}/${N} files still present`
			);

			await killAndRestart();

			const cp3 = await diskUsage(blobDir('qa809t'));
			ledger[`${arm.name}: 3. after restart`] = cp3;
			const survivedAfterRestart = delta(cp3, dbBefore).files;
			findings.push(
				`[k${arm.delayMs}] after restart: ${survivedAfterRestart}/${N} ${arm.table} files still present (recovery-reclaimed = ${survivedAfterRestart === 0 && survivedAtReturn > 0})`
			);
			await verifyKeepaliveIntact(`k${arm.delayMs} post-restart`);

			const cleanupRes = await opReq({ operation: 'cleanup_orphan_blobs', database: 'qa809t' });
			strictEqual(cleanupRes.status, 200, `cleanup_orphan_blobs failed: ${JSON.stringify(cleanupRes.body)}`);
			const { final, traj } = await settleAfterCleanup(blobDir('qa809t'));
			ledger[`${arm.name}: 4. after cleanup_orphan_blobs (settled)`] = final;
			const survivedAfterCleanup = delta(final, dbBefore).files;
			findings.push(
				`[k${arm.delayMs}] post-cleanup_orphan_blobs trajectory: ${traj.join(', ')} (delta vs pre-arm baseline = ${survivedAfterCleanup})`
			);

			// The invariant that survives any fix to the drop path: whatever a crash inside the
			// unlink window leaves behind, cleanup_orphan_blobs must reclaim. A file that is still
			// orphaned after restart + cleanup is unreclaimable disk — the user-visible defect.
			// Asserted, not merely logged: the VERDICT strings below report but cannot fail.
			ok(
				survivedAfterCleanup <= 1,
				`[k${arm.delayMs}] ${survivedAfterCleanup} blob file(s) remain PERMANENTLY ORPHANED after restart + ` +
					`cleanup_orphan_blobs (delta vs pre-arm baseline). cleanup_orphan_blobs must fully reclaim files ` +
					`orphaned by a crash inside drop_table's unlink window.`
			);

			if (survivedAfterRestart > 0 && survivedAfterCleanup <= 1) {
				findings.push(
					`[k${arm.delayMs}] VERDICT: orphans NOT auto-reclaimed by recovery, but fully reclaimed by cleanup_orphan_blobs.`
				);
			} else if (survivedAtReturn > 0 && survivedAfterRestart === 0) {
				findings.push(
					`[k${arm.delayMs}] VERDICT: orphans reclaimed automatically by recovery/restart (unexpected per static read — worth double-checking).`
				);
			} else if (survivedAfterCleanup > 1) {
				findings.push(
					`[k${arm.delayMs}] VERDICT: DEFECT — ${survivedAfterCleanup} file(s) remain PERMANENTLY ORPHANED even after restart + cleanup_orphan_blobs.`
				);
			} else {
				findings.push(
					`[k${arm.delayMs}] VERDICT: no survivors past the return checkpoint for this arm (window may have already closed by delay=${arm.delayMs}ms — see checkpoint 2 above).`
				);
			}
			await verifyKeepaliveIntact(`k${arm.delayMs} post-cleanup`);
		});
	}

	// ── Control: drop_table, no kill, unlink allowed to complete normally. ────────────────────
	test('drop_table CONTROL (no kill): four-checkpoint ledger', async (t) => {
		if (ctx.harper.process?.exitCode != null || ctx.harper.process?.killed) {
			t.skip('instance already down from a prior arm');
			return;
		}
		const dbBefore = await diskUsage(blobDir('qa809t'));
		await storeN('qa809t', 'BlobTableCtrl', 'ctrl', N);
		const cp1 = await diskUsage(blobDir('qa809t'));
		ledger['ctrl: 1. before drop_table (after write)'] = cp1;
		ok(
			delta(cp1, dbBefore).files >= N,
			`floor: expected +${N} files from BlobTableCtrl writes, got +${delta(cp1, dbBefore).files}`
		);

		const dropRes = await opReq({ operation: 'drop_table', schema: 'qa809t', table: 'BlobTableCtrl' });
		strictEqual(dropRes.status, 200, `drop_table BlobTableCtrl failed: ${JSON.stringify(dropRes.body)}`);
		const cp2 = await diskUsage(blobDir('qa809t'));
		ledger['ctrl: 2. immediately after drop_table returns'] = cp2;
		findings.push(`[ctrl] immediately after return: ${delta(cp2, dbBefore).files}/${N} files still present`);

		await sleep(3_000); // give the scheduled 500ms unlinks generous margin to complete naturally
		const cp2settled = await diskUsage(blobDir('qa809t'));
		ledger['ctrl: 2b. settled +3s (no kill, unlink allowed to complete)'] = cp2settled;
		const survivedSettled = delta(cp2settled, dbBefore).files;
		findings.push(`[ctrl] +3s settle, no kill: ${survivedSettled}/${N} files still present`);

		await gracefulRestart();
		const cp3 = await diskUsage(blobDir('qa809t'));
		ledger['ctrl: 3. after graceful restart'] = cp3;
		findings.push(`[ctrl] after graceful restart: ${delta(cp3, dbBefore).files}/${N} files still present`);
		await verifyKeepaliveIntact('ctrl post-restart');

		const cleanupRes = await opReq({ operation: 'cleanup_orphan_blobs', database: 'qa809t' });
		strictEqual(cleanupRes.status, 200, `cleanup_orphan_blobs failed: ${JSON.stringify(cleanupRes.body)}`);
		const { final, traj } = await settleAfterCleanup(blobDir('qa809t'));
		ledger['ctrl: 4. after cleanup_orphan_blobs (settled)'] = final;
		const survivedFinal = delta(final, dbBefore).files;
		findings.push(`[ctrl] post-cleanup trajectory: ${traj.join(', ')} (final delta = ${survivedFinal})`);
		ok(
			survivedFinal <= 1,
			`CONTROL should leave ~0 files after settle+cleanup even without a kill; got ${survivedFinal}`
		);
		await verifyKeepaliveIntact('ctrl post-cleanup');
	});

	// ── drop_database: kill immediately (0ms) after the op returns. ───────────────────────────
	test('drop_database kill@0ms: four-checkpoint ledger', async (t) => {
		if (ctx.harper.process?.exitCode != null || ctx.harper.process?.killed) {
			t.skip('instance already down from a prior arm');
			return;
		}
		const dir = blobDir('qa809d0');
		const before_ = await diskUsage(dir);
		await storeN('qa809d0', 'BlobDBKill0', 'dbk0', N);
		const cp1 = await diskUsage(dir);
		ledger['dbKill0: 1. before drop_database (after write)'] = cp1;
		ok(
			delta(cp1, before_).files >= N,
			`floor: expected +${N} files from BlobDBKill0 writes, got +${delta(cp1, before_).files}`
		);

		const dropRes = await opReq({ operation: 'drop_database', database: 'qa809d0' });
		strictEqual(dropRes.status, 200, `drop_database qa809d0 failed: ${JSON.stringify(dropRes.body)}`);
		const cp2 = await diskUsage(dir);
		ledger['dbKill0: 2. immediately after drop_database returns'] = cp2;
		findings.push(
			`[dbKill0] immediately after drop_database returns: ${cp2.files}f/${cp2.bytes}B remain (claim: rimraf is awaited before response, so this should be 0)`
		);
		strictEqual(
			cp2.files,
			0,
			`DEFECT check: expected 0 blob files immediately after drop_database returns, got ${cp2.files}`
		);

		// Kill anyway (0ms) to confirm nothing resurrects post-crash, and to fill the same
		// checkpoint-3/4 slots as the drop_table arms for a like-for-like comparison.
		await killAndRestart();
		const cp3 = await diskUsage(dir);
		ledger['dbKill0: 3. after restart'] = cp3;
		findings.push(`[dbKill0] after restart: ${cp3.files}f/${cp3.bytes}B`);

		const cleanupRes = await opReq({ operation: 'cleanup_orphan_blobs', database: 'qa809d0' });
		findings.push(
			`[dbKill0] cleanup_orphan_blobs(qa809d0) response (db no longer exists): status=${cleanupRes.status} body=${JSON.stringify(cleanupRes.body)}`
		);
		const cp4 = await diskUsage(dir);
		ledger['dbKill0: 4. after cleanup_orphan_blobs attempt'] = cp4;
		strictEqual(
			cp4.files,
			0,
			`drop_database must leave 0 blob files at every checkpoint, including post-restart/post-cleanup-attempt; got ${cp4.files}`
		);
	});

	// ── drop_database: control, no kill. ───────────────────────────────────────────────────────
	test('drop_database CONTROL (no kill): four-checkpoint ledger', async (t) => {
		if (ctx.harper.process?.exitCode != null || ctx.harper.process?.killed) {
			t.skip('instance already down from a prior arm');
			return;
		}
		const dir = blobDir('qa809dc');
		const before_ = await diskUsage(dir);
		await storeN('qa809dc', 'BlobDBCtrl', 'dbc', N);
		const cp1 = await diskUsage(dir);
		ledger['dbCtrl: 1. before drop_database (after write)'] = cp1;
		ok(
			delta(cp1, before_).files >= N,
			`floor: expected +${N} files from BlobDBCtrl writes, got +${delta(cp1, before_).files}`
		);

		const dropRes = await opReq({ operation: 'drop_database', database: 'qa809dc' });
		strictEqual(dropRes.status, 200, `drop_database qa809dc failed: ${JSON.stringify(dropRes.body)}`);
		const cp2 = await diskUsage(dir);
		ledger['dbCtrl: 2. immediately after drop_database returns'] = cp2;
		findings.push(`[dbCtrl] immediately after drop_database returns: ${cp2.files}f/${cp2.bytes}B remain`);
		strictEqual(
			cp2.files,
			0,
			`DEFECT check: expected 0 blob files immediately after drop_database returns, got ${cp2.files}`
		);

		await gracefulRestart();
		const cp3 = await diskUsage(dir);
		ledger['dbCtrl: 3. after graceful restart'] = cp3;
		findings.push(`[dbCtrl] after graceful restart: ${cp3.files}f/${cp3.bytes}B`);

		const cleanupRes = await opReq({ operation: 'cleanup_orphan_blobs', database: 'qa809dc' });
		findings.push(
			`[dbCtrl] cleanup_orphan_blobs(qa809dc) response (db no longer exists): status=${cleanupRes.status} body=${JSON.stringify(cleanupRes.body)}`
		);
		const cp4 = await diskUsage(dir);
		ledger['dbCtrl: 4. after cleanup_orphan_blobs attempt'] = cp4;
		strictEqual(cp4.files, 0, `drop_database must leave 0 blob files at every checkpoint; got ${cp4.files}`);
	});
});
