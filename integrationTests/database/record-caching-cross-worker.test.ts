/**
 * Cross-worker record-cache coherence under update/delete churn (harper #410).
 *
 * PrimaryRocksDatabase fronts point reads with a per-worker WeakLRUCache; cross-worker
 * invalidation depends entirely on the shared VerificationTable (VT) version bump
 * propagating to every worker. putSync()/removeSync() only clear the LOCAL cache — so if
 * VT propagation to another worker lags (or is lost), that worker can keep serving a
 * stale/ghost entry on its point-GET path (sticky), or until unrelated churn evicts it
 * (transient). This suite runs a genuine multi-worker instance (see recordCachingWorkers.ts)
 * and hammers it with concurrent REST churn designed to spray requests across all workers
 * (fresh connection per request, since keep-alive pins a client to one worker), checking:
 *
 *  1. Update coherence: once a PUT's 200 is observed, no subsequent GET (from any worker)
 *     may return a counter/name older than that ack.
 *  2. Delete coherence: once a DELETE's ack is observed, no subsequent GET may return the
 *     old (pre-delete) body — must be 404 until a clean recreate, after which stale
 *     pre-delete bodies must never reappear.
 *  3. Hot-key convergence: rapid serialized PUT->GET rounds on one key must never regress
 *     below the highest counter already observed by ANY client.
 *
 * Writes to a given key are serialized (await the ack before firing GETs, await GETs before
 * the next write) so any violation is a genuine cache coherence bug, not a test-harness
 * "GET issued before PUT ack" race.
 *
 * Skipped on LMDB (PrimaryRocksDatabase is RocksDB-only).
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { WORKER_COUNT, assertMultiWorker, mapBounded } from './recordCachingWorkers.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-caching-coherence');
const SKIP = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
// Cap keys churning concurrently so the per-request fresh connections don't exhaust
// sockets on constrained CI. Small per-key bursts stay concurrent (the cross-worker check).
const CONCURRENCY = 24;

type Rec = { id: string; name: string; counter: number };

// Force a fresh connection per request (no keep-alive) so concurrent requests
// spray across the SO_REUSEPORT worker pool instead of pinning to one worker.
function headers(auth: string): Record<string, string> {
	return { 'Content-Type': 'application/json', 'Authorization': auth, 'Connection': 'close' };
}

async function putRecord(base: string, auth: string, id: string, name: string, counter: number): Promise<void> {
	const r = await fetch(`${base}/CacheRecord/${encodeURIComponent(id)}`, {
		method: 'PUT',
		headers: headers(auth),
		body: JSON.stringify({ id, name, counter }),
	});
	if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
		throw new Error(`PUT ${id} returned ${r.status}: ${await r.text()}`);
	}
	await r.text().catch(() => undefined);
}

async function deleteRecord(base: string, auth: string, id: string): Promise<void> {
	const r = await fetch(`${base}/CacheRecord/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: headers(auth),
	});
	if (r.status !== 200 && r.status !== 204 && r.status !== 404) {
		throw new Error(`DELETE ${id} returned ${r.status}: ${await r.text()}`);
	}
	await r.text().catch(() => undefined);
}

async function getRecord(base: string, auth: string, id: string): Promise<{ status: number; body: Rec | null }> {
	const r = await fetch(`${base}/CacheRecord/${encodeURIComponent(id)}`, { headers: headers(auth) });
	if (r.status === 404) {
		await r.text().catch(() => undefined);
		return { status: 404, body: null };
	}
	if (r.status !== 200) throw new Error(`GET ${id} returned ${r.status}: ${await r.text()}`);
	return { status: 200, body: (await r.json()) as Rec };
}

async function waitForTable(base: string, auth: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${base}/CacheRecord/probe`, { headers: headers(auth) });
			if (r.status < 500) {
				await r.text().catch(() => undefined);
				return;
			}
		} catch {
			/* not ready yet */
		}
		await sleep(200);
	}
	throw new Error('CacheRecord table never became ready');
}

suite(
	'record-caching cross-worker coherence [rocksdb] multi-worker',
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

		test('update churn: 200 keys x 4 rounds, GET after acked PUT never regresses', { timeout: 180_000 }, async () => {
			const COUNT = 200;
			const WARM_READS = 3;
			const ROUNDS = 4;
			const BURST = 5;

			const ids = Array.from({ length: COUNT }, (_, i) => `s1-${i}`);

			// Create all records.
			await mapBounded(ids, CONCURRENCY, (id, i) => putRecord(base, auth, id, `name-${i}-r0`, 0));

			// Warm caches across workers with several reads per record.
			await mapBounded(ids, CONCURRENCY, (id) =>
				Promise.all(Array.from({ length: WARM_READS }, () => getRecord(base, auth, id)))
			);

			const errors: string[] = [];

			// Per key: serialized rounds of PUT -> ack -> burst concurrent GETs.
			await mapBounded(ids, CONCURRENCY, async (id, i) => {
				let lastAckedCounter = 0;
				let lastAckedName = `name-${i}-r0`;
				for (let round = 1; round <= ROUNDS; round++) {
					const newCounter = round;
					const newName = `name-${i}-r${round}`;
					await putRecord(base, auth, id, newName, newCounter);
					// Ack observed: from this point, no GET may return < lastAcked.
					lastAckedCounter = newCounter;
					lastAckedName = newName;

					const results = await Promise.all(Array.from({ length: BURST }, () => getRecord(base, auth, id)));
					for (const { status, body } of results) {
						if (status !== 200 || !body) {
							errors.push(`${id} round ${round}: GET returned status ${status} after acked PUT (ghost/absent)`);
							continue;
						}
						if (body.counter < lastAckedCounter) {
							errors.push(
								`${id} round ${round}: STALE counter ${body.counter} < acked ${lastAckedCounter} (name=${body.name})`
							);
						} else if (body.counter === lastAckedCounter && body.name !== lastAckedName) {
							errors.push(
								`${id} round ${round}: TORN write, counter matches (${body.counter}) but name="${body.name}" != acked "${lastAckedName}"`
							);
						}
					}
				}
			});

			if (errors.length > 0) {
				console.error(
					`update-churn: ${errors.length} coherence violation(s). First 10:\n${errors.slice(0, 10).join('\n')}`
				);
			}
			strictEqual(errors.length, 0, `Cache coherence violations:\n${errors.slice(0, 10).join('\n')}`);
		});

		test(
			'delete churn: delete-then-hammer must never serve a ghost; recreate must be clean',
			{ timeout: 120_000 },
			async () => {
				const COUNT = 50;
				const BURST = 8;
				const ids = Array.from({ length: COUNT }, (_, i) => `s2-${i}`);

				const errors: string[] = [];

				await mapBounded(ids, CONCURRENCY, async (id, i) => {
					const originalName = `orig-${i}`;
					await putRecord(base, auth, id, originalName, 1);
					// Warm caches across workers.
					await Promise.all(Array.from({ length: 3 }, () => getRecord(base, auth, id)));

					await deleteRecord(base, auth, id);
					// From here: no worker may serve a 200 with the pre-delete body.
					const postDelete = await Promise.all(Array.from({ length: BURST }, () => getRecord(base, auth, id)));
					for (const { status, body } of postDelete) {
						if (status === 200) {
							errors.push(`${id}: GHOST after DELETE ack — GET returned 200 body=${JSON.stringify(body)}`);
						}
					}

					// Recreate with a distinguishable value; must never see old ghost or 404 afterwards.
					const recreatedName = `recreated-${i}`;
					await putRecord(base, auth, id, recreatedName, 99);
					const postRecreate = await Promise.all(Array.from({ length: BURST }, () => getRecord(base, auth, id)));
					for (const { status, body } of postRecreate) {
						if (status === 404) {
							errors.push(`${id}: 404 after recreate ack (recreate not visible)`);
						} else if (status === 200 && body) {
							if (body.name === originalName) {
								errors.push(`${id}: GHOST of pre-delete body reappeared after recreate: ${JSON.stringify(body)}`);
							} else if (body.name !== recreatedName || body.counter !== 99) {
								errors.push(`${id}: unexpected body after recreate: ${JSON.stringify(body)}`);
							}
						}
					}
				});

				if (errors.length > 0) {
					console.error(`delete-churn: ${errors.length} violation(s). First 10:\n${errors.slice(0, 10).join('\n')}`);
				}
				strictEqual(errors.length, 0, `Delete-churn coherence violations:\n${errors.slice(0, 10).join('\n')}`);
			}
		);

		test(
			'hot-key stress: rapid PUT/GET rounds never regress below any already-observed counter',
			{ timeout: 120_000 },
			async () => {
				const ROUNDS = 60;
				const BURST = 8;
				const id = 's3-hot-key';

				await putRecord(base, auth, id, 'hot-r0', 0);

				let maxObserved = 0;
				const errors: string[] = [];

				for (let round = 1; round <= ROUNDS; round++) {
					await putRecord(base, auth, id, `hot-r${round}`, round);
					// Simulate many concurrent clients hammering GET right after the ack.
					const results = await Promise.all(Array.from({ length: BURST }, () => getRecord(base, auth, id)));
					for (const { status, body } of results) {
						if (status !== 200 || !body) {
							errors.push(`round ${round}: GET status ${status} (expected 200)`);
							continue;
						}
						if (body.counter < maxObserved) {
							errors.push(
								`round ${round}: REGRESSION — counter ${body.counter} < max already-observed ${maxObserved} (name=${body.name})`
							);
						}
						if (body.counter > maxObserved) maxObserved = body.counter;
					}
				}

				strictEqual(maxObserved, ROUNDS, `final convergence: expected maxObserved=${ROUNDS}, got ${maxObserved}`);
				if (errors.length > 0) {
					console.error(`hot-key: ${errors.length} violation(s). First 10:\n${errors.slice(0, 10).join('\n')}`);
				}
				strictEqual(errors.length, 0, `Hot-key regression violations:\n${errors.slice(0, 10).join('\n')}`);
			}
		);
	}
);
