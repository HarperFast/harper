/**
 * QA-186 — Secondary-index consistency under concurrent in-place UPDATE churn.
 *
 * QUESTION: Does `search([{attribute:'status', value:X}])` always return EXACTLY the rows
 * currently at value X after concurrent update churn on the indexed attribute?
 *
 * METHODOLOGY:
 *   - 50 rows, each with a `status` field that is @indexed.
 *   - Phase 1 (Q1): Sequential churn — each row updated 20 times, rotating
 *     pending→active→done→pending→...
 *   - Phase 2 (Q2): Concurrent churn — 4 concurrent workers each doing 30 random-row
 *     random-status updates (PUT via generated REST endpoint).
 *   - Phase 3 (Q3): Deterministic final pass — set each row to a known status (row-N → N%3),
 *     then run the single-snapshot oracle.
 *   - Oracle (GET /Reconcile/): SINGLE-SNAPSHOT — all index scans + PK-gets for all 3 status
 *     values happen within ONE request handler (same read transaction snapshot). No
 *     cross-snapshot artifact is possible.
 *   - Checks: stale (indexed under wrong value), double (appears in >1 index bucket), missing
 *     (actual status X but absent from index for X).
 *
 * RUNS: RocksDB (default) and LMDB (HARPER_STORAGE_ENGINE=lmdb).
 *
 * Harper SHA: 7aaa5a152
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/indexed-update-churn.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/indexed-update-churn.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'indexed-update-churn');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

const ROW_COUNT = 20;
const STATUS_VALUES = ['pending', 'active', 'done'] as const;
type StatusValue = (typeof STATUS_VALUES)[number];

interface ReconcileResult {
	stale: Array<{ id: string; indexedAs: string; actualStatus: string | null }>;
	double: Array<{ id: string; indexedUnder: string[] }>;
	missing: Array<{ id: string; actualStatus: string; appearsInIndex: boolean }>;
	stale_count: number;
	double_count: number;
	missing_count: number;
}

suite(
	`QA-186 indexed-update-churn [${ENGINE}]`,
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
						const probe = await client.reqRest('/Reconcile/').timeout(2000);
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

		function putRecord(id: string, status: StatusValue, label: string): Promise<Response> {
			return fetch(`${httpURL}/StatusRecord/${encodeURIComponent(id)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ id, status, label }),
			});
		}

		async function reconcile(): Promise<ReconcileResult> {
			const r = await fetch(`${httpURL}/Reconcile/?rowCount=${ROW_COUNT}`, {
				headers: { Authorization: authHeader },
			});
			if (r.status !== 200) {
				const body = await r.text().catch(() => '');
				throw new Error(`reconcile returned ${r.status}: ${body}`);
			}
			return r.json() as Promise<ReconcileResult>;
		}

		function logReconcileResult(label: string, result: ReconcileResult) {
			console.log(
				`[QA-186 ${label} ${ENGINE}] reconcile: stale=${result.stale_count} double=${result.double_count} missing=${result.missing_count}`
			);
			if (result.stale_count > 0) {
				console.log(`  stale sample: ${JSON.stringify(result.stale.slice(0, 5))}`);
			}
			if (result.double_count > 0) {
				console.log(`  double sample: ${JSON.stringify(result.double.slice(0, 5))}`);
			}
			if (result.missing_count > 0) {
				console.log(`  missing sample: ${JSON.stringify(result.missing.slice(0, 5))}`);
			}
		}

		// ---- Q0: Seed rows and verify pre-churn parity --------------------------------
		test('Q0 seed rows and verify pre-churn index parity', async () => {
			const r = await postJSON('/Seed/', { rowCount: ROW_COUNT });
			strictEqual(r.status, 200, `Seed should succeed (got ${r.status})`);
			console.log(`[QA-186 Q0 ${ENGINE}] seeded ${ROW_COUNT} rows`);

			// Pre-churn reconcile should show 0 issues
			const result = await reconcile();
			logReconcileResult('Q0', result);
			strictEqual(result.stale_count, 0, `pre-churn: stale_count should be 0`);
			strictEqual(result.double_count, 0, `pre-churn: double_count should be 0`);
			strictEqual(result.missing_count, 0, `pre-churn: missing_count should be 0`);
		});

		// ---- Q1: Sequential churn phase -----------------------------------------------
		test('Q1 sequential churn (8 iterations per row)', { timeout: 120_000 }, async () => {
			const r = await postJSON('/Churn/', { rowCount: ROW_COUNT, iterations: 8 });
			strictEqual(r.status, 200, `Churn should succeed (got ${r.status})`);
			console.log(`[QA-186 Q1 ${ENGINE}] sequential churn (20 iters x ${ROW_COUNT} rows) complete`);

			const result = await reconcile();
			logReconcileResult('Q1', result);
			strictEqual(result.stale_count, 0, `Q1 post-sequential: stale_count should be 0`);
			strictEqual(result.double_count, 0, `Q1 post-sequential: double_count should be 0`);
			strictEqual(result.missing_count, 0, `Q1 post-sequential: missing_count should be 0`);
		});

		// ---- Q2: Concurrent churn phase -----------------------------------------------
		test('Q2 concurrent churn (2 workers x 10 random updates)', { timeout: 120_000 }, async () => {
			// 2 concurrent workers, each doing 10 iterations of random-row random-status updates
			// via the generated REST PUT endpoint (StatusRecord/:id)
			const workers = Array.from({ length: 2 }, async (_, workerIdx) => {
				for (let iter = 0; iter < 10; iter++) {
					const rowIdx = Math.floor(Math.random() * ROW_COUNT);
					const id = `row-${rowIdx}`;
					const newStatus = STATUS_VALUES[Math.floor(Math.random() * STATUS_VALUES.length)];
					const r = await putRecord(id, newStatus, `w${workerIdx}-i${iter}`);
					// Harper returns 200 (update), 201 (create), or 204 (no-content update)
					if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
						const body = await r.text().catch(() => '');
						throw new Error(`concurrent PUT row-${rowIdx} returned ${r.status}: ${body}`);
					}
				}
			});
			await Promise.all(workers);
			console.log(`[QA-186 Q2 ${ENGINE}] concurrent churn (2 workers x 10 iters) complete`);

			const result = await reconcile();
			logReconcileResult('Q2', result);
			strictEqual(result.stale_count, 0, `Q2 post-concurrent: stale_count should be 0`);
			strictEqual(result.double_count, 0, `Q2 post-concurrent: double_count should be 0`);
			strictEqual(result.missing_count, 0, `Q2 post-concurrent: missing_count should be 0`);
		});

		// ---- Q3: Deterministic final pass + decisive single-snapshot oracle -----------
		test('Q3 deterministic final pass + single-snapshot oracle', { timeout: 120_000 }, async () => {
			// Set each row to deterministic status: row-N → N%3 → ['pending','active','done'][N%3]
			const r = await postJSON('/FinalPass/', { rowCount: ROW_COUNT });
			strictEqual(r.status, 200, `FinalPass should succeed (got ${r.status})`);
			console.log(`[QA-186 Q3 ${ENGINE}] deterministic final pass complete`);

			// SINGLE-SNAPSHOT ORACLE: the decisive reconcile call
			const result = await reconcile();

			// Expected ground truth:
			//   pending: rows where i%3==0 → 7 rows (row-0, row-3, ..., row-18)
			//   active:  rows where i%3==1 → 7 rows (row-1, row-4, ..., row-16)
			//   done:    rows where i%3==2 → 6 rows (row-2, row-5, ..., row-17)
			const expected = { pending: 0, active: 0, done: 0 };
			for (let i = 0; i < ROW_COUNT; i++) {
				(expected as Record<string, number>)[STATUS_VALUES[i % STATUS_VALUES.length]]++;
			}

			console.log(
				`\n[QA-186 Q3 ${ENGINE}] SINGLE-SNAPSHOT ORACLE RESULT:\n` +
					`  stale_count=${result.stale_count}  double_count=${result.double_count}  missing_count=${result.missing_count}\n` +
					`  expected distribution: pending=${expected.pending} active=${expected.active} done=${expected.done}\n` +
					`  >>> VERDICT: ${
						result.stale_count === 0 && result.double_count === 0 && result.missing_count === 0
							? 'EXPECTED — index fully consistent after churn. No secondary-index staleness defect.'
							: `DEFECT — index inconsistency detected on engine=${ENGINE}. ` +
								`stale=${result.stale_count} double=${result.double_count} missing=${result.missing_count}`
					}`
			);

			if (result.stale_count > 0) {
				console.log(`  ALL stale entries: ${JSON.stringify(result.stale)}`);
			}
			if (result.double_count > 0) {
				console.log(`  ALL double entries: ${JSON.stringify(result.double)}`);
			}
			if (result.missing_count > 0) {
				console.log(`  ALL missing entries: ${JSON.stringify(result.missing)}`);
			}

			strictEqual(result.stale_count, 0, `Q3 oracle: stale_count must be 0 — DEFECT if non-zero`);
			strictEqual(result.double_count, 0, `Q3 oracle: double_count must be 0 — DEFECT if non-zero`);
			strictEqual(result.missing_count, 0, `Q3 oracle: missing_count must be 0 — DEFECT if non-zero`);
		});
	}
);
