/**
 * record-caching (harper #410) value-shape edge: object <-> invalidated-null, cross-worker.
 *
 * resources/PrimaryRocksDatabase.ts#getEntry only populates the per-worker WeakLRUCache when
 * `entry.value != null` (a separate guard from the typeof-object check). Every other
 * record-caching suite only ever drives object-shaped values through that branch. The one
 * value that reaches it as a genuinely versioned NON-object root through a fully supported
 * public API is `Table.invalidate(id)`, which — for a table with no @indexed attributes —
 * writes a real `null` root value via the normal recordUpdater path (this mirrors a real
 * production code path: replication residency loss).
 *
 *   S1 object -> invalidate(null) -> object transition, cross-worker: a key cached as an
 *      object on every worker, invalidated, then re-created.
 *   S2 rapid object<->invalidated-null churn on one hot key, cross-worker point-GETs each
 *      round, asserting every read matches the just-acked write (never stale).
 *   S3 near-empty object + genuine delete -> recreate cycle (the OTHER getEntry short-circuit:
 *      raw == null -> cache.delete(id) -> undefined), plus a never-written-key absence check.
 *
 * Reads go through primaryStore.getEntry() directly (resources.js) so we observe the cache
 * layer's literal truth per worker, not Table's higher-level read semantics.
 *
 * Skipped on LMDB (PrimaryRocksDatabase is RocksDB-specific).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { WORKER_COUNT, assertMultiWorker } from './recordCachingWorkers.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-caching-invalidate');
const SKIP = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

type GetResult = {
	threadId: number;
	id: string;
	exists: boolean;
	value: any;
	valueType: string;
	version: number | null;
};

suite(
	'record-caching value-shape edge: object <-> invalidated-null [rocksdb] multi-worker',
	{ skip: SKIP || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let authHeader: string;
		const failures: string[] = [];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: WORKER_COUNT } } });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			authHeader = client.headers.Authorization;

			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${httpURL}/WidgetGet/?id=probe`, { headers: { Authorization: authHeader } });
					if (probe.status === 200) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}

			await assertMultiWorker(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		async function putWidget(id: string, name: string, tag: string): Promise<void> {
			const res = await fetch(`${httpURL}/Widget/${encodeURIComponent(id)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ id, name, tag }),
			});
			ok(res.status === 200 || res.status === 201 || res.status === 204, `PUT ${id} returned ${res.status}`);
		}

		async function putMinimal(id: string): Promise<void> {
			const res = await fetch(`${httpURL}/Widget/${encodeURIComponent(id)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ id }),
			});
			ok(res.status === 200 || res.status === 201 || res.status === 204, `PUT ${id} returned ${res.status}`);
		}

		async function deleteWidget(id: string): Promise<void> {
			const res = await fetch(`${httpURL}/Widget/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers: { Authorization: authHeader },
			});
			ok(res.status === 200 || res.status === 204, `DELETE ${id} returned ${res.status}`);
		}

		async function invalidateWidget(id: string): Promise<void> {
			const res = await fetch(`${httpURL}/Invalidate/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ id }),
			});
			strictEqual(res.status, 200, `Invalidate ${id} returned ${res.status}`);
		}

		async function getOnce(id: string): Promise<GetResult> {
			const res = await fetch(`${httpURL}/WidgetGet/?id=${encodeURIComponent(id)}`, {
				headers: { Authorization: authHeader },
			});
			strictEqual(res.status, 200, `GET ${id} returned ${res.status}`);
			const body = (await res.json()) as GetResult;
			return body;
		}

		/** Fan out N concurrent point-GETs (maximizes odds of hitting multiple distinct workers). */
		async function getMulti(id: string, n = 10): Promise<GetResult[]> {
			return Promise.all(Array.from({ length: n }, () => getOnce(id)));
		}

		function assertAllObject(label: string, results: GetResult[], expected: { name: string; tag: string }) {
			for (const r of results) {
				if (!r.exists) {
					failures.push(`${label}: worker ${r.threadId} exists=false, expected an object (STALE/missing)`);
					continue;
				}
				if (r.valueType !== 'object') {
					failures.push(
						`${label}: worker ${r.threadId} valueType=${r.valueType}, expected 'object' (value=${JSON.stringify(r.value)})`
					);
					continue;
				}
				if (r.value?.name !== expected.name || r.value?.tag !== expected.tag) {
					failures.push(
						`${label}: worker ${r.threadId} returned STALE/WRONG object ${JSON.stringify(r.value)}, expected name=${expected.name} tag=${expected.tag}`
					);
				}
			}
		}

		function assertAllNull(label: string, results: GetResult[]) {
			for (const r of results) {
				if (!r.exists) {
					failures.push(
						`${label}: worker ${r.threadId} exists=false, expected a versioned entry with value=null (record was invalidated, not deleted)`
					);
					continue;
				}
				if (r.valueType !== 'null' || r.value !== null) {
					failures.push(
						`${label}: worker ${r.threadId} returned STALE/WRONG value ${JSON.stringify(r.value)} (type=${r.valueType}), expected null (invalidated) -- POSSIBLE STALE CACHED OBJECT`
					);
				}
			}
		}

		function assertAllAbsent(label: string, results: GetResult[]) {
			for (const r of results) {
				if (r.exists) {
					failures.push(
						`${label}: worker ${r.threadId} exists=true (value=${JSON.stringify(r.value)}), expected key genuinely absent after delete`
					);
				}
			}
		}

		test('S1 object -> invalidate(null) -> object transition, cross-worker', async () => {
			const id = 's1-obj2null';
			await putWidget(id, 'original', 'x');
			let results = await getMulti(id, 12);
			assertAllObject('S1 warm object', results, { name: 'original', tag: 'x' });

			// Invalidate: real versioned null write. Every worker whose cache is warm with the
			// stale object must NOT keep serving it.
			await invalidateWidget(id);
			results = await getMulti(id, 16);
			assertAllNull('S1 after invalidate', results);

			// And back to a (different) object once more (round-trip both directions).
			await putWidget(id, 'restored', 'y');
			results = await getMulti(id, 12);
			assertAllObject('S1 after re-create', results, { name: 'restored', tag: 'y' });

			strictEqual(failures.length, 0, `S1 failures:\n${failures.join('\n')}`);
		});

		test(
			'S2 rapid object<->invalidated-null churn on a hot key, cross-worker point-GETs each round',
			{ timeout: 60_000 },
			async () => {
				const id = 's2-churn';
				const ROUNDS = 40;
				await putWidget(id, 'seed', 'seed'); // establish a warm cached object baseline first
				for (let round = 0; round < ROUNDS; round++) {
					if (round % 2 === 0) {
						await putWidget(id, `r${round}`, 'obj');
						const results = await getMulti(id, 6);
						assertAllObject(`S2 round ${round} (object)`, results, { name: `r${round}`, tag: 'obj' });
					} else {
						await invalidateWidget(id);
						const results = await getMulti(id, 6);
						assertAllNull(`S2 round ${round} (invalidated)`, results);
					}
					if (failures.length > 0) break; // stop early once we have concrete evidence
				}
				strictEqual(failures.length, 0, `S2 churn failures:\n${failures.join('\n')}`);
			}
		);

		test('S3 near-empty object; genuine key absence; delete(tombstone) -> recreate cycle, cross-worker', async () => {
			// Genuine key absence sanity: a never-written id must read as absent on every worker
			// (the OTHER getEntry short-circuit: raw == null -> cache.delete(id) -> undefined).
			const neverWritten = 's3-never-written';
			let results = await getMulti(neverWritten, 10);
			assertAllAbsent('S3 never-written key', results);

			// Near-empty object: only the primary key attribute set.
			const idMin = 's3-minimal';
			await putMinimal(idMin);
			results = await getMulti(idMin, 8);
			for (const r of results) {
				if (!r.exists || r.valueType !== 'object') {
					failures.push(
						`S3 minimal: worker ${r.threadId} exists=${r.exists} valueType=${r.valueType} value=${JSON.stringify(r.value)}`
					);
				}
			}

			// Delete -> recreate cycle on a previously object-valued (cached) key. Note: Table.ts's
			// _writeDelete does NOT physically remove the RocksDB key on this call -- with audit
			// enabled (the default) it writes a real versioned `null` tombstone via the same
			// updateRecord/recordUpdater path invalidate() uses, then schedules an EVENTUAL
			// background sweep (runs on a timer on the last worker thread) to physically reclaim
			// it later. So immediately after DELETE this is the SAME observable state as S1's
			// invalidate() -- DELETE and invalidate() converge on the exact same immediate
			// cache-coherence contract.
			const id = 's3-delete-recreate';
			await putWidget(id, 'warm', 'before-delete');
			results = await getMulti(id, 10);
			assertAllObject('S3 warm object before delete', results, { name: 'warm', tag: 'before-delete' });

			await deleteWidget(id);
			results = await getMulti(id, 14);
			assertAllNull('S3 after delete (tombstone, not yet physically reclaimed)', results);

			// Recreate with a DIFFERENT value -- must not resurrect the deleted object nor serve
			// a stale tombstone/ghost from any worker's cache.
			await putWidget(id, 'resurrected', 'after-recreate');
			results = await getMulti(id, 14);
			assertAllObject('S3 after recreate', results, { name: 'resurrected', tag: 'after-recreate' });

			strictEqual(failures.length, 0, `S3 failures:\n${failures.join('\n')}`);
		});
	}
);
