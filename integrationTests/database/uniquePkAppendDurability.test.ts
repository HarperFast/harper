/**
 * QA-323 — Unique-PK append durability under concurrent multi-worker insert.
 *
 * Promoted from exploratory QA (qa-explorer campaign) after passing GREEN on both
 * RocksDB and LMDB engines (workers=1 and workers=4).
 *
 * Background:
 *   QA-322 B (cross-table double-entry ledger) observed LMDB delivering only 30–46 of 120
 *   expected Ledger rows under 4-worker concurrency. The Ledger PKs in QA-322 were
 *   `${txnId}:debit` / `${txnId}:credit` — unique per transfer — so last-write-wins is NOT
 *   the obvious explanation. This test isolates the pure insert path to determine:
 *
 *   (A) UNIQUE-PK variant (hard gate): N concurrent inserts, each using crypto.randomUUID()
 *       server-side. Every insert MUST land. If count < N → REAL insert data-loss defect.
 *
 *   (B) COLLIDING-PK variant (control): N concurrent inserts all mapping into a tiny fixed
 *       pool of IDs. Last-write-wins → count ≤ pool size ≤ N. Expected shortfall.
 *
 * Matrix: {engine: rocksdb, lmdb} × {workers: 1, 4} × {variant: unique-pk, colliding-pk}
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/uniquePkAppendDurability.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/uniquePkAppendDurability.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'unique-pk-append-durability');
const skipSuite = process.platform === 'win32';
const ENGINE = process.env.HARPER_STORAGE_ENGINE || 'rocksdb(default)';

// 120 inserts matches QA-322's expected Ledger row count (2 entries × 60 transfers).
const N_INSERTS = 120;
// Concurrency: how many inserts fire simultaneously per batch.
const CONCURRENCY = 20;

const SCENARIOS: Array<{ workers: number }> = [{ workers: 1 }, { workers: 4 }];

for (const { workers } of SCENARIOS) {
	suite(
		`QA-323 pure-append unique-PK durability [workers=${workers} engine=${ENGINE}]`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			let client: ReturnType<typeof createApiClient>;
			let httpURL: string;

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: { threads: { count: workers } },
					env: {},
				});
				client = createApiClient(ctx.harper);
				httpURL = ctx.harper.httpURL;

				// Readiness poll: wait until /Count/ responds 200.
				const deadline = Date.now() + 60_000;
				while (Date.now() < deadline) {
					try {
						const probe = await fetchJSON('/Count/');
						if (probe.status === 200) break;
					} catch {
						/* not ready */
					}
					await sleep(250);
				}
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			function fetchJSON(path: string, timeoutMs = 10_000): Promise<Response> {
				const ac = new AbortController();
				const t = setTimeout(() => ac.abort(), timeoutMs);
				return fetch(`${httpURL}${path}`, {
					headers: { Authorization: client.headers.Authorization },
					signal: ac.signal,
				}).finally(() => clearTimeout(t));
			}

			function postJSON(path: string, body: unknown, timeoutMs = 15_000): Promise<Response> {
				const ac = new AbortController();
				const t = setTimeout(() => ac.abort(), timeoutMs);
				return fetch(`${httpURL}${path}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
					body: JSON.stringify(body),
					signal: ac.signal,
				}).finally(() => clearTimeout(t));
			}

			async function resetTable(): Promise<void> {
				const r = await postJSON('/Reset/', {});
				ok(r.status === 200, `Reset failed: ${r.status}`);
			}

			async function countRows(): Promise<number> {
				const r = await fetchJSON('/Count/');
				strictEqual(r.status, 200, 'Count must return 200');
				const body = (await r.json()) as { count: number };
				return body.count;
			}

			/**
			 * Fire N_INSERTS posts in batches of CONCURRENCY at the given endpoint.
			 * Returns { ok200, non200 } tallies and the list of returned ids (for unique-PK check).
			 */
			async function runInserts(
				endpoint: string,
				n: number,
				batchSize: number
			): Promise<{ ok200: number; non200: number; ids: string[] }> {
				let ok200 = 0;
				let non200 = 0;
				const ids: string[] = [];

				for (let base = 0; base < n; base += batchSize) {
					const batch = Math.min(batchSize, n - base);
					const results = await Promise.all(
						Array.from({ length: batch }, (_, j) =>
							postJSON(endpoint, { seq: base + j, payload: `qa323-${base + j}` }, 15_000)
								.then(async (r) => {
									if (r.status === 200) {
										ok200++;
										try {
											const body = (await r.json()) as { id?: string };
											if (body.id) ids.push(body.id);
										} catch {
											/* ignore parse error */
										}
									} else {
										non200++;
										console.log(`  [QA-323] non-200 response from ${endpoint}: status=${r.status}`);
									}
								})
								.catch((err) => {
									non200++;
									console.log(`  [QA-323] fetch error from ${endpoint}: ${err?.message}`);
								})
						)
					);
					void results;
				}

				return { ok200, non200, ids };
			}

			// ---- TEST A: UNIQUE-PK variant (hard gate) ----
			// Each insert uses randomUUID() server-side. All N rows must be durable.
			test('A: unique-PK — all N inserts must be durable (no append data-loss)', { timeout: 120_000 }, async () => {
				await resetTable();

				const before = await countRows();
				strictEqual(before, 0, 'Table must be empty after reset');

				const { ok200, non200, ids } = await runInserts('/AppendUnique/', N_INSERTS, CONCURRENCY);

				// Confirm PK uniqueness from returned ids (server generates UUID per call).
				const uniqueIds = new Set(ids);
				const dupeIds = ids.length - uniqueIds.size;

				// Wait a brief moment for any async commit stragglers.
				await sleep(200);

				const durable = await countRows();

				const allLanded = durable === N_INSERTS;
				const classification = allLanded
					? 'CLEAN — all unique-PK inserts durable'
					: `DEFECT — ${N_INSERTS - durable} rows MISSING (insert data-loss on ${ENGINE})`;

				console.log(
					`\n[QA-323 A workers=${workers} engine=${ENGINE}]\n` +
						`  inserts fired=${N_INSERTS} ok200=${ok200} non200=${non200}\n` +
						`  unique ids returned=${ids.length} duplicate ids (server collision)=${dupeIds}\n` +
						`  durable count=${durable} expected=${N_INSERTS}\n` +
						`  dropped=${N_INSERTS - durable}\n` +
						`  *** ${classification} ***\n`
				);

				// Hard gate: every unique-PK insert must be durable.
				strictEqual(
					durable,
					N_INSERTS,
					`APPEND DATA-LOSS on ${ENGINE} workers=${workers}: durable=${durable} of ${N_INSERTS} — ${N_INSERTS - durable} rows dropped`
				);

				// Sanity: server must not have generated duplicate UUIDs (would mask count math).
				strictEqual(dupeIds, 0, `Server generated ${dupeIds} duplicate UUIDs — test validity concern`);
			});

			// ---- TEST B: COLLIDING-PK variant (control / informational) ----
			// Each insert maps into a 5-slot pool → last-write-wins → count <= pool size.
			// Expected shortfall is CORRECT behavior (no hard gate on count).
			test(
				'B: colliding-PK control — characterize last-write-wins shortfall (informational)',
				{ timeout: 120_000 },
				async () => {
					await resetTable();

					const before = await countRows();
					strictEqual(before, 0, 'Table must be empty after reset');

					const { ok200, non200 } = await runInserts('/AppendCollide/', N_INSERTS, CONCURRENCY);

					await sleep(200);

					const durable = await countRows();

					// Pool size is 5 (see resources.js COLLIDE_POOL). Durable count should be ≤ pool size.
					const POOL_SIZE = 5;
					const classification =
						durable <= POOL_SIZE
							? `EXPECTED — last-write-wins: ${durable} of ${N_INSERTS} (pool size=${POOL_SIZE})`
							: `ANOMALY — ${durable} rows persisted but pool is ${POOL_SIZE}; more than pool size survived (unexpected)`;

					console.log(
						`\n[QA-323 B workers=${workers} engine=${ENGINE}]\n` +
							`  inserts fired=${N_INSERTS} ok200=${ok200} non200=${non200}\n` +
							`  durable count=${durable} (pool size=${POOL_SIZE} expected ≤ ${POOL_SIZE})\n` +
							`  *** ${classification} ***\n`
					);

					// Only sanity gate: durable must be at least 1 (something committed) and at most pool size.
					ok(durable >= 1, `No rows durable at all — something is badly wrong`);
					ok(
						durable <= POOL_SIZE,
						`Colliding-PK variant: durable=${durable} exceeds pool size=${POOL_SIZE} — unexpected`
					);
				}
			);
		}
	);
}
