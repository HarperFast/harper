/**
 * QA-187 — Compound multi-attribute index queries (AND/OR/mixed/empty) correctness probe.
 *
 * QUESTION: Are compound multi-attribute index queries correct and COMPLETE — exactly the
 * rows matching the predicate, no missing/extra/duplicate — including under concurrent churn?
 * Does the query planner pick a sound plan (index-intersect vs scan-and-filter)?
 *
 * TABLE: Item { id, status @indexed, region @indexed, score (NOT indexed) }
 * ROW DISTRIBUTION (60 rows):
 *   status: active (i%3=0), inactive (i%3=1), pending (i%3=2)
 *   region: west (i%4=0), east (i%4=1), north (i%4=2), south (i%4=3)
 *   score:  i * 2  (0..118)
 *
 * CASES (after FinalPass deterministic reset):
 *   AND  : status='active' AND region='west'           → rows where i%3=0 AND i%4=0 (→ i%12=0)
 *   OR   : status='active' OR region='west'            → rows where i%3=0 OR i%4=0
 *   MIXED: status='active' (indexed) AND score >= 50   → active rows with i*2 >= 50 (i >= 25, i%3=0)
 *   EMPTY: status='ghost' AND region='moon'            → 0 rows
 *
 * METHODOLOGY (SINGLE-SNAPSHOT ORACLE):
 *   The CompoundOracle endpoint runs ALL queries (index search + base full-scan + predicate
 *   application) within ONE request handler (= one request transaction snapshot). This
 *   eliminates any cross-request read artifact. Any diff is a real defect.
 *
 * CHURN:
 *   POST /Churn/ rotates both status and region simultaneously for all rows.
 *   A FinalPass deterministic reset is applied before the decisive oracle run, so
 *   churn tests verify no index corruption survives under concurrent write pressure.
 *
 * RUNS: RocksDB (default) and LMDB (HARPER_STORAGE_ENGINE=lmdb).
 *
 * Harper SHA: 7aaa5a152
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/compound-index-conditions.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/compound-index-conditions.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'compound-index-conditions');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

const ROW_COUNT = 60;

// Ground-truth predicates for the final deterministic state:
//   status = STATUS_VALUES[i % 3]   → 0=active, 1=inactive, 2=pending
//   region = REGION_VALUES[i % 4]   → 0=west,   1=east,     2=north,  3=south
//   score  = i * 2
function computeExpected(rowCount: number) {
	type Row = { i: number; status: string; region: string; score: number };
	const STATUS = ['active', 'inactive', 'pending'];
	const REGION = ['west', 'east', 'north', 'south'];
	const rows: Row[] = [];
	for (let i = 0; i < rowCount; i++) {
		rows.push({ i, status: STATUS[i % 3], region: REGION[i % 4], score: i * 2 });
	}
	const andIds = rows.filter((r) => r.status === 'active' && r.region === 'west').map((r) => `item-${r.i}`);
	const orIds = rows.filter((r) => r.status === 'active' || r.region === 'west').map((r) => `item-${r.i}`);
	const mixIds = rows.filter((r) => r.status === 'active' && r.score >= 50).map((r) => `item-${r.i}`);
	const empIds = rows.filter((r) => r.status === 'ghost' && r.region === 'moon').map((r) => `item-${r.i}`);
	return {
		AND: new Set(andIds),
		OR: new Set(orIds),
		MIXED: new Set(mixIds),
		EMPTY: new Set(empIds),
	};
}

// Shape returned by CompoundOracle
interface CaseResult {
	description: string;
	queryCount: number;
	baseCount: number;
	extra: string[];
	missing: string[];
	extra_count: number;
	missing_count: number;
	duplicate_count?: number;
	raw_union_dup_count?: number;
	ok: boolean;
}
interface OracleResult {
	rowCount: number;
	allRowCount: number;
	cases: {
		AND: CaseResult;
		OR: CaseResult;
		MIXED: CaseResult;
		EMPTY: CaseResult;
	};
}

suite(
	`QA-187 compound-index [${ENGINE}]`,
	{
		skip: process.platform === 'win32',
	},
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let authHeader: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					logging: { console: true, level: 'error' },
				},
				env: {},
			});
			const client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			authHeader = client.headers.Authorization;

			// Poll for route readiness (component is pre-installed; no restart needed)
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const probe = await client.reqRest('/CompoundOracle/').timeout(2000);
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

		async function runOracle(): Promise<OracleResult> {
			const r = await fetch(`${httpURL}/CompoundOracle/?rowCount=${ROW_COUNT}`, {
				headers: { Authorization: authHeader },
			});
			if (r.status !== 200) {
				const body = await r.text().catch(() => '');
				throw new Error(`CompoundOracle returned ${r.status}: ${body}`);
			}
			return r.json() as Promise<OracleResult>;
		}

		function logOracleResult(label: string, result: OracleResult) {
			const s = result.cases;
			console.log(
				`\n[QA-187 ${label} ${ENGINE}] SINGLE-SNAPSHOT ORACLE — ${result.allRowCount} rows total\n` +
					`  AND  : query=${s.AND.queryCount}  base=${s.AND.baseCount}  extra=${s.AND.extra_count}  missing=${s.AND.missing_count}  → ${s.AND.ok ? 'OK' : 'DEFECT'}\n` +
					`  OR   : query=${s.OR.queryCount}  base=${s.OR.baseCount}  extra=${s.OR.extra_count}  missing=${s.OR.missing_count}  raw_union_dups=${s.OR.raw_union_dup_count ?? 0}  → ${s.OR.ok ? 'OK' : 'DEFECT'}\n` +
					`  MIXED: query=${s.MIXED.queryCount}  base=${s.MIXED.baseCount}  extra=${s.MIXED.extra_count}  missing=${s.MIXED.missing_count}  → ${s.MIXED.ok ? 'OK' : 'DEFECT'}\n` +
					`  EMPTY: query=${s.EMPTY.queryCount}  base=${s.EMPTY.baseCount}  extra=${s.EMPTY.extra_count}  missing=${s.EMPTY.missing_count}  → ${s.EMPTY.ok ? 'OK' : 'DEFECT'}`
			);
			for (const [name, c] of Object.entries(s) as [string, CaseResult][]) {
				if (c.extra_count > 0)
					console.log(`  [${name}] EXTRA (false positives): ${JSON.stringify(c.extra.slice(0, 10))}`);
				if (c.missing_count > 0)
					console.log(`  [${name}] MISSING (false negatives): ${JSON.stringify(c.missing.slice(0, 10))}`);
			}
		}

		// ---- Q0: Seed rows and verify pre-churn parity --------------------------------
		test('Q0 seed rows and verify pre-churn compound-index parity', async () => {
			const r = await postJSON('/Seed/', { rowCount: ROW_COUNT });
			strictEqual(r.status, 200, `Seed should succeed (got ${r.status})`);
			console.log(`[QA-187 Q0 ${ENGINE}] seeded ${ROW_COUNT} rows`);

			const result = await runOracle();
			logOracleResult('Q0 (pre-churn)', result);

			strictEqual(result.allRowCount, ROW_COUNT, `allRowCount should equal ${ROW_COUNT}`);
			strictEqual(result.cases.AND.extra_count, 0, 'Q0 AND: no extra rows');
			strictEqual(result.cases.AND.missing_count, 0, 'Q0 AND: no missing rows');
			strictEqual(result.cases.OR.extra_count, 0, 'Q0 OR: no extra rows');
			strictEqual(result.cases.OR.missing_count, 0, 'Q0 OR: no missing rows');
			strictEqual(result.cases.MIXED.extra_count, 0, 'Q0 MIXED: no extra rows');
			strictEqual(result.cases.MIXED.missing_count, 0, 'Q0 MIXED: no missing rows');
			strictEqual(result.cases.EMPTY.queryCount, 0, 'Q0 EMPTY: must return [] (no ghost/moon rows)');
			strictEqual(result.cases.EMPTY.extra_count, 0, 'Q0 EMPTY: no extra rows');
			strictEqual(result.cases.EMPTY.missing_count, 0, 'Q0 EMPTY: no missing rows');
		});

		// ---- Q1: Verify expected counts after seed (deterministic cross-check) --------
		test('Q1 verify expected counts match ground-truth predicates', async () => {
			const expected = computeExpected(ROW_COUNT);
			const result = await runOracle();

			// AND: i%12=0 → items 0,12,24,36,48 = 5 rows
			console.log(
				`[QA-187 Q1 ${ENGINE}] expected AND=${expected.AND.size} OR=${expected.OR.size} MIXED=${expected.MIXED.size} EMPTY=${expected.EMPTY.size}`
			);

			strictEqual(result.cases.AND.baseCount, expected.AND.size, `AND baseCount should be ${expected.AND.size}`);
			strictEqual(result.cases.AND.queryCount, expected.AND.size, `AND queryCount should be ${expected.AND.size}`);
			strictEqual(result.cases.OR.baseCount, expected.OR.size, `OR baseCount should be ${expected.OR.size}`);
			strictEqual(result.cases.OR.queryCount, expected.OR.size, `OR queryCount should be ${expected.OR.size}`);
			strictEqual(
				result.cases.MIXED.baseCount,
				expected.MIXED.size,
				`MIXED baseCount should be ${expected.MIXED.size}`
			);
			strictEqual(
				result.cases.MIXED.queryCount,
				expected.MIXED.size,
				`MIXED queryCount should be ${expected.MIXED.size}`
			);
			strictEqual(result.cases.EMPTY.baseCount, 0, 'EMPTY baseCount should be 0 (no ghost/moon rows)');
			strictEqual(result.cases.EMPTY.queryCount, 0, 'EMPTY queryCount should be 0');
		});

		// ---- Q2: Sequential churn + reconcile ----------------------------------------
		test('Q2 sequential churn + compound-index reconcile', { timeout: 120_000 }, async () => {
			const r = await postJSON('/Churn/', { rowCount: ROW_COUNT, iterations: 6 });
			strictEqual(r.status, 200, `Churn should succeed (got ${r.status})`);
			console.log(`[QA-187 Q2 ${ENGINE}] sequential churn (6 iters x ${ROW_COUNT} rows) complete`);

			const result = await runOracle();
			logOracleResult('Q2 (post-sequential-churn)', result);

			strictEqual(result.cases.AND.extra_count, 0, 'Q2 AND: no extra rows after churn');
			strictEqual(result.cases.AND.missing_count, 0, 'Q2 AND: no missing rows after churn');
			strictEqual(result.cases.OR.extra_count, 0, 'Q2 OR: no extra rows after churn');
			strictEqual(result.cases.OR.missing_count, 0, 'Q2 OR: no missing rows after churn');
			strictEqual(result.cases.MIXED.extra_count, 0, 'Q2 MIXED: no extra rows after churn');
			strictEqual(result.cases.MIXED.missing_count, 0, 'Q2 MIXED: no missing rows after churn');
			strictEqual(result.cases.EMPTY.queryCount, 0, 'Q2 EMPTY: must still return [] after churn');
		});

		// ---- Q3: Concurrent churn (4 parallel workers via HTTP PUT) -------------------
		test(
			'Q3 concurrent churn (2 workers × 10 random updates) + compound-index reconcile',
			{ timeout: 120_000 },
			async () => {
				const STATUS = ['active', 'inactive', 'pending'];
				const REGION = ['west', 'east', 'north', 'south'];

				const workers = Array.from({ length: 2 }, async () => {
					for (let iter = 0; iter < 10; iter++) {
						const i = Math.floor(Math.random() * ROW_COUNT);
						const status = STATUS[Math.floor(Math.random() * STATUS.length)];
						const region = REGION[Math.floor(Math.random() * REGION.length)];
						const score = Math.floor(Math.random() * 120);
						const rr = await fetch(`${httpURL}/Item/${encodeURIComponent(`item-${i}`)}`, {
							method: 'PUT',
							headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
							body: JSON.stringify({ id: `item-${i}`, status, region, score }),
						});
						if (rr.status !== 200 && rr.status !== 201 && rr.status !== 204) {
							throw new Error(`concurrent PUT item-${i} returned ${rr.status}`);
						}
					}
				});
				await Promise.all(workers);
				console.log(`[QA-187 Q3 ${ENGINE}] concurrent churn (2 workers × 10 iters) complete`);

				const result = await runOracle();
				logOracleResult('Q3 (post-concurrent-churn)', result);

				strictEqual(result.cases.AND.extra_count, 0, 'Q3 AND: no extra rows after concurrent churn');
				strictEqual(result.cases.AND.missing_count, 0, 'Q3 AND: no missing rows after concurrent churn');
				strictEqual(result.cases.OR.extra_count, 0, 'Q3 OR: no extra rows after concurrent churn');
				strictEqual(result.cases.OR.missing_count, 0, 'Q3 OR: no missing rows after concurrent churn');
				// MIXED: after random score updates we can't assert counts, just that query == base within snapshot
				strictEqual(result.cases.MIXED.extra_count, 0, 'Q3 MIXED: no extra rows after concurrent churn');
				strictEqual(result.cases.MIXED.missing_count, 0, 'Q3 MIXED: no missing rows after concurrent churn');
				strictEqual(result.cases.EMPTY.queryCount, 0, 'Q3 EMPTY: must still return [] (no ghost/moon rows inserted)');
			}
		);

		// ---- Q4: Deterministic FinalPass + decisive oracle ----------------------------
		test('Q4 deterministic FinalPass + decisive single-snapshot oracle', { timeout: 120_000 }, async () => {
			const fp = await postJSON('/FinalPass/', { rowCount: ROW_COUNT });
			strictEqual(fp.status, 200, `FinalPass should succeed (got ${fp.status})`);
			console.log(`[QA-187 Q4 ${ENGINE}] deterministic final pass complete`);

			const result = await runOracle();
			const expected = computeExpected(ROW_COUNT);
			logOracleResult('Q4 DECISIVE (post-FinalPass)', result);

			console.log(
				`\n[QA-187 Q4 ${ENGINE}] DECISIVE VERDICT:\n` +
					`  AND  : expected=${expected.AND.size}  query=${result.cases.AND.queryCount}  extra=${result.cases.AND.extra_count}  missing=${result.cases.AND.missing_count}  → ${result.cases.AND.ok ? 'EXPECTED (correct)' : 'DEFECT'}\n` +
					`  OR   : expected=${expected.OR.size}  query=${result.cases.OR.queryCount}  extra=${result.cases.OR.extra_count}  missing=${result.cases.OR.missing_count}  → ${result.cases.OR.ok ? 'EXPECTED (correct)' : 'DEFECT'}\n` +
					`  MIXED: expected=${expected.MIXED.size}  query=${result.cases.MIXED.queryCount}  extra=${result.cases.MIXED.extra_count}  missing=${result.cases.MIXED.missing_count}  → ${result.cases.MIXED.ok ? 'EXPECTED (correct)' : 'DEFECT'}\n` +
					`  EMPTY: expected=0  query=${result.cases.EMPTY.queryCount}  extra=${result.cases.EMPTY.extra_count}  missing=${result.cases.EMPTY.missing_count}  → ${result.cases.EMPTY.ok ? 'EXPECTED (correct)' : 'DEFECT'}\n` +
					`  Engine: ${ENGINE}  SHA: 7aaa5a152`
			);

			// AND
			strictEqual(
				result.cases.AND.queryCount,
				expected.AND.size,
				`AND queryCount must be ${expected.AND.size} — DEFECT if not`
			);
			strictEqual(result.cases.AND.extra_count, 0, 'AND extra must be 0 — DEFECT if not');
			strictEqual(result.cases.AND.missing_count, 0, 'AND missing must be 0 — DEFECT if not');

			// OR
			strictEqual(
				result.cases.OR.queryCount,
				expected.OR.size,
				`OR queryCount must be ${expected.OR.size} — DEFECT if not`
			);
			strictEqual(result.cases.OR.extra_count, 0, 'OR extra must be 0 — DEFECT if not');
			strictEqual(result.cases.OR.missing_count, 0, 'OR missing must be 0 — DEFECT if not');
			// OR raw-union duplicates: rows that are BOTH active AND west appear in both index scans.
			// The oracle deduplicates before diffing, but we note the count.
			const orRawDups = result.cases.OR.raw_union_dup_count ?? 0;
			ok(orRawDups >= 0, 'OR raw_union_dup_count should be non-negative (informational)');
			console.log(
				`  [OR] raw_union_dup_count (rows in both buckets, expected) = ${orRawDups} (expected = ${expected.AND.size})`
			);

			// MIXED
			strictEqual(
				result.cases.MIXED.queryCount,
				expected.MIXED.size,
				`MIXED queryCount must be ${expected.MIXED.size} — DEFECT if not`
			);
			strictEqual(result.cases.MIXED.extra_count, 0, 'MIXED extra must be 0 — DEFECT if not');
			strictEqual(result.cases.MIXED.missing_count, 0, 'MIXED missing must be 0 — DEFECT if not');

			// EMPTY
			strictEqual(result.cases.EMPTY.queryCount, 0, 'EMPTY must return exactly 0 rows — DEFECT if not');
			strictEqual(result.cases.EMPTY.extra_count, 0, 'EMPTY must have 0 extra rows — DEFECT if not');
			strictEqual(result.cases.EMPTY.missing_count, 0, 'EMPTY must have 0 missing rows (ground truth is also 0)');
		});
	}
);
