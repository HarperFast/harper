/**
 * QA-661 (source:pr:1896) — PRE-MERGE probe of harper#1896 "fix: TTL eviction/delete no longer
 * orphans secondary-index entries (F-149)" (branch kris/f149-eviction-index-orphan,
 * head 38e100517).
 *
 * The PR's own integration test (eviction-index-null-reindex.test.ts) is single-threaded
 * (threads:1), RocksDB-only, one scalar @indexed attribute, no concurrent writes during the
 * sweep, and never exercises delete()/evict() directly. This probe targets the corners that
 * leaves uncovered:
 *
 *  Arm 1 (main race): threads:{count:4}, TTL sweep evicting ~140 rows while a Heartbeat loop
 *  concurrently PUTs a *changing* bucket value + array-valued `tags` on a fixed set of
 *  never-expiring ids (every write recomputes expiresAt = now + expirationMs, so these ids stay
 *  alive throughout the sweep window). Covers: multi-worker contention, an indexed attribute
 *  updated WHILE eviction races on neighboring rows (old index entry must go, new must land, no
 *  cross-contamination), an array-valued @indexed attribute, and null-valued bucket rows
 *  (indexNulls).
 *  Arm 2: explicit delete() path (vs the TTL-sweep path).
 *  Arm 3: explicit evict() path (the caching-table removal path — shares the same
 *  updateIndices(id, rec, null) call F-149 fixed, but is a third, distinct call site).
 *
 * Oracle (per the probe brief): search_by_value joins through the primary record and SKIPs when
 * it's absent, so a green search_by_value can NEVER reveal a dangling index entry. Every check
 * here reads the raw primary store and the raw secondary-index DBI directly (resources.js:
 * PrimaryDump / RawIndex, both getRange({snapshot:false}), no join) and asserts BOTH directions:
 *   - orphan:  index entry -> no base row for that id (dangling), or a stale value for a row that
 *              still exists (wrong old value not cleaned up)
 *   - missing: base row's current attribute value(s) -> no matching index entry (lost lookup)
 *
 * Run both engines:
 *   npm run test:integration -- "integrationTests/database/eviction-index-orphan-removal-paths.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/eviction-index-orphan-removal-paths.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'eviction-index-orphan-removal-paths');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const WORKERS = 4;
const TAG = `[QA-661:${ENGINE}]`;

const EXPIRING_BUCKETS = ['B1', 'B2', 'B3'];
const ROWS_PER_BUCKET = 50; // 150 expiring rows total
const NULL_EVERY = 10; // every 10th row per bucket gets bucket=null (indexNulls path)
// Must match resources.js Load's id format (`${prefix}-${pad(i)}` with 6-digit zero-pad) so the
// Heartbeat loop refreshes the SAME rows /Load/ seeded, not a disjoint set of freshly-created ones.
const HEARTBEAT_IDS = Array.from({ length: 12 }, (_, i) => `HB-${String(i).padStart(6, '0')}`);
const HEARTBEAT_BUCKETS = ['HB-bucketA', 'HB-bucketB', 'HB-bucketC'];

const skipSuite = process.platform === 'win32';

suite(`QA-661 F-149 fix probe [${ENGINE}] [threads=${WORKERS}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: WORKERS }, logging: { console: true, level: 'error' } },
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
	const rawIndex = (table: string, field: string) => getJSON(`/RawIndex/?table=${table}&field=${field}`);
	const primaryDump = (table: string) => getJSON(`/PrimaryDump/?table=${table}`);

	/**
	 * Structural consistency oracle, both directions, read straight off the raw stores (no join).
	 *   dangling: index entry whose id has no base row at all (F-149's exact defect shape).
	 *   stale: index entry for an id that DOES have a base row, but the value isn't one of the
	 *          row's current values (an old value that should have been removed on update/reindex).
	 *   missing: a base row's current value has no corresponding index entry (lost lookup).
	 */
	async function checkConsistency(table: string, field: string) {
		const [{ rows }, { entries }] = await Promise.all([primaryDump(table), rawIndex(table, field)]);
		const idSet = new Set(rows.map((r: any) => r.id));
		const expectedByRow = new Map<string, Set<any>>();
		for (const r of rows) {
			const v = r[field];
			let vals: any[];
			if (v === undefined) vals = [];
			else if (v === null) vals = [null];
			else if (Array.isArray(v)) vals = v;
			else vals = [v];
			expectedByRow.set(r.id, new Set(vals));
		}
		const indexedByRow = new Map<string, Set<any>>();
		const dangling: any[] = [];
		for (const e of entries) {
			const id = e.value;
			if (!idSet.has(id)) {
				dangling.push(e);
				continue;
			}
			if (!indexedByRow.has(id)) indexedByRow.set(id, new Set());
			indexedByRow.get(id)!.add(e.key);
		}
		const stale: any[] = [];
		const missing: any[] = [];
		for (const [id, expectedVals] of expectedByRow) {
			const actualVals = indexedByRow.get(id) ?? new Set();
			for (const v of actualVals) if (!expectedVals.has(v)) stale.push({ id, value: v });
			for (const v of expectedVals) if (!actualVals.has(v)) missing.push({ id, value: v });
		}
		return { baseCount: rows.length, indexCount: entries.length, dangling, stale, missing };
	}

	// ---- Arm 1: multi-worker TTL sweep racing concurrent writes to the indexed attributes ----
	test(
		'Arm1: TTL sweep (threads=4) vs concurrent bucket/tags updates — bucket + tags indices stay consistent',
		{ timeout: 90_000 },
		async () => {
			for (const bucket of EXPIRING_BUCKETS) {
				const res = await postJSON('/Load/', {
					table: 'Expiring',
					count: ROWS_PER_BUCKET,
					prefix: bucket,
					bucket,
					nullEvery: NULL_EVERY,
					withTags: true,
				});
				strictEqual(res.status, 200, `seed Expiring/${bucket}`);
			}
			const res = await postJSON('/Load/', {
				table: 'Expiring',
				count: HEARTBEAT_IDS.length,
				prefix: 'HB',
				bucket: 'HB-bucketA',
				withTags: true,
			});
			strictEqual(res.status, 200, 'seed heartbeat rows');

			const totalNonHeartbeat = EXPIRING_BUCKETS.length * ROWS_PER_BUCKET;
			const preBase = await primaryDump('Expiring');
			strictEqual(preBase.rows.length, totalNonHeartbeat + HEARTBEAT_IDS.length, 'all rows present pre-sweep');

			// Positive control: the post-sweep checks below prove absence of ORPHANED index entries
			// for the ~150 rows the sweep is about to evict. That proof is only meaningful if those
			// rows actually had live index entries to begin with — if seeding or indexing were
			// silently broken, they'd never be indexed, their later absence would require no cleanup
			// at all, and this removal oracle would pass having observed nothing. Assert full raw-index
			// consistency (no dangling, no missing) BEFORE the sweep starts.
			const preBucketConsistency = await checkConsistency('Expiring', 'bucket');
			const preTagsConsistency = await checkConsistency('Expiring', 'tags');
			strictEqual(
				preBucketConsistency.missing.length,
				0,
				`POSITIVE CONTROL: pre-sweep bucket index must have an entry for every row's current value, got ${preBucketConsistency.missing.length} missing — an unindexed row would trivially pass the post-sweep orphan check`
			);
			strictEqual(
				preBucketConsistency.dangling.length,
				0,
				`POSITIVE CONTROL: pre-sweep bucket index must have no dangling entries before the sweep even starts, got ${preBucketConsistency.dangling.length}`
			);
			strictEqual(
				preTagsConsistency.missing.length,
				0,
				`POSITIVE CONTROL: pre-sweep tags index must have an entry for every row's current value(s), got ${preTagsConsistency.missing.length} missing`
			);
			strictEqual(
				preTagsConsistency.dangling.length,
				0,
				`POSITIVE CONTROL: pre-sweep tags index must have no dangling entries before the sweep even starts, got ${preTagsConsistency.dangling.length}`
			);

			// Heartbeat loop: keep refreshing the heartbeat ids' bucket + tags (a full PUT resets
			// expiresAt) every ~400ms for ~9s, cycling through 3 different bucket values and tag
			// sets, WHILE the TTL sweep is actively evicting the other 150 rows concurrently.
			let heartbeatRound = 0;
			let heartbeatStop = false;
			const heartbeatLoop = (async () => {
				while (!heartbeatStop) {
					const bucket = HEARTBEAT_BUCKETS[heartbeatRound % HEARTBEAT_BUCKETS.length];
					const tags = [`${bucket}-tag${heartbeatRound % 3}`, `${bucket}-tagX`];
					await postJSON('/Heartbeat/', { table: 'Expiring', ids: HEARTBEAT_IDS, bucket, tags });
					heartbeatRound++;
					await sleep(400);
				}
			})();

			// Poll until the non-heartbeat rows have fully drained (sweep settled), capped at 60s.
			const deadline = Date.now() + 60_000;
			let base = await primaryDump('Expiring');
			while (Date.now() < deadline && base.rows.length > HEARTBEAT_IDS.length) {
				await sleep(1000);
				base = await primaryDump('Expiring');
			}
			// A couple more heartbeat rounds after settle, then stop.
			await sleep(1000);
			heartbeatStop = true;
			await heartbeatLoop;
			await sleep(500); // let the last heartbeat write's index update land

			const bucketConsistency = await checkConsistency('Expiring', 'bucket');
			const tagsConsistency = await checkConsistency('Expiring', 'tags');

			console.log(
				`\n${TAG} Arm1 rounds=${heartbeatRound} base=${bucketConsistency.baseCount} ` +
					`bucketIndex=${bucketConsistency.indexCount} tagsIndex=${tagsConsistency.indexCount}\n` +
					`  bucket: dangling=${bucketConsistency.dangling.length} stale=${bucketConsistency.stale.length} missing=${bucketConsistency.missing.length}\n` +
					`  tags:   dangling=${tagsConsistency.dangling.length} stale=${tagsConsistency.stale.length} missing=${tagsConsistency.missing.length}\n` +
					`  >>> ${
						bucketConsistency.dangling.length === 0 &&
						bucketConsistency.stale.length === 0 &&
						bucketConsistency.missing.length === 0 &&
						tagsConsistency.dangling.length === 0 &&
						tagsConsistency.stale.length === 0 &&
						tagsConsistency.missing.length === 0
							? 'CONSISTENT under multi-worker sweep + concurrent indexed-attribute writes'
							: 'INDEX INCONSISTENCY DETECTED (see counts above)'
					}`
			);

			strictEqual(bucketConsistency.baseCount, HEARTBEAT_IDS.length, 'only heartbeat rows survive the sweep');
			strictEqual(
				bucketConsistency.dangling.length,
				0,
				`bucket index dangling entries: ${JSON.stringify(bucketConsistency.dangling.slice(0, 10))}`
			);
			strictEqual(
				bucketConsistency.stale.length,
				0,
				`bucket index stale entries: ${JSON.stringify(bucketConsistency.stale.slice(0, 10))}`
			);
			strictEqual(
				bucketConsistency.missing.length,
				0,
				`bucket index missing entries: ${JSON.stringify(bucketConsistency.missing.slice(0, 10))}`
			);
			strictEqual(
				tagsConsistency.dangling.length,
				0,
				`tags index dangling entries: ${JSON.stringify(tagsConsistency.dangling.slice(0, 10))}`
			);
			strictEqual(
				tagsConsistency.stale.length,
				0,
				`tags index stale entries: ${JSON.stringify(tagsConsistency.stale.slice(0, 10))}`
			);
			strictEqual(
				tagsConsistency.missing.length,
				0,
				`tags index missing entries: ${JSON.stringify(tagsConsistency.missing.slice(0, 10))}`
			);
			// Bloat bound: bucket index should have exactly HEARTBEAT_IDS.length entries (one live
			// value each), NOT total-ever-written (150 evicted + N heartbeat rounds) if the fix holds.
			strictEqual(
				bucketConsistency.indexCount,
				HEARTBEAT_IDS.length,
				'bucket index bounded to live rows (no accumulation)'
			);
		}
	);

	// ---- Arm 2: explicit delete() path ----
	test('Arm2: explicit delete() — no orphaned/lost index entries', { timeout: 30_000 }, async () => {
		const total = 60;
		const res = await postJSON('/Load/', { table: 'Perm', count: total, prefix: 'D', bucket: 'DEL', nullEvery: 6 });
		strictEqual(res.status, 200, 'seed Perm for delete arm');
		const preDump = await primaryDump('Perm');
		// Independent of checkConsistency below: if seeding silently failed and primaryDump ever
		// returned fewer rows than requested, checkConsistency's dangling/missing counts would be
		// derived from that SAME short dump and could trivially read as "consistent" over an
		// empty/partial cohort. Pin the raw row count first so that can't happen unnoticed.
		strictEqual(preDump.rows.length, total, `all ${total} seeded rows must be present pre-delete`);
		const allIds = preDump.rows.map((r: any) => r.id);
		const toDelete = allIds.filter((_: string, i: number) => i % 2 === 0); // delete half

		// Positive control: prove the half about to be delete()'d is actually indexed BEFORE we
		// delete it. An unindexed row would trivially show zero dangling entries afterward.
		const preConsistency = await checkConsistency('Perm', 'bucket');
		strictEqual(
			preConsistency.missing.length,
			0,
			`POSITIVE CONTROL: pre-delete bucket index must have an entry for every seeded row, got ${preConsistency.missing.length} missing`
		);
		strictEqual(
			preConsistency.dangling.length,
			0,
			`POSITIVE CONTROL: pre-delete bucket index must have no dangling entries before delete() even runs, got ${preConsistency.dangling.length}`
		);

		const delRes = await postJSON('/DeleteIds/', { table: 'Perm', ids: toDelete });
		strictEqual(delRes.status, 200, 'DeleteIds should succeed');

		// delete() (with audit on, the default) writes an audit tombstone (value=null) and only
		// physically removes the base row later via the async scheduleCleanup() sweep — but
		// updateIndices(id, existingRecord, null) runs synchronously at delete time, so the index
		// should already be fully clean right away, even though tombstone rows still count toward
		// primaryStore.getRange(). Check the immediate post-delete state first (a tombstone row
		// spreads to no properties, so the oracle expects zero index entries for it).
		const immediate = await checkConsistency('Perm', 'bucket');
		console.log(
			`${TAG} Arm2 delete() immediate: base(raw incl. tombstones)=${immediate.baseCount} index=${immediate.indexCount} ` +
				`dangling=${immediate.dangling.length} stale=${immediate.stale.length} missing=${immediate.missing.length}`
		);
		strictEqual(
			immediate.dangling.length,
			0,
			`delete() immediate dangling entries: ${JSON.stringify(immediate.dangling.slice(0, 10))}`
		);
		strictEqual(
			immediate.stale.length,
			0,
			`delete() immediate stale entries: ${JSON.stringify(immediate.stale.slice(0, 10))}`
		);
		strictEqual(
			immediate.missing.length,
			0,
			`delete() immediate missing entries: ${JSON.stringify(immediate.missing.slice(0, 10))}`
		);

		// NOTE: scheduleCleanup()'s physical tombstone removal is a no-op here — `cleanupInterval` is
		// only armed by @table(expiration:...); Perm has no TTL, so audit tombstones are reclaimed on
		// a separate, much-longer audit-retention timescale, not the seconds-scale TTL sweep. That is
		// expected, pre-existing, out-of-scope-for-F-149 behavior, not something this probe polls for.
		// A second consistency check a beat later, purely to confirm the immediate state is stable
		// (not a transient artifact of the delete's own commit).
		await sleep(2_000);
		const consistency = await checkConsistency('Perm', 'bucket');
		console.log(
			`${TAG} Arm2 delete() +2s: base(raw incl. tombstones)=${consistency.baseCount} index=${consistency.indexCount} ` +
				`dangling=${consistency.dangling.length} stale=${consistency.stale.length} missing=${consistency.missing.length}`
		);
		strictEqual(
			consistency.dangling.length,
			0,
			`delete() +2s dangling entries: ${JSON.stringify(consistency.dangling.slice(0, 10))}`
		);
		strictEqual(
			consistency.stale.length,
			0,
			`delete() +2s stale entries: ${JSON.stringify(consistency.stale.slice(0, 10))}`
		);
		strictEqual(
			consistency.missing.length,
			0,
			`delete() +2s missing entries: ${JSON.stringify(consistency.missing.slice(0, 10))}`
		);
	});

	// ---- Arm 3: explicit evict() path ----
	test('Arm3: explicit evict() — no orphaned/lost index entries', { timeout: 30_000 }, async () => {
		const total = 40;
		const res = await postJSON('/Load/', { table: 'Perm', count: total, prefix: 'V', bucket: 'EVI', nullEvery: 5 });
		strictEqual(res.status, 200, 'seed Perm for evict arm');
		const preDump = await primaryDump('Perm');
		const evictIds = preDump.rows.filter((r: any) => r.id.startsWith('V-')).map((r: any) => r.id);
		// Independent of checkConsistency below: if seeding silently failed and fewer 'V-' rows
		// than requested landed, the dangling/missing counts below would be derived from that same
		// short cohort and could trivially read as "consistent" over an empty/partial set.
		strictEqual(evictIds.length, total, `all ${total} seeded 'V-' rows must be present pre-evict`);
		const toEvict = evictIds.filter((_: string, i: number) => i % 2 === 1); // evict half

		// Positive control: prove the half about to be evict()'d is actually indexed BEFORE we
		// evict it. An unindexed row would trivially show zero dangling entries afterward.
		const preConsistency = await checkConsistency('Perm', 'bucket');
		strictEqual(
			preConsistency.missing.length,
			0,
			`POSITIVE CONTROL: pre-evict bucket index must have an entry for every seeded row, got ${preConsistency.missing.length} missing`
		);
		strictEqual(
			preConsistency.dangling.length,
			0,
			`POSITIVE CONTROL: pre-evict bucket index must have no dangling entries before evict() even runs, got ${preConsistency.dangling.length}`
		);

		const evRes = await postJSON('/EvictIds/', { table: 'Perm', ids: toEvict });
		strictEqual(evRes.status, 200, 'EvictIds should succeed');
		const evBody = await evRes.json();
		strictEqual(evBody.evicted, toEvict.length, 'all requested ids were evicted');

		const dump = await primaryDump('Perm');
		const survivingV = dump.rows.filter((r: any) => r.id.startsWith('V-'));
		strictEqual(survivingV.length, evictIds.length - toEvict.length, 'evicted rows removed from base store');

		const consistency = await checkConsistency('Perm', 'bucket');
		console.log(
			`${TAG} Arm3 evict() base=${consistency.baseCount} index=${consistency.indexCount} ` +
				`dangling=${consistency.dangling.length} stale=${consistency.stale.length} missing=${consistency.missing.length}`
		);
		strictEqual(
			consistency.dangling.length,
			0,
			`evict() dangling entries: ${JSON.stringify(consistency.dangling.slice(0, 10))}`
		);
		strictEqual(
			consistency.stale.length,
			0,
			`evict() stale entries: ${JSON.stringify(consistency.stale.slice(0, 10))}`
		);
		strictEqual(
			consistency.missing.length,
			0,
			`evict() missing entries: ${JSON.stringify(consistency.missing.slice(0, 10))}`
		);
	});
});
