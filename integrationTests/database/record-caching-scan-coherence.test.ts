/**
 * Cached point-read vs uncached scan/query coherence (harper #410 record caching).
 *
 * PrimaryRocksDatabase fronts POINT reads (`getEntry`, GET /Table/{id}) with a per-worker
 * WeakLRUCache. The getRange/scan path (filtered query GET /Table/?field=..) reads the store
 * directly and never consults or populates that cache. In a genuine multi-worker instance each
 * worker has its OWN cache, so a write's cache-invalidation must propagate to every worker — if
 * it doesn't, a point-GET landing on a worker that missed the invalidation returns a value that
 * disagrees with the (always-direct) scan path for the same committed record. Requests use a
 * fresh connection each (no keep-alive) so they spray across the worker pool.
 *
 *   update: after a PUT changes `name` (indexed) + `counter`, concurrent PK point-GETs (cached)
 *           and filtered queries by the NEW name (uncached scan) must agree, and a query on the
 *           OLD indexed value must not still surface the record (stale index ghost).
 *   delete: after a DELETE, point-GET (must 404) and filtered query (must exclude the id) must
 *           agree, in both orders (point-GET-first and query-first).
 *
 * Skipped on LMDB (PrimaryRocksDatabase is RocksDB-only).
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { WORKER_COUNT, assertMultiWorker } from './recordCachingWorkers.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-caching-coherence');
const SKIP = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

interface Rec {
	id: string;
	name: string;
	counter: number;
}

// Fresh connection per request so concurrent reads spray across the worker pool
// (keep-alive would pin a client to a single worker and hide cross-worker divergence).
function headers(auth: string): Record<string, string> {
	return { 'Content-Type': 'application/json', 'Authorization': auth, 'Connection': 'close' };
}

suite(
	'record-caching point-read vs scan coherence [rocksdb] multi-worker',
	{ skip: SKIP || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let authHeader: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { logging: { console: true, level: 'error' }, threads: { count: WORKER_COUNT } },
			});
			const client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			authHeader = client.headers.Authorization;

			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					const r = await fetch(`${httpURL}/CacheRecord/probe`, { headers: headers(authHeader) });
					if (r.status < 500) break;
				} catch {
					/* not ready yet */
				}
				await sleep(200);
			}
			await assertMultiWorker(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		async function putRecord(id: string, name: string, counter: number): Promise<void> {
			const r = await fetch(`${httpURL}/CacheRecord/${encodeURIComponent(id)}`, {
				method: 'PUT',
				headers: headers(authHeader),
				body: JSON.stringify({ id, name, counter }),
			});
			if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
				throw new Error(`PUT ${id} returned ${r.status}`);
			}
		}

		async function deleteRecord(id: string): Promise<void> {
			const r = await fetch(`${httpURL}/CacheRecord/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers: headers(authHeader),
			});
			if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
				throw new Error(`DELETE ${id} returned ${r.status}`);
			}
		}

		// Point-GET: exercises getEntry (cached path).
		async function getRecord(id: string): Promise<Rec | null> {
			const r = await fetch(`${httpURL}/CacheRecord/${encodeURIComponent(id)}`, { headers: headers(authHeader) });
			if (r.status === 404) return null;
			if (r.status !== 200) throw new Error(`GET ${id} returned ${r.status}`);
			return r.json() as Promise<Rec>;
		}

		// Filtered query by indexed `name`: exercises getRange/scan path (uncached, direct store read).
		async function queryByName(name: string): Promise<Rec[]> {
			const r = await fetch(`${httpURL}/CacheRecord/?name=${encodeURIComponent(name)}`, {
				headers: headers(authHeader),
			});
			if (r.status !== 200) throw new Error(`query name=${name} returned ${r.status}`);
			const body = await r.json();
			if (!Array.isArray(body)) throw new Error(`query name=${name} returned non-array body: ${JSON.stringify(body)}`);
			return body as Rec[];
		}

		test(
			'update: point-GET vs scan-by-new-name agree; scan-by-old-name has no ghost',
			{ timeout: 60_000 },
			async () => {
				const N = 24;
				const WARM_READS_PER_ID = 12; // spray point-GETs pre-update to populate every worker's cache
				const BURST_PER_ID = 8; // concurrent point-GETs sprayed immediately after each update's ack

				await Promise.all(Array.from({ length: N }, (_, i) => putRecord(`div-${i}`, `orig-${i}`, i)));

				// Warm the point-read cache across all workers for every id.
				await Promise.all(
					Array.from({ length: N }, (_, i) => {
						const id = `div-${i}`;
						return Promise.all(Array.from({ length: WARM_READS_PER_ID }, () => getRecord(id)));
					})
				);
				// Sanity: warm reads saw the original values.
				const warmSample = await getRecord('div-0');
				strictEqual(warmSample?.name, 'orig-0', 'warm-phase point-GET should see seeded value');

				const errors: string[] = [];
				const staleCachedPoint: string[] = [];
				const scanMisses: string[] = [];
				const scanStaleValues: string[] = [];
				const staleIndexGhosts: string[] = [];

				async function burstCheck(id: string, oldName: string, newName: string, newCounter: number): Promise<void> {
					const pointReads = Array.from({ length: BURST_PER_ID }, () => getRecord(id));
					const [pointResults, queryNew, queryOld] = await Promise.all([
						Promise.all(pointReads),
						queryByName(newName),
						queryByName(oldName),
					]);

					for (const rec of pointResults) {
						if (!rec) {
							errors.push(`id=${id}: point-GET unexpectedly 404 right after update`);
							continue;
						}
						if (rec.name !== newName || rec.counter !== newCounter) {
							staleCachedPoint.push(
								`id=${id}: point-GET returned STALE name=${rec.name} counter=${rec.counter} (expected name=${newName} counter=${newCounter})`
							);
						}
					}

					const foundNew = queryNew.find((r) => r.id === id);
					if (!foundNew) {
						scanMisses.push(`id=${id}: scan query by NEW name=${newName} did not include the record`);
					} else if (foundNew.counter !== newCounter) {
						scanStaleValues.push(
							`id=${id}: scan query by NEW name=${newName} returned counter=${foundNew.counter} (expected ${newCounter})`
						);
					}

					if (queryOld.some((r) => r.id === id)) {
						staleIndexGhosts.push(`id=${id}: scan query by OLD name=${oldName} still includes the record post-update`);
					}
				}

				// Pipeline: PUT (awaited=ack'd), then fire the comparison burst WITHOUT awaiting it,
				// so bursts from different ids overlap and spray load across all workers.
				const bursts: Promise<void>[] = [];
				for (let i = 0; i < N; i++) {
					const id = `div-${i}`;
					const oldName = `orig-${i}`;
					const newName = `upd-${i}`;
					const newCounter = 1000 + i;
					await putRecord(id, newName, newCounter); // write acknowledged (200/201/204) before comparing
					bursts.push(burstCheck(id, oldName, newName, newCounter));
				}
				await Promise.all(bursts);

				strictEqual(errors.length, 0, `unexpected errors:\n${errors.join('\n')}`);
				strictEqual(
					staleCachedPoint.length,
					0,
					`cached point-GET disagreed with committed value (stale cache not invalidated cross-worker):\n${staleCachedPoint.join('\n')}`
				);
				strictEqual(
					scanMisses.length,
					0,
					`scan query missed a committed update (index lag):\n${scanMisses.join('\n')}`
				);
				strictEqual(scanStaleValues.length, 0, `scan query returned stale value:\n${scanStaleValues.join('\n')}`);
				strictEqual(
					staleIndexGhosts.length,
					0,
					`query on OLD indexed value still matched after update (stale index entry):\n${staleIndexGhosts.join('\n')}`
				);
			}
		);

		test('delete: point-GET 404 and scan-exclusion agree in both orderings', { timeout: 60_000 }, async () => {
			const N = 16; // half order A (point-first), half order B (query-first)
			const WARM_READS_PER_ID = 12;
			const BURST_PER_ID = 8;

			await Promise.all(Array.from({ length: N }, (_, i) => putRecord(`del-${i}`, `delname-${i}`, i)));
			await Promise.all(
				Array.from({ length: N }, (_, i) => {
					const id = `del-${i}`;
					return Promise.all(Array.from({ length: WARM_READS_PER_ID }, () => getRecord(id)));
				})
			);

			const ghostPointReads: string[] = []; // point-GET still returns a body (not 404) post-delete
			const ghostScanHits: string[] = []; // scan query still includes the id post-delete

			async function deleteAndCheck(id: string, name: string, orderPointFirst: boolean): Promise<void> {
				await deleteRecord(id); // ack'd before we compare

				const pointBurst = (): Promise<(Rec | null)[]> =>
					Promise.all(Array.from({ length: BURST_PER_ID }, () => getRecord(id)));
				const scanBurst = (): Promise<Rec[]> => queryByName(name);

				let pointResults: (Rec | null)[];
				let scanResults: Rec[];
				if (orderPointFirst) {
					pointResults = await pointBurst();
					scanResults = await scanBurst();
				} else {
					scanResults = await scanBurst();
					pointResults = await pointBurst();
				}
				// Also fire one fully-concurrent burst mixing both, to spray across workers.
				const [concurrentPoints, concurrentScan] = await Promise.all([pointBurst(), scanBurst()]);

				const order = orderPointFirst ? 'point-first' : 'query-first';
				for (const rec of [...pointResults, ...concurrentPoints]) {
					if (rec !== null) {
						ghostPointReads.push(
							`id=${id} order=${order}: point-GET returned a body post-delete: ${JSON.stringify(rec)}`
						);
					}
				}
				for (const rec of [...scanResults, ...concurrentScan]) {
					if (rec.id === id) {
						ghostScanHits.push(`id=${id} order=${order}: scan query still includes id post-delete`);
					}
				}
			}

			const work: Promise<void>[] = [];
			for (let i = 0; i < N; i++) {
				const id = `del-${i}`;
				const name = `delname-${i}`;
				work.push(deleteAndCheck(id, name, i % 2 === 0));
			}
			await Promise.all(work);

			strictEqual(
				ghostPointReads.length,
				0,
				`point-GET returned a ghost record after delete (stale cache):\n${ghostPointReads.join('\n')}`
			);
			strictEqual(
				ghostScanHits.length,
				0,
				`scan query still surfaced a deleted record (stale index entry):\n${ghostScanHits.join('\n')}`
			);
		});

		test('rapid churn: repeated update+compare on a hot id set (60 rounds)', { timeout: 60_000 }, async () => {
			const HOT_IDS = 6;
			const ROUNDS = 60;
			const BURST_PER_ID = 10;

			await Promise.all(Array.from({ length: HOT_IDS }, (_, i) => putRecord(`hot-${i}`, `hot-orig-${i}`, 0)));
			// Warm every worker's cache before churn starts.
			await Promise.all(
				Array.from({ length: HOT_IDS }, (_, i) => Promise.all(Array.from({ length: 16 }, () => getRecord(`hot-${i}`))))
			);

			const staleCachedPoint: string[] = [];
			const scanMisses: string[] = [];
			const staleIndexGhosts: string[] = [];

			for (let round = 0; round < ROUNDS; round++) {
				const roundWork: Promise<void>[] = [];
				for (let i = 0; i < HOT_IDS; i++) {
					const id = `hot-${i}`;
					const oldName = round === 0 ? `hot-orig-${i}` : `hot-v${round - 1}-${i}`;
					const newName = `hot-v${round}-${i}`;
					const newCounter = round * 1000 + i;
					await putRecord(id, newName, newCounter);
					roundWork.push(
						(async () => {
							const pointReads = Array.from({ length: BURST_PER_ID }, () => getRecord(id));
							const [pointResults, queryNew, queryOld] = await Promise.all([
								Promise.all(pointReads),
								queryByName(newName),
								queryByName(oldName),
							]);
							for (const rec of pointResults) {
								if (!rec || rec.name !== newName || rec.counter !== newCounter) {
									staleCachedPoint.push(
										`round=${round} id=${id}: point-GET returned ${rec ? `name=${rec.name} counter=${rec.counter}` : '404'} (expected name=${newName} counter=${newCounter})`
									);
								}
							}
							if (!queryNew.some((r) => r.id === id)) {
								scanMisses.push(`round=${round} id=${id}: scan by NEW name=${newName} missed the record`);
							}
							if (queryOld.some((r) => r.id === id)) {
								staleIndexGhosts.push(`round=${round} id=${id}: scan by OLD name=${oldName} still matched`);
							}
						})()
					);
				}
				await Promise.all(roundWork);
			}

			strictEqual(
				staleCachedPoint.length,
				0,
				`cached point-GET diverged from committed value under rapid churn (${staleCachedPoint.length}/${ROUNDS * HOT_IDS * BURST_PER_ID} reads):\n${staleCachedPoint.slice(0, 10).join('\n')}`
			);
			strictEqual(
				scanMisses.length,
				0,
				`scan missed a committed update under churn:\n${scanMisses.slice(0, 10).join('\n')}`
			);
			strictEqual(
				staleIndexGhosts.length,
				0,
				`stale index ghost under rapid churn:\n${staleIndexGhosts.slice(0, 10).join('\n')}`
			);
		});
	}
);
