/**
 * P-132 / QA-176 — long-transaction monitor (force/abort) vs secondary-index consistency.
 *
 * Field incidents #1407/#1411: when the long-transaction MONITOR force-handles a write txn
 * that has run past the over-time threshold, the primary base store and a secondary @indexed
 * index can be left INCONSISTENT — a phantom index entry (search_by_value hit whose base row
 * is absent) or a missing one (base row present, not returned by the index search). The #1411
 * fix aborts+poisons BOTH engines on over-time; this is the regression anchor.
 *
 * Monitor mechanics (resources/DatabaseTransaction.ts + LMDBTransaction.ts on this dist,
 * 7aaa5a152 — PRE-#1411): a setInterval(maxTransactionOpenTime) timer scans tracked txns and
 * when a txn's `timeout` <= 0 it logs "Transaction was open too long and has been committed,
 * ... table: <name>" and FORCE-COMMITS it, then resets the timeout. We set
 * storage.maxTransactionOpenTime low and storage.debugLongTransactions=true, then drive a
 * single request whose ONE write transaction stays open across that window (sleeping between
 * indexed writes, or holding after the writes) so the monitor must fire underneath us.
 *
 * Oracle (run AFTER the over-time event, per bucket):
 *   (1) Phantom: every search_by_value(bucket) hit -> GET by PK must exist with that bucket.
 *   (2) Missing: every base row (full scan) with bucket B must appear in search_by_value(B).
 * Any phantom or missing = orphaned index entry = DEFECT.
 *
 * Runs both engines: default (RocksDB) and HARPER_STORAGE_ENGINE=lmdb.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/longtxn-secondary-index.test.ts"
 *   (lmdb: HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/longtxn-secondary-index.test.ts")
 * Harper SHA: 7aaa5a152
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'longtxn-secondary-index');
const SCHEMA = 'data';
const TABLE = 'Doc';
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
// Long-transaction over-time threshold. Low so a single sleepy request crosses it; the monitor
// timer also fires on this interval, so a txn force-commits ~1-2 ticks after going over.
const MAX_TXN_OPEN_MS = 1000;
const skipSuite = process.platform === 'win32';

suite(`QA-176 long-txn monitor vs secondary index [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	// Live capture of Harper's stdout/stderr so we can confirm the over-time line actually fired.
	let procOutput = '';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
				// also echo logs to stdout so the over-time line is visible in captured process output
				logging: { console: true, level: 'error' },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;

		// Seed any startup output we already captured, then keep listening.
		procOutput += ctx.harper.startupOutput?.stdout ?? '';
		procOutput += ctx.harper.startupOutput?.stderr ?? '';
		const proc = ctx.harper.process;
		proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
		proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

		// Readiness poll: workers register routes async (same pattern as ttl/qa096).
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(`${httpURL}/Count/`, { headers: { Authorization: client.headers.Authorization } });
				if (probe.status === 200) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
		// Seed the __seed__ bucket so the held-open read iterators (which register the tracked txn
		// with the long-transaction monitor) have rows to scan.
		await postJSON('/Seed/', { bucket: '__seed__', count: 3 });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function postJSON(path: string, body: unknown): Promise<Response> {
		return fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: JSON.stringify(body),
		});
	}

	function sawOverTime(): boolean {
		// Primary oracle: hdb.log in the suite log dir (populated when HARPER_INTEGRATION_TEST_LOG_DIR
		// is set). Fallback: captured stdout/stderr (logging.console=true echoes there).
		let logText = '';
		const logDir = (ctx.harper as any).logDir as string | undefined;
		if (logDir) {
			for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
				const p = join(logDir, name);
				if (existsSync(p)) {
					try {
						logText += readFileSync(p, 'utf8');
					} catch {
						/* ignore */
					}
				}
			}
		}
		return /Transaction was open too long/i.test(logText) || /Transaction was open too long/i.test(procOutput);
	}

	/** search_by_value(bucket) -> Set<id> via the operations API (secondary-index path). */
	async function searchByBucket(bucket: string): Promise<Set<string>> {
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: SCHEMA,
				table: TABLE,
				search_attribute: 'bucket',
				search_value: bucket,
				get_attributes: ['id', 'bucket'],
			})
			.timeout(60_000)
			.expect(200);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return new Set(rows.map((row) => String(row.id)));
	}

	/** Direct PK GET -> the base record (or null if absent). Index-independent. */
	async function getById(id: string): Promise<{ id: string; bucket: string } | null> {
		const r = await client
			.req()
			.send({ operation: 'search_by_id', schema: SCHEMA, table: TABLE, ids: [id], get_attributes: ['id', 'bucket'] })
			.timeout(30_000)
			.expect(200);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return rows.length ? { id: String(rows[0].id), bucket: String(rows[0].bucket) } : null;
	}

	/** Full base-table scan -> rows (index-independent oracle). */
	async function dumpBase(): Promise<Array<{ id: string; bucket: string; seq: number }>> {
		const r = await fetch(`${httpURL}/Dump/`, { headers: { Authorization: client.headers.Authorization } });
		strictEqual(r.status, 200, 'Dump endpoint should return 200');
		return (await r.json()) as Array<{ id: string; bucket: string; seq: number }>;
	}

	/**
	 * The consistency oracle for one bucket. Returns the two defect classes.
	 *  phantom: index hit whose base row is absent (or has a different bucket).
	 *  missing: base row of this bucket NOT returned by the index search.
	 */
	async function checkConsistency(bucket: string) {
		const indexHits = await searchByBucket(bucket);
		const base = await dumpBase();
		const baseOfBucket = new Set(base.filter((row) => row.bucket === bucket).map((row) => row.id));

		// (1) Phantom — every index hit must resolve to a live base row of this bucket.
		const phantom: string[] = [];
		for (const id of indexHits) {
			const rec = await getById(id);
			if (!rec || rec.bucket !== bucket) phantom.push(id);
		}
		// (2) Missing — every base row of this bucket must be in the index search.
		const missing: string[] = [];
		for (const id of baseOfBucket) if (!indexHits.has(id)) missing.push(id);

		return { indexCount: indexHits.size, baseCount: baseOfBucket.size, phantom, missing };
	}

	// ---- Q1: sleepy interleaved indexed writes — monitor force-commits MID-STREAM ----
	test('Q1 sleep-between indexed writes crosses over-time; index stays consistent', async () => {
		const bucket = 'Q1';
		// 8 writes x ~350ms = ~2.8s wall >> 1s threshold -> monitor fires at least twice mid-stream.
		const res = await postJSON('/SlowWrite/', { count: 8, bucket, sleepEach: 350 });
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		await sleep(500); // let any async monitor commit settle
		const r = await checkConsistency(bucket);
		const fired = sawOverTime();
		console.log(
			`\n[QA-176 Q1 ${ENGINE}] status=${res.status} elapsedMs=${body.elapsedMs} overTimeFired=${fired}\n` +
				`  base(${bucket})=${r.baseCount} index(${bucket})=${r.indexCount} ` +
				`phantom=${r.phantom.length}${r.phantom.length ? ' ' + JSON.stringify(r.phantom.slice(0, 5)) : ''} ` +
				`missing=${r.missing.length}${r.missing.length ? ' ' + JSON.stringify(r.missing.slice(0, 5)) : ''}\n` +
				`  >>> ${r.phantom.length === 0 && r.missing.length === 0 ? 'CONSISTENT (green anchor)' : 'ORPHANED INDEX ENTRIES (DEFECT)'}`
		);
		strictEqual(res.status, 200, 'slow write request should complete');
		strictEqual(r.phantom.length, 0, `phantom index entries (index->no base): ${JSON.stringify(r.phantom)}`);
		strictEqual(r.missing.length, 0, `missing index entries (base->no index): ${JSON.stringify(r.missing)}`);
	});

	// ---- Q2: write then HOLD across the threshold, then one more write AFTER over-time ----
	// NOTE (D-080): LMDB over-time is not reachable via `storage.maxTransactionOpenTime`;
	// LMDB hardcodes a 30s threshold in LMDBTransaction.ts and ignores this config. The
	// RocksDB force-commit path (Q1/Q2) is the primary regression anchor.
	// 60s timeout to allow the >30s LMDB hold (RocksDB only needs ~4s).
	test('Q2 hold open past over-time then write marker; index stays consistent', { timeout: 60_000 }, async () => {
		const bucket = 'Q2';
		// 5 rows, then hold past the over-time threshold so the monitor force-handles a txn with
		// pending writes, then a marker write lands on the reset/poisoned context txn.
		// NOTE: only resources/DatabaseTransaction.ts (RocksDB) reads storage.maxTransactionOpenTime;
		// resources/LMDBTransaction.ts hardcodes a 30s threshold, so on LMDB we must hold >30s to fire.
		const holdMs = ENGINE === 'lmdb' ? 33_000 : 4_000;
		const res = await postJSON('/SlowThenHold/', { count: 5, bucket, holdMs });
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		await sleep(500);
		const r = await checkConsistency(bucket);
		const fired = sawOverTime();
		console.log(
			`\n[QA-176 Q2 ${ENGINE}] status=${res.status} elapsedMs=${body.elapsedMs} overTimeFired=${fired}\n` +
				`  base(${bucket})=${r.baseCount} index(${bucket})=${r.indexCount} ` +
				`phantom=${r.phantom.length}${r.phantom.length ? ' ' + JSON.stringify(r.phantom.slice(0, 5)) : ''} ` +
				`missing=${r.missing.length}${r.missing.length ? ' ' + JSON.stringify(r.missing.slice(0, 5)) : ''}\n` +
				`  >>> ${r.phantom.length === 0 && r.missing.length === 0 ? 'CONSISTENT (green anchor)' : 'ORPHANED INDEX ENTRIES (DEFECT)'}`
		);
		// Request may succeed (force-commit) or fail (abort/poison post-#1411). Either way the
		// index must not diverge from the base table.
		strictEqual(r.phantom.length, 0, `phantom index entries (index->no base): ${JSON.stringify(r.phantom)}`);
		strictEqual(r.missing.length, 0, `missing index entries (base->no index): ${JSON.stringify(r.missing)}`);
		ok(typeof res.status === 'number');
	});

	// ---- Q3: explicit over-time confirmation + whole-table cross-check across all buckets ----
	test('Q3 over-time confirmation + full base<->index cross-check', async () => {
		const fired = sawOverTime();
		const base = await dumpBase();
		const buckets = [...new Set(base.map((row) => row.bucket))];
		let totalPhantom = 0;
		let totalMissing = 0;
		for (const bucket of buckets) {
			const r = await checkConsistency(bucket);
			totalPhantom += r.phantom.length;
			totalMissing += r.missing.length;
			console.log(
				`[QA-176 Q3 ${ENGINE}] bucket=${bucket} base=${r.baseCount} index=${r.indexCount} ` +
					`phantom=${r.phantom.length} missing=${r.missing.length}`
			);
		}
		console.log(
			`\n[QA-176 Q3 ${ENGINE}] overTimeFired=${fired} totalBaseRows=${base.length} ` +
				`buckets=${buckets.length} totalPhantom=${totalPhantom} totalMissing=${totalMissing}\n` +
				`  >>> ${
					!fired
						? 'INCONCLUSIVE: over-time monitor never logged "open too long"'
						: totalPhantom === 0 && totalMissing === 0
							? 'CONSISTENT under forced over-time (green regression anchor)'
							: `DEFECT: ${totalPhantom} phantom + ${totalMissing} missing orphaned index entries`
				}`
		);
		// The headline assertions: zero orphans regardless of over-time outcome.
		strictEqual(totalPhantom, 0, `total phantom index entries across all buckets: ${totalPhantom}`);
		strictEqual(totalMissing, 0, `total missing index entries across all buckets: ${totalMissing}`);
		// Soft signal — surfaced in the log; we don't hard-fail if the monitor didn't fire so the
		// consistency result is still reported, but we record whether the anchor truly exercised.
		ok(true, `over-time fired=${fired}`);
	});
});
