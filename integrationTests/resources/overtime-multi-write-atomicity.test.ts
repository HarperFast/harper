/** Pins harper#1407/PR#1411 over-time atomicity fix: N pre-writes + marker across maxTransactionOpenTime boundary must be all-or-nothing, never a silent partial drop. */
/**
 * QA-314 — TIE-BREAKER: atomicity of a single request that crosses maxTransactionOpenTime.
 *
 * Commit under test: 541a3d33d (main / v5.1.11).
 *
 * Background: QA-309 A2 saw that after a hold-then-write request, only the MARKER row
 * survived (the 5 earlier writes were absent).  That observation is consistent with
 * either:
 *   (a) ABORT+POISON (#1411 behavior) — whole txn killed, client gets 5xx, marker-only
 *       survivors come from a POST-abort write that escaped on a fresh implicit txn; OR
 *   (b) SILENT PARTIAL DROP — the earlier rows are force-committed then overwritten,
 *       or the abort killed pre-marker rows but the marker escaped, and the client sees
 *       2xx.  This is the dangerous case.
 *
 * This test disambiguates precisely by capturing:
 *   (a) the HTTP status code from the Overtime handler
 *   (b) the exact surviving rows in the base table immediately after
 *   (c) index↔base consistency (index phantom / missing)
 *   (d) whether the over-time log line appeared
 *
 * Expected clean outcomes:
 *   ABORT+ERROR   → 5xx  + 0 rows for that tag (all-or-nothing rollback)
 *   FORCE-COMMIT  → 2xx  + all N+1 rows (full commit, no drop)
 * Defect outcome:
 *   SILENT DROP   → 2xx  + <N+1 rows  (client told "ok" but writes silently lost)
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/resources/overtime-multi-write-atomicity.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/resources/overtime-multi-write-atomicity.test.ts"
 * Harper SHA: 541a3d33d
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'overtime-multi-write-atomicity');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

// Threshold low enough for the monitor to fire on a hold of HOLD_MS.
const MAX_TXN_OPEN_MS = 500;

// Test parameters: 5 "pre-hold" rows + 1 marker = 6 total.
const PRE_ROWS = 5;
const HOLD_MS = 3500; // 7× the 500ms threshold — monitor fires at least 5 times mid-hold.

const skipSuite = process.platform === 'win32';

suite(`QA-314 over-time atomicity tie-breaker [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let procOutput = '';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
				logging: { console: true, level: 'error' },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;

		procOutput += ctx.harper.startupOutput?.stdout ?? '';
		procOutput += ctx.harper.startupOutput?.stderr ?? '';
		const proc = ctx.harper.process;
		proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
		proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

		// Readiness poll — wait until ReadyProbe responds 200.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(`${httpURL}/ReadyProbe/`, {
					headers: { Authorization: client.headers.Authorization },
				});
				if (probe.status === 200) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}

		// Seed one row tagged __seed__ so the Overtime resource's iterator has something to open.
		await postJSON('/Baseline/', { tag: '__seed__', count: 0 });
		// The above call writes just the marker row (count=0 → loop body never runs, marker is seq=9999).
		// That gives the Overtime iterator 1 row to pull → registers the txn.
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

	/** Check log output for the long-transaction warning. */
	function sawOverTime(): boolean {
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

	/** Full base-table scan via DumpAtomic. Returns all rows. */
	async function dumpAll(): Promise<Array<{ id: string; tag: string; seq: number }>> {
		const r = await fetch(`${httpURL}/DumpAtomic/`, { headers: { Authorization: client.headers.Authorization } });
		strictEqual(r.status, 200, 'DumpAtomic should return 200');
		return (await r.json()) as Array<{ id: string; tag: string; seq: number }>;
	}

	function idsKey(rows: Array<{ id: string }>): string {
		return rows
			.map((r) => r.id)
			.sort()
			.join(',');
	}

	/**
	 * Poll DumpAtomic for `tag`'s rows until two consecutive reads agree (bounded tries), instead
	 * of a fixed settle sleep — under CI load, the async side effects of a force-commit/abort
	 * (index updates included) can still be landing when a fixed wait ends, so a single read
	 * right after it can observe a mid-flight state.
	 */
	async function waitForStableRows(
		tag: string,
		maxTries = 20,
		intervalMs = 100
	): Promise<Array<{ id: string; tag: string; seq: number }>> {
		let rows = (await dumpAll()).filter((r) => r.tag === tag);
		for (let i = 0; i < maxTries; i++) {
			await sleep(intervalMs);
			const next = (await dumpAll()).filter((r) => r.tag === tag);
			if (idsKey(next) === idsKey(rows)) return next;
			rows = next;
		}
		return rows;
	}

	/** search_by_value(tag) → Set<id> via secondary index. */
	async function searchByTag(tag: string): Promise<Set<string>> {
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Atomic',
				search_attribute: 'tag',
				search_value: tag,
				get_attributes: ['id', 'tag'],
			})
			.timeout(60_000)
			.expect(200);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return new Set(rows.map((row) => String(row.id)));
	}

	// ---- BASELINE (control): normal write under threshold commits all rows ----
	test('BASELINE: normal under-threshold write commits all N+1 rows with 200', async () => {
		const tag = 'baseline-ctrl';
		const res = await postJSON('/Baseline/', { tag, count: PRE_ROWS });
		strictEqual(res.status, 200, `Baseline should return 200 (got ${res.status})`);

		const all = await dumpAll();
		const rows = all.filter((r) => r.tag === tag);
		const expectedCount = PRE_ROWS + 1; // N rows + marker

		console.log(
			`\n[QA-314 BASELINE ${ENGINE}] status=${res.status} survived=${rows.length} expected=${expectedCount}\n` +
				`  ids=${JSON.stringify(rows.map((r) => r.id))}\n` +
				`  VERDICT: ${rows.length === expectedCount ? 'CLEAN — all rows committed' : `DEFECT — expected ${expectedCount} got ${rows.length}`}`
		);

		strictEqual(rows.length, expectedCount, `Baseline should commit all ${expectedCount} rows; got ${rows.length}`);
	});

	// ---- OVERTIME: write N, hold past threshold, write marker — tie-breaker ----
	test(
		'OVERTIME: write 5 rows, hold past threshold, write marker — atomicity tie-breaker',
		{ timeout: 60_000 },
		async () => {
			const tag = 'overtime-main';

			const t0 = Date.now();
			const res = await postJSON('/Overtime/', { tag, count: PRE_ROWS, holdMs: HOLD_MS });
			const elapsed = Date.now() - t0;

			// Wait for the row set to settle instead of a fixed sleep.
			const rows = await waitForStableRows(tag);
			const markerRow = rows.find((r) => r.id === `${tag}-marker`);
			const preRows = rows.filter((r) => r.id !== `${tag}-marker`);
			const fired = sawOverTime();

			// Index consistency check.
			const indexIds = await searchByTag(tag);
			const baseIds = new Set(rows.map((r) => r.id));
			const phantom = [...indexIds].filter((id) => !baseIds.has(id));
			const missing = [...baseIds].filter((id) => !indexIds.has(id));

			// Verdict
			const totalExpected = PRE_ROWS + 1;
			let verdict: string;
			if (!fired) {
				verdict = 'INCONCLUSIVE — over-time monitor never fired (increase holdMs or lower threshold)';
			} else if (res.status >= 200 && res.status < 300 && rows.length === totalExpected) {
				verdict = 'CLEAN (full-commit) — 2xx + all rows survived (force-commit path)';
			} else if (res.status >= 500 && rows.length === 0) {
				verdict = 'CLEAN (abort+error) — 5xx + 0 rows (abort+poison path, all-or-nothing ✓)';
			} else if (res.status >= 500 && rows.length === totalExpected) {
				verdict = 'CLEAN (force-commit+error) — 5xx + all rows (force-commit committed, then error)';
			} else if (res.status >= 200 && res.status < 300 && rows.length < totalExpected) {
				verdict = `DEFECT (silent partial drop) — 2xx + only ${rows.length}/${totalExpected} rows survived (atomicity VIOLATED)`;
			} else if (res.status >= 500 && rows.length > 0 && rows.length < totalExpected) {
				verdict = `DEFECT (partial abort) — 5xx + ${rows.length}/${totalExpected} rows survived (not all-or-nothing)`;
			} else {
				verdict = `UNKNOWN — status=${res.status} survived=${rows.length}/${totalExpected}`;
			}

			console.log(
				`\n[QA-314 OVERTIME ${ENGINE}] status=${res.status} elapsed=${elapsed}ms threshold=${MAX_TXN_OPEN_MS}ms hold=${HOLD_MS}ms\n` +
					`  overTimeFired=${fired}\n` +
					`  survivedTotal=${rows.length}/${totalExpected} preRows=${preRows.length}/${PRE_ROWS} markerPresent=${!!markerRow}\n` +
					`  indexPhantom=${phantom.length}${phantom.length ? ' ' + JSON.stringify(phantom.slice(0, 5)) : ''}\n` +
					`  indexMissing=${missing.length}${missing.length ? ' ' + JSON.stringify(missing.slice(0, 5)) : ''}\n` +
					`  survivingIds=${JSON.stringify(rows.map((r) => r.id))}\n` +
					`\n  *** VERDICT: ${verdict} ***\n`
			);

			// Hard assertions:
			// 1. The monitor must have fired (otherwise the test is inconclusive).
			ok(fired, 'Long-transaction monitor must have fired — if not, increase holdMs or lower threshold');

			// 2. No phantom or missing index entries regardless of outcome.
			strictEqual(phantom.length, 0, `Phantom index entries (index hit → no base row): ${JSON.stringify(phantom)}`);
			strictEqual(missing.length, 0, `Missing index entries (base row → not in index): ${JSON.stringify(missing)}`);

			// 3. Atomicity: the surviving-row count must be all-or-nothing (0 or totalExpected).
			//    Any intermediate count (e.g. just the marker, or just pre-rows) is a DEFECT.
			const isAllOrNothing = rows.length === 0 || rows.length === totalExpected;
			ok(
				isAllOrNothing,
				`ATOMICITY VIOLATION: ${rows.length}/${totalExpected} rows survived. ` +
					`Status=${res.status}. Partial survivors: ${JSON.stringify(rows.map((r) => r.id))}. ` +
					`This is a silent partial drop if status was 2xx, or a partial abort if status was 5xx.`
			);

			// 4. If the client got 2xx, all rows must have survived (not a silent partial).
			if (res.status >= 200 && res.status < 300) {
				strictEqual(
					rows.length,
					totalExpected,
					`2xx response but only ${rows.length}/${totalExpected} rows survived — SILENT PARTIAL DROP (DEFECT)`
				);
			}

			// 5. If the client got 5xx, zero rows should survive (clean abort).
			//    We also accept all-rows-survived+5xx (force-commit path), but flag it.
			if (res.status >= 500) {
				ok(
					rows.length === 0 || rows.length === totalExpected,
					`5xx response but ${rows.length}/${totalExpected} rows survived — PARTIAL ABORT (DEFECT)`
				);
			}
		}
	);

	// ---- OVERTIME RUN 2 (second iteration for reproducibility) ----
	test('OVERTIME run 2: repeat to confirm reproducibility', { timeout: 60_000 }, async () => {
		const tag = 'overtime-run2';

		const t0 = Date.now();
		const res = await postJSON('/Overtime/', { tag, count: PRE_ROWS, holdMs: HOLD_MS });
		const elapsed = Date.now() - t0;

		const rows = await waitForStableRows(tag);
		const fired = sawOverTime();
		const totalExpected = PRE_ROWS + 1;

		const indexIds = await searchByTag(tag);
		const baseIds = new Set(rows.map((r) => r.id));
		const phantom = [...indexIds].filter((id) => !baseIds.has(id));
		const missing = [...baseIds].filter((id) => !indexIds.has(id));

		let verdict: string;
		if (!fired) {
			verdict = 'INCONCLUSIVE';
		} else if (res.status >= 200 && res.status < 300 && rows.length === totalExpected) {
			verdict = 'CLEAN (full-commit)';
		} else if (res.status >= 500 && rows.length === 0) {
			verdict = 'CLEAN (abort+error)';
		} else if (res.status >= 500 && rows.length === totalExpected) {
			verdict = 'CLEAN (force-commit+error)';
		} else if (res.status >= 200 && res.status < 300 && rows.length < totalExpected) {
			verdict = `DEFECT (silent partial drop) — 2xx + ${rows.length}/${totalExpected}`;
		} else {
			verdict = `status=${res.status} survived=${rows.length}/${totalExpected}`;
		}

		console.log(
			`\n[QA-314 RUN2 ${ENGINE}] status=${res.status} elapsed=${elapsed}ms fired=${fired}\n` +
				`  survived=${rows.length}/${totalExpected} phantom=${phantom.length} missing=${missing.length}\n` +
				`  *** VERDICT: ${verdict} ***\n`
		);

		ok(fired, 'Monitor must have fired on run 2');
		strictEqual(phantom.length, 0, `Phantom entries run 2: ${JSON.stringify(phantom)}`);
		strictEqual(missing.length, 0, `Missing entries run 2: ${JSON.stringify(missing)}`);
		const isAllOrNothing = rows.length === 0 || rows.length === totalExpected;
		ok(isAllOrNothing, `Run 2 ATOMICITY VIOLATION: ${rows.length}/${totalExpected} rows. status=${res.status}`);
	});
});
