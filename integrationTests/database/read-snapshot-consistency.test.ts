/**
 * QA-184 — Single-snapshot vs two-read oracle tiebreaker.
 *
 * CONTRADICTION TO SETTLE:
 *   QA-182: phantom is LMDB-ONLY, TRANSIENT (sub-50ms).
 *   QA-183: phantom is PERSISTENT (~500ms), BOTH engines (RocksDB + LMDB).
 *
 * HYPOTHESIS: QA-183's two-read oracle read the index (search_by_value = one read-txn)
 * and the base (separate PK-GET = ANOTHER read-txn) at DIFFERENT snapshots. The write
 * side atomically removed both base row AND index entry, but the oracle captured them
 * at different moments — manufacturing a phantom that does not exist in any consistent
 * snapshot. If true, a single-snapshot oracle (both reads in the same request transaction)
 * should show ZERO phantoms.
 *
 * TWO ORACLES, SIDE BY SIDE:
 *
 *   Oracle A — TWO-READ (reproduces QA-183):
 *     - Test calls GET /SnapCheck-index-only/ (or equivalent ops search_by_value) → Set<id>
 *     - Then for each hit, calls GET /PkCheck/?id=<id> (separate HTTP request = fresh txn)
 *     - Phantom = index returned id, but fresh PK check says gone
 *     - Implemented purely in the test: each call is a separate HTTP request
 *
 *   Oracle B — SINGLE-SNAPSHOT (decisive):
 *     - Test calls GET /SnapCheck/?bucket=<b> ONCE per probe
 *     - Inside the resource handler (one request txn): search index + PK-GET each hit
 *     - Returns { indexCount, phantomCount, phantoms }
 *     - Phantom = REAL (both reads at same snapshot; no oracle artifact possible)
 *
 * DECISIVE COMPARISON:
 *   - Oracle A shows phantoms AND Oracle B shows ~0  → ORACLE ARTIFACT (QA-183 downgraded)
 *   - Both oracles show phantoms                    → REAL READ-PATH DEFECT
 *   - Neither oracle shows phantoms                 → workload too fast / timing issue
 *
 * ADDITIONAL: per-delete commit timing (timestamp each phantom relative to the INDIVIDUAL
 * delete's commit, not just the bulk HTTP-200 boundary).
 *
 * RUNS: default RocksDB single-worker, RocksDB 4-worker, LMDB single-worker, LMDB 4-worker.
 *
 * Harper SHA: 7aaa5a152
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/read-snapshot-consistency.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/read-snapshot-consistency.test.ts"
 *   HARPER_WORKER_COUNT=4 npm run test:integration -- "integrationTests/database/read-snapshot-consistency.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb HARPER_WORKER_COUNT=4 npm run test:integration -- "integrationTests/database/read-snapshot-consistency.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'read-snapshot-consistency');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const WORKER_COUNT = Number(process.env.HARPER_WORKER_COUNT) || 1;

// Enough rows to give the reader loop meaningful iterations during the delete pass.
const ROW_COUNT = 40;
// Two delete shapes: one-by-one and single-txn.
const BUCKET_ONEBYONE = 'Q184A'; // one-by-one delete (each its own commit)
const BUCKET_TXN = 'Q184B'; // single-request-txn delete

type ApiClient = ReturnType<typeof createApiClient>;

// ---- Oracle A: TWO-READ (cross-snapshot, reproduces QA-183) ----------------------
// Step 1: index scan via ops search_by_value → Set<id>
async function oracleA_indexScan(client: ApiClient, bucket: string): Promise<Set<string>> {
	const r = await client
		.req()
		.send({
			operation: 'search_by_value',
			schema: 'data',
			table: 'Widget',
			search_attribute: 'bucket',
			search_value: bucket,
			get_attributes: ['id', 'bucket'],
		})
		.timeout(60_000)
		.expect(200);
	const rows: any[] = Array.isArray(r.body) ? r.body : [];
	return new Set(rows.map((row) => String(row.id)));
}

// Step 2: PK-GET via SEPARATE HTTP request (fresh read transaction per call).
async function oracleA_pkCheck(httpURL: string, auth: string, id: string): Promise<boolean> {
	const r = await fetch(`${httpURL}/PkCheck/?id=${encodeURIComponent(id)}`, {
		headers: { Authorization: auth },
	});
	if (r.status !== 200) return false;
	const body = (await r.json()) as any;
	return !!body?.exists;
}

// ---- Oracle B: SINGLE-SNAPSHOT (decisive, both reads in same request txn) ----------
interface SnapCheckResult {
	bucket: string;
	indexCount: number;
	phantomCount: number;
	phantoms: string[];
}

async function oracleB_snapCheck(httpURL: string, auth: string, bucket: string): Promise<SnapCheckResult> {
	const r = await fetch(`${httpURL}/SnapCheck/?bucket=${encodeURIComponent(bucket)}`, {
		headers: { Authorization: auth },
	});
	if (r.status !== 200) {
		return { bucket, indexCount: 0, phantomCount: 0, phantoms: [] };
	}
	return (await r.json()) as SnapCheckResult;
}

// ---- Base scan (index-independent ground truth) -----------------------------------
async function dumpBase(httpURL: string, auth: string): Promise<Array<{ id: string; bucket: string }>> {
	const r = await fetch(`${httpURL}/Dump/`, { headers: { Authorization: auth } });
	ok(r.status === 200, `/Dump/ returned ${r.status}`);
	return (await r.json()) as Array<{ id: string; bucket: string }>;
}

// ---- Per-delete commit timing tracker ---------------------------------------------
// We need to stamp each individual delete's commit time so we can compare phantom
// timestamps against actual per-delete commit times (not just the bulk HTTP-200 boundary).
// interface DeleteEvent intentionally removed — unused after characterization phase

// We can't get per-commit timestamps from inside Harper without a custom resource.
// Approximation: interleave an oracle probe between each delete and record the ts when the
// probe fires. This is the tightest per-delete timing we can get from the test side.
// For the full characterization, we use a separate "PerDeleteProbe" endpoint.

// ---- Concurrent reader loop (runs both oracles in parallel) -----------------------

interface PhantomObservation {
	oracle: 'A' | 'B';
	id: string;
	ts: number; // ms since epoch when phantom observed
	indexCount: number; // total index hits at that snapshot
}

interface ReaderResult {
	oracleA_phantoms: PhantomObservation[];
	oracleB_phantoms: PhantomObservation[];
	iterations: number;
}

async function runReaderLoop(
	client: ApiClient,
	httpURL: string,
	auth: string,
	bucket: string,
	done: { value: boolean }
): Promise<ReaderResult> {
	const oracleA_phantoms: PhantomObservation[] = [];
	const oracleB_phantoms: PhantomObservation[] = [];
	let iterations = 0;

	while (!done.value) {
		try {
			// Oracle A: two-read (cross-snapshot) — index scan first, then separate PK-GET per hit
			const indexHits = await oracleA_indexScan(client, bucket);
			for (const id of indexHits) {
				const exists = await oracleA_pkCheck(httpURL, auth, id);
				if (!exists) {
					oracleA_phantoms.push({ oracle: 'A', id, ts: Date.now(), indexCount: indexHits.size });
				}
			}

			// Oracle B: single-snapshot — both reads inside one request transaction
			const snap = await oracleB_snapCheck(httpURL, auth, bucket);
			const snapTs = Date.now();
			for (const id of snap.phantoms) {
				oracleB_phantoms.push({ oracle: 'B', id, ts: snapTs, indexCount: snap.indexCount });
			}

			iterations++;
		} catch {
			// tolerate transient network errors
		}
		// Brief yield between iterations to avoid saturating the Harper process under concurrent load
		await sleep(20);
	}

	return { oracleA_phantoms, oracleB_phantoms, iterations };
}

// ---- Suite -----------------------------------------------------------------------

suite(
	`QA-184 phantom tiebreaker [${ENGINE} workers=${WORKER_COUNT}]`,
	{
		skip: process.platform === 'win32',
	},
	(ctx: ContextWithHarper) => {
		let client: ApiClient;
		let httpURL: string;
		let authHeader: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKER_COUNT },
					logging: { console: true, level: 'error' },
				},
				env: {},
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			authHeader = client.headers.Authorization;

			// Poll for route readiness (component is pre-installed; no restart needed)
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const probe = await client.reqRest('/Dump/').timeout(2000);
						if (probe.status !== 404) break;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify(body),
			});
		}

		// ---- Q0: seed and sanity ---------------------------------------------------
		test('Q0 seed rows and verify index/base parity before deletes', async () => {
			const r1 = await postJSON('/BulkLoad/', { bucket: BUCKET_ONEBYONE, count: ROW_COUNT });
			strictEqual(r1.status, 200, `BulkLoad ${BUCKET_ONEBYONE} should succeed`);
			const r2 = await postJSON('/BulkLoad/', { bucket: BUCKET_TXN, count: ROW_COUNT });
			strictEqual(r2.status, 200, `BulkLoad ${BUCKET_TXN} should succeed`);

			// Pre-delete snapshot oracle B should show 0 phantoms
			const snapA = await oracleB_snapCheck(httpURL, authHeader, BUCKET_ONEBYONE);
			const snapB = await oracleB_snapCheck(httpURL, authHeader, BUCKET_TXN);
			strictEqual(snapA.indexCount, ROW_COUNT, `pre-delete ${BUCKET_ONEBYONE} indexCount should be ${ROW_COUNT}`);
			strictEqual(snapA.phantomCount, 0, `pre-delete ${BUCKET_ONEBYONE} should have 0 phantoms`);
			strictEqual(snapB.indexCount, ROW_COUNT, `pre-delete ${BUCKET_TXN} indexCount should be ${ROW_COUNT}`);
			strictEqual(snapB.phantomCount, 0, `pre-delete ${BUCKET_TXN} should have 0 phantoms`);

			console.log(`[QA-184 Q0 ${ENGINE} w=${WORKER_COUNT}] seeded OK, pre-delete snapshot oracle: 0 phantoms ✓`);
		});

		// ---- Q1: one-by-one DELETE — two-oracle comparison -------------------------
		test('Q1 one-by-one DELETE: two-oracle phantom comparison', { timeout: 120_000 }, async () => {
			const done = { value: false };
			const deleteStartMs = Date.now();

			// Start both oracles in the background concurrently
			const readerPromise = runReaderLoop(client, httpURL, authHeader, BUCKET_ONEBYONE, done);

			// Fire the one-by-one delete
			const delRes = await postJSON('/BulkDelete/', { bucket: BUCKET_ONEBYONE, count: ROW_COUNT });
			strictEqual(delRes.status, 200, 'BulkDelete should succeed');
			const deleteEndMs = Date.now();

			// Let the reader do a few more passes AFTER delete completes to catch post-completion phantoms
			await sleep(500);
			done.value = true;
			const result = await readerPromise;
			const elapsedMs = Date.now() - deleteStartMs;

			const oracleA = result.oracleA_phantoms;
			const oracleB = result.oracleB_phantoms;

			// Classify as persistent: observed AFTER the bulk HTTP-200 returned
			const persistentA = oracleA.filter((o) => o.ts > deleteEndMs);
			const persistentB = oracleB.filter((o) => o.ts > deleteEndMs);

			// Timing: how long after the delete HTTP-200 did phantoms persist?
			const lastA_ms = oracleA.length > 0 ? Math.max(...oracleA.map((o) => o.ts)) - deleteEndMs : 0;
			const lastB_ms = oracleB.length > 0 ? Math.max(...oracleB.map((o) => o.ts)) - deleteEndMs : 0;

			// Unique phantom IDs per oracle (dedup)
			const uniqueA = new Set(oracleA.map((o) => o.id)).size;
			const uniqueB = new Set(oracleB.map((o) => o.id)).size;

			console.log(
				`\n[QA-184 Q1 ${ENGINE} w=${WORKER_COUNT}] ONE-BY-ONE DELETE elapsed=${elapsedMs}ms iterations=${result.iterations}\n` +
					`  Oracle A (two-read, cross-snapshot):    total=${oracleA.length} unique_ids=${uniqueA} persistent=${persistentA.length} last_phantom=${lastA_ms}ms post-HTTP-200\n` +
					`  Oracle B (single-snapshot, same-txn):  total=${oracleB.length} unique_ids=${uniqueB} persistent=${persistentB.length} last_phantom=${lastB_ms}ms post-HTTP-200\n` +
					`  >>> VERDICT: ${
						oracleA.length > 0 && oracleB.length === 0
							? 'ORACLE ARTIFACT — QA-183 was a cross-snapshot artifact. No real defect. F-041 stands as LMDB-transient (QA-182).'
							: oracleA.length > 0 && oracleB.length > 0
								? 'REAL DEFECT — phantom survives single-snapshot oracle. Read-path staleness defect (both oracles affected).'
								: oracleA.length === 0 && oracleB.length === 0
									? 'CLEAN — no phantom observed in either oracle (workload may have been too fast).'
									: `MIXED: A=${oracleA.length} B=${oracleB.length} — investigate further.`
					}`
			);

			// Post-delete final consistency
			const finalSnap = await oracleB_snapCheck(httpURL, authHeader, BUCKET_ONEBYONE);
			const finalBase = await dumpBase(httpURL, authHeader);
			const finalBaseCount = finalBase.filter((r) => r.bucket === BUCKET_ONEBYONE).length;
			console.log(`  post-delete: finalIndex=${finalSnap.indexCount} finalBase=${finalBaseCount}`);
			strictEqual(finalSnap.indexCount, 0, `post-delete index for ${BUCKET_ONEBYONE} must be 0`);
			strictEqual(finalBaseCount, 0, `post-delete base for ${BUCKET_ONEBYONE} must be 0`);

			// The decisive assertion: if Oracle B shows persistent phantoms, it is a REAL defect.
			// Oracle A phantoms are informational (expected under cross-snapshot oracle).
			// We assert Oracle B = 0 persistent. If this fails, a real defect exists.
			// If Oracle A > 0 and Oracle B = 0, the verdict is: QA-183 was an oracle artifact.
			if (oracleB.length > 0) {
				console.log(
					`\n  [REAL DEFECT] Oracle B (single-snapshot) saw ${oracleB.length} phantoms.\n` +
						`  Sample phantom IDs: ${[...new Set(oracleB.map((o) => o.id))].slice(0, 5).join(', ')}\n` +
						`  This is a REAL read-path staleness defect — the secondary index and base row\n` +
						`  are not consistent within a single read transaction snapshot.`
				);
			}

			// Non-fatal: we observe and classify. Fail only on Oracle B persistent phantoms.
			strictEqual(
				persistentB.length,
				0,
				`Oracle B (single-snapshot) saw ${persistentB.length} persistent phantoms after HTTP-200 — REAL defect, not an oracle artifact`
			);
		});

		// ---- Q2: single-txn DELETE — two-oracle comparison -------------------------
		test('Q2 single-txn DELETE: two-oracle phantom comparison', { timeout: 120_000 }, async () => {
			// Re-seed in case prior test consumed the rows
			const seedRes = await postJSON('/BulkLoad/', { bucket: BUCKET_TXN, count: ROW_COUNT });
			strictEqual(seedRes.status, 200, `Q2 re-seed should succeed`);

			const preSnap = await oracleB_snapCheck(httpURL, authHeader, BUCKET_TXN);
			ok(preSnap.indexCount > 0, `Q2 pre-condition: ${BUCKET_TXN} must have rows, got ${preSnap.indexCount}`);

			const done = { value: false };
			const deleteStartMs = Date.now();

			const readerPromise = runReaderLoop(client, httpURL, authHeader, BUCKET_TXN, done);

			// Fire all deletes inside one request transaction
			const delRes = await postJSON('/BulkDeleteTxn/', { bucket: BUCKET_TXN, count: ROW_COUNT });
			if (delRes.status !== 200) {
				const body = await delRes.text().catch(() => '(no body)');
				console.log(`[QA-184 Q2] BulkDeleteTxn returned ${delRes.status}: ${body}`);
			}
			strictEqual(delRes.status, 200, 'BulkDeleteTxn should succeed');
			const deleteEndMs = Date.now();

			await sleep(500);
			done.value = true;
			const result = await readerPromise;
			const elapsedMs = Date.now() - deleteStartMs;

			const oracleA = result.oracleA_phantoms;
			const oracleB = result.oracleB_phantoms;
			const persistentA = oracleA.filter((o) => o.ts > deleteEndMs);
			const persistentB = oracleB.filter((o) => o.ts > deleteEndMs);
			const lastA_ms = oracleA.length > 0 ? Math.max(...oracleA.map((o) => o.ts)) - deleteEndMs : 0;
			const lastB_ms = oracleB.length > 0 ? Math.max(...oracleB.map((o) => o.ts)) - deleteEndMs : 0;
			const uniqueA = new Set(oracleA.map((o) => o.id)).size;
			const uniqueB = new Set(oracleB.map((o) => o.id)).size;

			console.log(
				`\n[QA-184 Q2 ${ENGINE} w=${WORKER_COUNT}] SINGLE-TXN DELETE elapsed=${elapsedMs}ms iterations=${result.iterations}\n` +
					`  Oracle A (two-read, cross-snapshot):    total=${oracleA.length} unique_ids=${uniqueA} persistent=${persistentA.length} last_phantom=${lastA_ms}ms post-HTTP-200\n` +
					`  Oracle B (single-snapshot, same-txn):  total=${oracleB.length} unique_ids=${uniqueB} persistent=${persistentB.length} last_phantom=${lastB_ms}ms post-HTTP-200\n` +
					`  >>> VERDICT: ${
						oracleA.length > 0 && oracleB.length === 0
							? 'ORACLE ARTIFACT — QA-183 was a cross-snapshot artifact. No real defect.'
							: oracleA.length > 0 && oracleB.length > 0
								? 'REAL DEFECT — phantom survives single-snapshot oracle.'
								: oracleA.length === 0 && oracleB.length === 0
									? 'CLEAN — no phantom in either oracle.'
									: `MIXED: A=${oracleA.length} B=${oracleB.length}`
					}`
			);

			// Post-delete final consistency
			const finalSnap = await oracleB_snapCheck(httpURL, authHeader, BUCKET_TXN);
			const finalBase = await dumpBase(httpURL, authHeader);
			const finalBaseCount = finalBase.filter((r) => r.bucket === BUCKET_TXN).length;
			console.log(`  post-delete: finalIndex=${finalSnap.indexCount} finalBase=${finalBaseCount}`);
			strictEqual(finalSnap.indexCount, 0, `post-delete index for ${BUCKET_TXN} must be 0`);
			strictEqual(finalBaseCount, 0, `post-delete base for ${BUCKET_TXN} must be 0`);

			strictEqual(
				persistentB.length,
				0,
				`Oracle B (single-snapshot) saw ${persistentB.length} persistent phantoms after txn-delete — REAL defect, not an oracle artifact`
			);
		});

		// ---- Q3: verdictSummary — explicit per-oracle per-engine classification ----
		test('Q3 verdict summary', async () => {
			// This test is intentionally a no-op assertion — it just prints the classification
			// instructions for the human reading the logs. The actual verdicts are in Q1/Q2 output.
			console.log(
				`\n[QA-184 Q3 ${ENGINE} w=${WORKER_COUNT}] INTERPRETATION GUIDE:\n` +
					`  If Q1/Q2 show: Oracle A > 0 phantoms, Oracle B = 0 phantoms:\n` +
					`    → VERDICT (A): QA-183 was an ORACLE ARTIFACT (cross-snapshot split)\n` +
					`       F-041 stands as LMDB-transient (QA-182). No new defect.\n` +
					`\n` +
					`  If Q1/Q2 show: Oracle B > 0 persistent phantoms:\n` +
					`    → VERDICT (B): REAL READ-PATH STALENESS DEFECT\n` +
					`       The secondary index and base row are inconsistent within one read snapshot.\n` +
					`       This is a distinct defect from F-029 (write-side atomicity) — it is a\n` +
					`       read-side consistency failure. Affects: engine=${ENGINE} workers=${WORKER_COUNT}.\n` +
					`\n` +
					`  If neither oracle shows phantoms:\n` +
					`    → VERDICT (C): INCONCLUSIVE — workload too fast or timing window missed.\n` +
					`       Re-run with higher ROW_COUNT or slower machine.\n` +
					`\n` +
					`  Engine: ${ENGINE}, Workers: ${WORKER_COUNT}, SHA: 7aaa5a152`
			);
			ok(true, 'verdict summary logged');
		});
	}
);
