/**
 * TTL eviction vs cross-worker record-cache ghost reads (harper #410 record caching).
 *
 * resources/Table.ts's TTL cleanup scan (only the last worker runs it) evicts expired rows
 * via the ASYNC store.remove() path, not putSync()/removeSync() — the only methods
 * PrimaryRocksDatabase overrides to clear its LOCAL WeakLRUCache. If that async remove
 * doesn't bump the shared VerificationTable (VT) the same way, another worker's point-GET
 * cache could keep serving the pre-eviction row after the TTL deadline (a sticky cross-worker
 * ghost) — distinct from the update/delete coherence already covered by
 * record-caching-cross-worker.test.ts.
 *
 * Protocol: seed rows, warm every worker's cache with fresh-connection point-GETs, let the
 * short TTL (`expiration: 2`) lapse, then poll faster than the cleanup interval until eviction
 * is confirmed (a 404 seen) for every id. After a quiescent settle past TTL+sweep, a final
 * hammer must see zero 200s (sticky ghost), and the scan path (`bucket` is @indexed) must
 * agree. A control record whose TTL is continuously refreshed must stay live the whole time,
 * then converge cleanly to 404 once refreshing stops.
 *
 * Skipped on LMDB (PrimaryRocksDatabase is RocksDB-only).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { WORKER_COUNT, assertMultiWorker, mapBounded } from './recordCachingWorkers.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-caching-ttl-eviction');
const TABLE = 'CacheGhost';
const SKIP = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
// Cap concurrent fresh-connection requests so cache-warming/poll fan-outs don't exhaust
// sockets on constrained CI. Small per-id bursts stay concurrent (the cross-worker check).
const CONCURRENCY = 24;

const TTL_MS = 2000; // matches expiration: 2 in schema.graphql
const CLEANUP_INTERVAL_MS = TTL_MS / 4; // Table.ts default: (expirationMs+evictionMs)/4 = 500ms

const N = 12; // rows for the main ghost hunt (trimmed from 24 -- still warms every worker many times over)
const WARM_READS_PER_ID = 6; // spray point-GETs pre-expiry to populate every worker's cache
const POLL_MS = 120; // well under CLEANUP_INTERVAL_MS
const SAFETY_MARGIN_MS = 60; // only trust a 404 as "provably past deadline", not a race
const BURST_PER_ID = 4; // concurrent point-GETs per id per poll tick (>= WORKER_COUNT)
const FINAL_BURST_PER_ID = 6; // hard post-quiescent sticky check (>= WORKER_COUNT)
const QUIESCENT_BUFFER_MS = 2500; // extra settle time before the final hammer

interface Rec {
	id: string;
	name: string;
	bucket: string;
	seq: number;
}

// Force a fresh connection per request (no keep-alive) so concurrent requests spray across
// the SO_REUSEPORT worker pool instead of pinning to one worker.
function headers(auth: string): Record<string, string> {
	return { 'Content-Type': 'application/json', 'Authorization': auth, 'Connection': 'close' };
}

async function putRecord(
	base: string,
	auth: string,
	id: string,
	name: string,
	bucket: string,
	seq: number
): Promise<number> {
	const r = await fetch(`${base}/${TABLE}/${encodeURIComponent(id)}`, {
		method: 'PUT',
		headers: headers(auth),
		body: JSON.stringify({ id, name, bucket, seq }),
	});
	if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
		throw new Error(`PUT ${id} returned ${r.status}: ${await r.text()}`);
	}
	await r.text().catch(() => undefined);
	return Date.now(); // ack time -> TTL deadline anchor
}

async function getRecord(base: string, auth: string, id: string): Promise<{ status: number; body: Rec | null }> {
	const r = await fetch(`${base}/${TABLE}/${encodeURIComponent(id)}`, { headers: headers(auth) });
	if (r.status === 404) {
		await r.text().catch(() => undefined);
		return { status: 404, body: null };
	}
	if (r.status !== 200) throw new Error(`GET ${id} returned ${r.status}: ${await r.text()}`);
	return { status: 200, body: (await r.json()) as Rec };
}

async function scanBucket(base: string, auth: string, bucket: string): Promise<Set<string>> {
	const r = await fetch(`${base}/${TABLE}/?bucket=${encodeURIComponent(bucket)}`, { headers: headers(auth) });
	if (r.status !== 200) throw new Error(`scan bucket=${bucket} returned ${r.status}: ${await r.text()}`);
	const rows = (await r.json()) as Rec[];
	if (!Array.isArray(rows)) throw new Error(`scan bucket=${bucket} returned non-array body`);
	return new Set(rows.map((row) => row.id));
}

async function waitForTable(base: string, auth: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${base}/${TABLE}/probe`, { headers: headers(auth) });
			if (r.status < 500) {
				await r.text().catch(() => undefined);
				return;
			}
		} catch {
			/* not ready yet */
		}
		await sleep(200);
	}
	throw new Error(`${TABLE} table never became ready`);
}

suite(
	'record-caching TTL-eviction cross-worker ghost [rocksdb] multi-worker',
	{ skip: SKIP || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let base: string;
		let auth: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { logging: { console: true, level: 'error' }, threads: { count: WORKER_COUNT } },
			});
			const client = createApiClient(ctx.harper);
			base = ctx.harper.httpURL;
			auth = client.headers.Authorization;
			await waitForTable(base, auth);
			await assertMultiWorker(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test(
			'main: warm cross-worker cache, let TTL evict, hammer for a sticky cross-worker ghost',
			{ timeout: 240_000 },
			async () => {
				const ids = Array.from({ length: N }, (_, i) => `g${i}`);
				const expiresAtById = new Map<string, number>();

				// Phase 1: seed.
				const ackTimes = await mapBounded(ids, CONCURRENCY, (id, i) =>
					putRecord(base, auth, id, `name-${i}`, 'probe', i)
				);
				ids.forEach((id, i) => expiresAtById.set(id, ackTimes[i] + TTL_MS));

				// Phase 2: warm every worker's point-read cache.
				await mapBounded(ids, CONCURRENCY, (id) =>
					Promise.all(Array.from({ length: WARM_READS_PER_ID }, () => getRecord(base, auth, id)))
				);
				// Sanity: warm reads must have seen the live records (timing didn't already race TTL).
				const warmSample = await getRecord(base, auth, ids[0]);
				strictEqual(warmSample.status, 200, 'warm-phase point-GET should still see the seeded (unexpired) record');

				const lastExpiresAt = Math.max(...expiresAtById.values());
				const pollDeadline = lastExpiresAt + CLEANUP_INTERVAL_MS * 4 + 2000;

				// Per-id state.
				const evictionConfirmedAtTick = new Map<string, number>(); // first tick where ANY point-GET saw 404
				const evictionConfirmedAtMs = new Map<string, number>();
				const ghostObservations: Array<{ id: string; tick: number; msSinceConfirm: number }> = [];
				const scanDivergences: Array<{ tick: number; detail: string }> = [];

				let tick = 0;
				while (Date.now() < pollDeadline) {
					tick++;
					const now = Date.now();

					const [burstResults, scanLive] = await Promise.all([
						mapBounded(ids, CONCURRENCY, async (id) => {
							const reads = await Promise.all(Array.from({ length: BURST_PER_ID }, () => getRecord(base, auth, id)));
							return { id, reads };
						}),
						scanBucket(base, auth, 'probe'),
					]);

					for (const { id, reads } of burstResults) {
						const any404 = reads.some((r) => r.status === 404);
						const any200 = reads.some((r) => r.status === 200);

						if (any404 && !evictionConfirmedAtTick.has(id)) {
							evictionConfirmedAtTick.set(id, tick);
							evictionConfirmedAtMs.set(id, now);
						}

						const confirmedAtMs = evictionConfirmedAtMs.get(id);
						if (confirmedAtMs !== undefined && any200) {
							ghostObservations.push({ id, tick, msSinceConfirm: now - confirmedAtMs });
						}

						// Direct same-instant disagreement across the burst is the strongest signal:
						// different workers answered differently for the identical id at the identical tick.
						if (any404 && any200) {
							ghostObservations.push({ id, tick, msSinceConfirm: 0 });
						}

						// Scan-vs-point divergence: only meaningful once we know the record is provably
						// expired (past its deadline + safety margin), to rule out a benign "not expired yet".
						const expiresAt = expiresAtById.get(id)!;
						const provablyExpired = now - expiresAt > SAFETY_MARGIN_MS;
						const scanHasIt = scanLive.has(id);
						if (provablyExpired && confirmedAtMs !== undefined) {
							if (scanHasIt && !any200) {
								scanDivergences.push({
									tick,
									detail: `id=${id}: scan(bucket=probe) still includes it but ALL point-GETs 404`,
								});
							} else if (!scanHasIt && any200) {
								scanDivergences.push({
									tick,
									detail: `id=${id}: scan(bucket=probe) excludes it but a point-GET returned 200 (cache ghost invisible to scan)`,
								});
							}
						}
					}

					const nextTick = now + POLL_MS;
					const wait = nextTick - Date.now();
					if (wait > 0) await sleep(wait);
				}

				const confirmedCount = evictionConfirmedAtTick.size;

				// Phase 3: quiescent settle, then the HARD sticky check.
				await sleep(QUIESCENT_BUFFER_MS);

				const finalHammer = await mapBounded(ids, CONCURRENCY, async (id) => {
					const reads = await Promise.all(Array.from({ length: FINAL_BURST_PER_ID }, () => getRecord(base, auth, id)));
					const stickyGhost = reads.some((r) => r.status === 200);
					return { id, stickyGhost, sample: reads.find((r) => r.status === 200)?.body };
				});
				const finalScanLive = await scanBucket(base, auth, 'probe');
				const stickyGhosts = finalHammer.filter((f) => f.stickyGhost);

				if (ghostObservations.length > 0 || scanDivergences.length > 0 || stickyGhosts.length > 0) {
					console.error(
						`TTL-eviction ghost check: confirmed=${confirmedCount}/${N} ghosts=${ghostObservations.length} ` +
							`scanDivergences=${scanDivergences.length} stickyGhosts=${stickyGhosts.length}\n` +
							(stickyGhosts.length
								? stickyGhosts.map((g) => `sticky id=${g.id} body=${JSON.stringify(g.sample)}`).join('\n') + '\n'
								: '') +
							(scanDivergences.length
								? scanDivergences
										.slice(0, 8)
										.map((d) => d.detail)
										.join('\n')
								: '')
					);
				}

				// Confirm the harness actually drove real eviction (not vacuous).
				ok(
					confirmedCount === N,
					`expected all ${N} ids to reach eviction-confirmed (404) within the poll window, got ${confirmedCount}`
				);

				// HARD invariant: once evicted + quiescent-settled, NO worker's point-GET may still
				// serve the record.
				strictEqual(
					stickyGhosts.length,
					0,
					`sticky cross-worker cache ghost(s) after TTL eviction + ${QUIESCENT_BUFFER_MS}ms settle:\n` +
						stickyGhosts.map((g) => `id=${g.id} body=${JSON.stringify(g.sample)}`).join('\n')
				);
				strictEqual(
					finalScanLive.size,
					0,
					`scan(bucket=probe) still lists ${finalScanLive.size} row(s) post-quiescent (sweep incomplete?)`
				);
			}
		);

		test(
			'control: TTL-refreshed record stays live throughout, then converges cleanly once refresh stops',
			{ timeout: 60_000 },
			async () => {
				const id = 'reset-me';
				const RESETS = 4;
				const RESET_INTERVAL_MS = TTL_MS / 2; // well within TTL each time -> never expires until we stop

				let lastAckAt = await putRecord(base, auth, id, 'alive', 'reset', -1);

				for (let i = 0; i < RESETS; i++) {
					await sleep(RESET_INTERVAL_MS);
					// Spray reads across workers WHILE the record is still supposed to be alive.
					const reads = await Promise.all(Array.from({ length: BURST_PER_ID }, () => getRecord(base, auth, id)));
					const allLive = reads.every((r) => r.status === 200);
					ok(
						allLive,
						`reset round ${i}: expected all point-GETs to be 200 (record kept alive by refresh), got statuses ${reads.map((r) => r.status).join(',')}`
					);
					lastAckAt = await putRecord(base, auth, id, 'alive', 'reset', i); // reset TTL again
				}

				// Stop refreshing; let it actually expire, then confirm cross-worker convergence to 404.
				const expiresAt = lastAckAt + TTL_MS;
				await sleep(Math.max(0, expiresAt - Date.now()) + CLEANUP_INTERVAL_MS * 4 + QUIESCENT_BUFFER_MS);

				const finalReads = await Promise.all(
					Array.from({ length: FINAL_BURST_PER_ID }, () => getRecord(base, auth, id))
				);
				const stillLive = finalReads.filter((r) => r.status === 200);
				const finalScan = await scanBucket(base, auth, 'reset');

				strictEqual(
					stillLive.length,
					0,
					`control record still served (ghost) by ${stillLive.length} worker(s) after it was allowed to expire`
				);
				strictEqual(
					finalScan.size,
					0,
					'control record still present in scan(bucket=reset) after it was allowed to expire'
				);
			}
		);
	}
);
