/**
 * Pure-append unique-PK durability on both storage engines.
 *
 * Regression anchor for append data-loss: every insert with a guaranteed-unique
 * PK (crypto.randomUUID() generated server-side) must be durable after concurrent
 * writes settle. Tests both 1-worker and 4-worker configurations.
 *
 * Hard gate (test A): unique-PK inserts — durable count must equal N_INSERTS (120).
 *   Any shortfall is a real insert data-loss defect.
 *
 * Control (test B): colliding-PK inserts — N_INSERTS all map into a 5-slot pool.
 *   Expect last-write-wins shortfall: durable ≤ pool size (5). Informational only.
 *
 * Both RocksDB (default) and LMDB engines are tested via HARPER_STORAGE_ENGINE=lmdb.
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'append-only-unique-pk-durability');
const skipSuite = process.platform === 'win32';
const ENGINE = process.env.HARPER_STORAGE_ENGINE || 'rocksdb(default)';

// 120 inserts — chosen to match a realistic concurrent double-entry ledger workload
// (2 entries × 60 transfers).
const N_INSERTS = 120;
const CONCURRENCY = 20;

const SCENARIOS: Array<{ workers: number }> = [{ workers: 1 }, { workers: 4 }];

for (const { workers } of SCENARIOS) {
	suite(
		`append-only unique-PK durability [workers=${workers} engine=${ENGINE}]`,
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
			 * Fire n posts in batches of batchSize at the given endpoint.
			 * Returns ok200/non200 tallies and returned ids (for unique-PK sanity check).
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
							postJSON(endpoint, { seq: base + j, payload: `append-${base + j}` }, 15_000)
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
										console.log(`  [append-durability] non-200 from ${endpoint}: status=${r.status}`);
									}
								})
								.catch((err) => {
									non200++;
									console.log(`  [append-durability] fetch error from ${endpoint}: ${(err as Error)?.message}`);
								})
						)
					);
					void results;
				}

				return { ok200, non200, ids };
			}

			// ---- A: unique-PK (hard gate) ────────────────────────────────────────
			// Every insert uses randomUUID() server-side → all N rows must be durable.
			test('A: unique-PK — all N inserts must be durable (no append data-loss)', { timeout: 120_000 }, async () => {
				await resetTable();

				const beforeCount = await countRows();
				strictEqual(beforeCount, 0, 'Table must be empty after reset');

				const { ok200, non200, ids } = await runInserts('/AppendUnique/', N_INSERTS, CONCURRENCY);

				const uniqueIds = new Set(ids);
				const dupeIds = ids.length - uniqueIds.size;

				await sleep(200);

				const durable = await countRows();

				const allLanded = durable === N_INSERTS;
				const classification = allLanded
					? 'CLEAN — all unique-PK inserts durable'
					: `DEFECT — ${N_INSERTS - durable} rows MISSING (insert data-loss on ${ENGINE})`;

				console.log(
					`\n[append-durability A workers=${workers} engine=${ENGINE}]\n` +
						`  inserts fired=${N_INSERTS} ok200=${ok200} non200=${non200}\n` +
						`  unique ids returned=${ids.length} duplicate ids (server collision)=${dupeIds}\n` +
						`  durable count=${durable} expected=${N_INSERTS}\n` +
						`  dropped=${N_INSERTS - durable}\n` +
						`  *** ${classification} ***\n`
				);

				strictEqual(
					durable,
					N_INSERTS,
					`APPEND DATA-LOSS on ${ENGINE} workers=${workers}: durable=${durable} of ${N_INSERTS} — ${N_INSERTS - durable} rows dropped`
				);

				// Sanity: server must not generate duplicate UUIDs (masks count math)
				strictEqual(dupeIds, 0, `Server generated ${dupeIds} duplicate UUIDs — test validity concern`);
			});

			// ---- B: colliding-PK (control, informational) ────────────────────────
			// All inserts map to a 5-slot pool → LWW → durable ≤ pool size (expected).
			test(
				'B: colliding-PK control — characterize last-write-wins shortfall (informational)',
				{ timeout: 120_000 },
				async () => {
					await resetTable();

					const beforeCount = await countRows();
					strictEqual(beforeCount, 0, 'Table must be empty after reset');

					const { ok200, non200 } = await runInserts('/AppendCollide/', N_INSERTS, CONCURRENCY);

					await sleep(200);

					const durable = await countRows();

					const POOL_SIZE = 5;
					const classification =
						durable <= POOL_SIZE
							? `EXPECTED — last-write-wins: ${durable} of ${N_INSERTS} (pool size=${POOL_SIZE})`
							: `ANOMALY — ${durable} rows persisted but pool is ${POOL_SIZE}; more than pool size survived`;

					console.log(
						`\n[append-durability B workers=${workers} engine=${ENGINE}]\n` +
							`  inserts fired=${N_INSERTS} ok200=${ok200} non200=${non200}\n` +
							`  durable count=${durable} (pool size=${POOL_SIZE} expected ≤ ${POOL_SIZE})\n` +
							`  *** ${classification} ***\n`
					);

					ok(durable >= 1, `No rows durable at all — something is badly wrong`);
					ok(durable <= POOL_SIZE, `Colliding-PK: durable=${durable} exceeds pool size=${POOL_SIZE} — unexpected`);
				}
			);
		}
	);
}
