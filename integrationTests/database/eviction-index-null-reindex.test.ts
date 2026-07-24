/**
 * harper#1894 (F-149) regression — TTL/expiration eviction must not orphan secondary-index entries.
 *
 * Removing a record (delete or the background TTL-eviction sweep) calls
 * `updateIndices(id, existingRecord, null)` to clear that record's secondary-index entries. The bug:
 * with `record === null`, `updateIndices` resolved the *new* indexed value to `null` rather than
 * "absent", and for an `indexNulls` index — the DEFAULT for `@indexed` — it then RE-ADDED a
 * `[null, id]` index entry immediately after removing the real `[value, id]` one. The result was a
 * dangling index entry (raw key `null`, value = the id of a now-deleted record) for every evicted
 * row: on RocksDB an `@indexed` TTL table left 100% of its rows dangling in the raw index.
 *
 * The classic search_by_value oracle can't observe this — it joins each index hit back through the
 * primary record and drops the hit when the record is gone — so it reported "0 phantom" vacuously.
 * This test reads the raw index DBI directly (RawIndex / PrimaryIds, no join) so a dangling entry is
 * visible, and additionally asserts the legitimate indexNulls behavior the fix must preserve: a
 * present record whose indexed attribute is genuinely `null` stays indexed under null.
 *
 * Scoped to RocksDB (where F-149 manifests and the raw-index-DBI oracle reads reliably through a
 * resource; see the skipSuite note). LMDB eviction/index consistency is covered by the cross-engine
 * eviction-secondary-index.test.ts, and the fix itself is engine-agnostic (shared updateIndices()).
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'eviction-index-null-reindex');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const EXPIRING_BUCKETS = ['E1', 'E2', 'E3'];
const ROWS_PER_BUCKET = 40; // 120 expiring rows total — enough that the sweep runs several batches
// The oracle reads the raw secondary-index DBI directly (t.indices[field].getRange()). That direct-DBI
// read is reliable on RocksDB but not through a resource on LMDB (getRange on the LMDB index DBI does
// not enumerate committed rows the same way — a harness limitation, not a Harper bug), and F-149 is a
// RocksDB-manifested defect. LMDB eviction/index consistency is covered by the cross-engine
// eviction-secondary-index.test.ts; the fix itself is engine-agnostic (shared updateIndices()).
const skipSuite = process.platform === 'win32' || ENGINE === 'lmdb';

suite(`F-149 eviction null-reindex vs secondary index [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Expiring/').timeout(2000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready yet */
			}
			await sleep(250);
		}
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
	async function getJSON(path: string): Promise<any> {
		const res = await fetch(`${httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		return res.json();
	}
	const rawIndex = (table: string) => getJSON(`/RawIndex/?table=${table}`);
	const primaryIds = (table: string) => getJSON(`/PrimaryIds/?table=${table}`);

	test('TTL eviction removes both the base row and its raw secondary-index entry (no [null,id] orphan)', async () => {
		for (const bucket of EXPIRING_BUCKETS) {
			const res = await postJSON('/Load/', { table: 'Expiring', bucket, prefix: bucket, count: ROWS_PER_BUCKET });
			strictEqual(res.status, 200, `seed Expiring/${bucket}`);
		}
		const total = EXPIRING_BUCKETS.length * ROWS_PER_BUCKET;

		// Pre-expiry: every row present in both the base store and the raw index.
		strictEqual((await primaryIds('Expiring')).ids.length, total, 'all expiring rows present pre-expiry (base)');
		strictEqual((await rawIndex('Expiring')).count, total, 'all expiring rows present pre-expiry (raw index)');

		// Let the TTL (12s) elapse and the periodic sweep (scanInterval 1s) run, with NO intervening reads
		// (isolates the periodic-sweep path from on-read lazy eviction). Poll a bounded window for drain.
		const deadline = Date.now() + 30_000;
		let base = (await primaryIds('Expiring')).ids.length;
		let idx = (await rawIndex('Expiring')).count;
		while (Date.now() < deadline && (base > 0 || idx > 0)) {
			await sleep(1_000);
			base = (await primaryIds('Expiring')).ids.length;
			idx = (await rawIndex('Expiring')).count;
		}

		const rawAfter = await rawIndex('Expiring');
		strictEqual(base, 0, 'expiring base rows fully evicted');
		// The regression: before the fix this was `total` (every row left a dangling [null,id] entry).
		strictEqual(
			rawAfter.count,
			0,
			`expiring raw index fully cleared — no dangling entries. Survivors: ${JSON.stringify(
				rawAfter.entries.slice(0, 10)
			)}`
		);
	});

	test('indexNulls is preserved — a present record whose indexed attribute is null stays indexed under null', async () => {
		// Permanent table: never expires. One row with a real bucket, one with a genuinely-null bucket.
		strictEqual((await postJSON('/Load/', { table: 'Permanent', bucket: 'P1', prefix: 'P1', count: 5 })).status, 200);
		strictEqual((await postJSON('/Load/', { table: 'Permanent', bucket: 'null', prefix: 'PN', count: 3 })).status, 200);

		// Give any sweep a chance to (wrongly) touch these — they must all survive, fully indexed.
		await sleep(4_000);

		const base = (await primaryIds('Permanent')).ids;
		strictEqual(base.length, 8, 'all permanent rows retained (base)');

		const raw = await rawIndex('Permanent');
		strictEqual(raw.count, 8, 'all permanent rows retained (raw index)');

		// Every base id must appear exactly once in the raw index; the 3 null-bucket rows must be
		// indexed under the null key (the legitimate indexNulls behavior the fix preserves).
		const indexedIds = raw.entries.map((e: any) => e.value).sort();
		deepStrictEqual(indexedIds, [...base].sort(), 'every permanent row is indexed exactly once');
		const nullBucketIds = raw.entries
			.filter((e: any) => e.key === null)
			.map((e: any) => e.value)
			.sort();
		deepStrictEqual(nullBucketIds, ['PN-000000', 'PN-000001', 'PN-000002'], 'null-bucket rows indexed under null');
	});
});
