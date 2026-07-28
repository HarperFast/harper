/**
 * QA-670 — does harper#1896 ("fix: TTL eviction/delete no longer orphans secondary-index
 * entries (F-149)") ALSO eliminate the F-175 phantom null-keyed secondary-index entry that every
 * removal path inserts (updateIndices(id, existing, null) resolves the new value to `null`
 * instead of "absent", and indexNulls defaults to true, so removal INSERTS a [null, id] entry
 * instead of only deleting the real one)? Or does #1896 fix only the narrow RocksDB TTL-batcher
 * leg from the original issue framing (#1894), leaving the broader every-removal leak intact?
 *
 * CODE READING (this branch, resources/Table.ts): the PR's diff touches exactly ONE line, inside
 * the SHARED `updateIndices()` closure used by every removal call site:
 *     - const value = record && (resolver ? resolver(record) : record[key]);
 *     + const value = record == null ? undefined : resolver ? resolver(record) : record[key];
 * All three removal call sites funnel through this same function with `record=null`:
 *   1. Table.delete() -> _writeDelete()'s commit callback -> updateIndices(id, existingRecord, null)
 *   2. TableResource.evict() (used by BOTH the read-triggered lazy-eviction path in
 *      ensureLoadedFromSource() AND runRecordExpirationEviction()) -> updateIndices(id, existing, null)
 *   3. RocksDB's createEvictionBatcher().stageInto() (the background scheduleCleanup() sweep) ->
 *      updateIndices(item.key, entry.value, null, options) directly
 * getIndexedValues(undefined, indexNulls) always returns undefined (utility/lmdb/commonUtility.ts),
 * vs getIndexedValues(null, true) === [null] — so if the a-priori reading is right, the fix should
 * suppress the phantom on ALL THREE call sites and BOTH engines, not just the RocksDB TTL batcher.
 * This experiment MEASURES that instead of trusting the PR description or a static read.
 *
 * Design — four tables isolate the three removal call sites plus an update-in-place control (see
 * schema.graphql for the exact TTL/scanInterval isolation of the sweep vs the lazy-evict leg):
 *   DelTable     — explicit Table.delete(), no TTL anywhere.
 *   SweepTable   — background TTL/expiration sweep (scheduleCleanup(); RocksDB batcher or LMDB
 *                  per-record evict()).
 *   EvictTable   — TableResource.evict() via the READ-triggered LAZY path only (scanInterval so
 *                  large the background sweep can't fire in this test's window).
 *   ControlTable — update-in-place only, never deleted. Zero phantoms expected — proves the oracle
 *                  isn't manufacturing them.
 *
 * Oracle (direct index-store reads, D-230/D-242 protocol — never search_by_value, which joins
 * through the primary record and is blind to a dangling/phantom entry by construction; and never
 * an unqualified getRange(), which on LMDB starts after `null` and silently skips null-keyed
 * entries):
 *   nullKeyed         — index.getRange({start:null}) entries with indexedValue===null. No row in
 *                       this fixture ever legitimately has bucket=null, so ANY null-keyed entry is
 *                       by construction a phantom (F-175 signature).
 *   danglingNonNull   — index.getRange({start:null}) entries with indexedValue!==null whose
 *                       primaryKey is NOT in the primaryStore dump (classic F-149-style dangling
 *                       real-key entry pointing at a gone row).
 *   phantomForRemoved — of nullKeyed, how many point at an id this test actually removed (vs. some
 *                       unrelated stray null).
 *
 * Run against BOTH this branch (PR #1896) and current main (baseline, no fix) to get the delta.
 *
 * Harper SHA (this branch, PR #1896 head): e54365be75e696994bca2785a7cdaa6bbebe50d1
 * Reproduction:
 *   cd /home/kzyp/dev/harper/.claude/worktrees/qa-pr-1896
 *   timeout 420 npm run test:integration -- "integrationTests/database/eviction-index-phantom-null-keys.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb timeout 420 npm run test:integration -- "integrationTests/database/eviction-index-phantom-null-keys.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'eviction-index-phantom-null-keys');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const skipSuite = process.platform === 'win32';

const N = 20; // rows per group (tens, not thousands)

interface BaseRow {
	id: string;
	bucket: string;
}
interface IndexRow {
	indexedValue: unknown;
	primaryKey: string;
}

const matrix: Array<Record<string, unknown>> = [];

function ids(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
}

suite(`QA-670 harper#1896 vs F-175 phantom-null [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let auth: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 1 },
				logging: { console: true, level: 'error' },
				...(ENGINE === 'lmdb' ? { storage: { engine: 'lmdb' } } : {}),
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		// Readiness poll: hit the fixture's own probe route directly for non-404 (no restartHttpWorkers()).
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			try {
				const probe = await fetch(`${httpURL}/Dump/?table=DelTable`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(3_000),
				});
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

	async function getJSON(path: string): Promise<any> {
		const r = await fetch(`${httpURL}${path}`, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(30_000),
		});
		if (r.status !== 200) {
			const text = await r.text().catch(() => '');
			throw new Error(`${path} should return 200, got ${r.status}: ${text}`);
		}
		return r.json();
	}
	async function post(path: string, body: unknown, timeoutMs = 30_000): Promise<any> {
		const r = await fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (r.status !== 200) {
			const text = await r.text().catch(() => '');
			throw new Error(`POST ${path} should return 200, got ${r.status}: ${text}`);
		}
		return r.json();
	}
	async function dump(table: string): Promise<BaseRow[]> {
		return getJSON(`/Dump/?table=${table}`);
	}
	async function indexDump(table: string, attr = 'bucket'): Promise<IndexRow[]> {
		return getJSON(`/IndexDump/?table=${table}&attr=${attr}`);
	}

	/**
	 * Positive control for the raw-index oracle itself: `measure()` only counts BAD entries
	 * (null-keyed / dangling); if IndexDump or index population were broken and returned `[]`,
	 * every phantom/dangling count below would be zero and the whole suite would pass having
	 * observed nothing. Call this right after seeding, before any removal, so a failure here
	 * means the oracle is blind rather than the fix being correct.
	 */
	async function assertIndexPositiveControl(table: string, expectedIds: string[], bucketValue: string) {
		const idx = await indexDump(table);
		const matching = idx.filter((e) => e.indexedValue === bucketValue && expectedIds.includes(e.primaryKey));
		strictEqual(
			matching.length,
			expectedIds.length,
			`POSITIVE CONTROL: raw index dump for ${table} must show all ${expectedIds.length} freshly-loaded rows under bucket=${bucketValue}, got ${matching.length} — if this fails the index oracle itself is broken/empty and every phantom/dangling count in this suite is meaningless`
		);
	}

	/**
	 * The 3-count oracle described in the task: for a set of removedIds against a table,
	 *   danglingNonNull  — real-key (non-null) index entries pointing at a gone row (any gone row,
	 *                       not just ones this test removed — classic F-149 shape).
	 *   nullKeyed        — ALL null-keyed index entries (no row here ever legitimately has
	 *                       bucket=null, so every one is a phantom).
	 *   phantomForRemoved— of nullKeyed, how many point specifically at an id this test removed.
	 */
	async function measure(table: string, removedIds: Set<string>) {
		const base = await dump(table);
		const baseIds = new Set(base.map((r) => r.id));
		const idx = await indexDump(table);
		const nullKeyed = idx.filter((e) => e.indexedValue === null);
		const danglingNonNull = idx.filter((e) => e.indexedValue !== null && !baseIds.has(e.primaryKey));
		const phantomForRemoved = nullKeyed.filter((e) => removedIds.has(e.primaryKey));
		return {
			table,
			baseCount: base.length,
			indexCount: idx.length,
			danglingNonNullCount: danglingNonNull.length,
			nullKeyedCount: nullKeyed.length,
			phantomForRemovedCount: phantomForRemoved.length,
			removedCount: removedIds.size,
		};
	}

	function report(label: string, m: Awaited<ReturnType<typeof measure>>, expectPhantom: boolean) {
		console.log(
			`[QA-670 ${ENGINE}] ${label}: base=${m.baseCount} index=${m.indexCount} ` +
				`danglingNonNull=${m.danglingNonNullCount} nullKeyed(=phantom)=${m.nullKeyedCount} ` +
				`phantomForRemoved=${m.phantomForRemovedCount}/${m.removedCount} >>> ${
					m.nullKeyedCount === 0 && m.danglingNonNullCount === 0
						? 'CLEAN (no F-149 dangling, no F-175 phantom)'
						: m.nullKeyedCount > 0
							? 'F-175 PHANTOM NULL-KEYED LEAK PRESENT'
							: 'F-149-STYLE DANGLING (non-null) PRESENT'
				}`
		);
		matrix.push({ label, engine: ENGINE, expectPhantomPreFix: expectPhantom, ...m });
	}

	// ---- Q0: explicit delete() (fastest, no wait — runs first so a partial run still verdicts) --
	test('Q0 DelTable: explicit delete() phantom-null check', { timeout: 30_000 }, async () => {
		const delIds = ids('del', N);
		await post('/Load/', { table: 'DelTable', ids: delIds, bucket: 'DEL' });
		let base = await dump('DelTable');
		strictEqual(base.length, N, 'all rows present pre-delete');
		await assertIndexPositiveControl('DelTable', delIds, 'DEL');

		await post('/Delete/', { table: 'DelTable', ids: delIds });
		await sleep(300);

		const m = await measure('DelTable', new Set(delIds));
		report('Q0 explicit-delete', m, true);
		strictEqual(m.baseCount, 0, 'all deleted rows gone from base store');
		strictEqual(
			m.nullKeyedCount,
			0,
			`explicit delete() must leave no null-keyed (phantom) index entry, got ${m.nullKeyedCount}`
		);
		strictEqual(
			m.danglingNonNullCount,
			0,
			`explicit delete() must leave no dangling index entry, got ${m.danglingNonNullCount}`
		);
		strictEqual(
			m.phantomForRemovedCount,
			0,
			`no removed id may retain a phantom index entry, got ${m.phantomForRemovedCount}/${N}`
		);
	});

	// ---- Q3: update-in-place control (fast, no removal — must show zero phantoms) ---------------
	test(
		'Q3 ControlTable: update-in-place, zero phantoms expected (oracle sanity control)',
		{ timeout: 30_000 },
		async () => {
			const ctrlIds = ids('ctrl', N);
			await post('/Load/', { table: 'ControlTable', ids: ctrlIds, bucket: 'ORIG' });
			await assertIndexPositiveControl('ControlTable', ctrlIds, 'ORIG');
			await post('/UpdateInPlace/', { table: 'ControlTable', ids: ctrlIds, bucket: 'UPDATED' });
			await sleep(300);

			const m = await measure('ControlTable', new Set()); // nothing removed
			report('Q3 update-in-place-control', m, false);
			strictEqual(m.baseCount, N, 'all control rows still present (never deleted)');
			strictEqual(m.nullKeyedCount, 0, 'update-in-place must NOT produce any null-keyed index entry');
			strictEqual(m.danglingNonNullCount, 0, 'update-in-place must NOT produce any dangling index entry');
			// Exact-count proof the raw index actually tracked the update, not just "zero bad entries"
			// (which a blind/broken index scan would also show): every control row must show up under
			// its NEW bucket value and none under the stale one.
			const idxAfter = await indexDump('ControlTable');
			const updatedEntries = idxAfter.filter((e) => e.indexedValue === 'UPDATED' && ctrlIds.includes(e.primaryKey));
			const staleOrigEntries = idxAfter.filter((e) => e.indexedValue === 'ORIG' && ctrlIds.includes(e.primaryKey));
			strictEqual(
				updatedEntries.length,
				N,
				`update-in-place: expected all ${N} control rows indexed under bucket=UPDATED, got ${updatedEntries.length}`
			);
			strictEqual(
				staleOrigEntries.length,
				0,
				`update-in-place: expected no control rows still indexed under the stale bucket=ORIG, got ${staleOrigEntries.length}`
			);
		}
	);

	// ---- Q2: read-triggered LAZY eviction (TableResource.evict() called directly from a GET, ------
	// isolated from the background sweep by a huge scanInterval) --------------------------------
	test('Q2 EvictTable: read-triggered lazy eviction (evict()) phantom-null check', { timeout: 30_000 }, async () => {
		const evictIds = ids('evict', N);
		await post('/Load/', { table: 'EvictTable', ids: evictIds, bucket: 'EVICT' });
		let base = await dump('EvictTable');
		strictEqual(base.length, N, 'all rows present pre-expiry');
		await assertIndexPositiveControl('EvictTable', evictIds, 'EVICT');

		// expiration:2s — wait past it, then GET each id to trigger the lazy-eviction path directly
		// (ensureLoadedFromSource -> TableResource.evict()), NOT the background sweep (scanInterval:300s).
		await sleep(2_500);
		// Guard against the wrong-path race: Table.ts's scheduleCleanup() aligns its FIRST timer to
		// the next wall-clock interval boundary counted from the start of the year (see
		// resources/Table.ts scheduleCleanup — `nextScheduled = ceil((now - startOfYear) /
		// interval) * interval + startOfYear`), not 300s from server start. Depending on where the
		// test happens to land in that 5-minute cycle, the "never fires in this window" background
		// sweep could in principle beat the GETs below to it, evicting via the wrong call site while
		// this test still credits the lazy-eviction path. Assert the rows are still here immediately
		// before triggering the lazy path, so that race fails loudly instead of silently passing.
		const preGet = await dump('EvictTable');
		strictEqual(
			preGet.length,
			N,
			`RACE: background sweep (scanInterval:300) appears to have already evicted EvictTable rows before the lazy-path GETs ran (${preGet.length}/${N} remain) — this arm cannot isolate the lazy-eviction call site if that happens`
		);
		for (const id of evictIds) {
			await fetch(`${httpURL}/EvictTable/${id}`, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(5_000),
			});
		}
		// give the fire-and-forget evict() commits a moment to land
		const deadline = Date.now() + 15_000;
		let baseLen = -1;
		while (Date.now() < deadline) {
			baseLen = (await dump('EvictTable')).length;
			if (baseLen === 0) break;
			await sleep(300);
		}

		const m = await measure('EvictTable', new Set(evictIds));
		report('Q2 lazy-evict()', m, true);
		strictEqual(m.baseCount, 0, `all lazily-evicted rows should be gone from base, got ${m.baseCount}`);
		strictEqual(
			m.nullKeyedCount,
			0,
			`lazy evict() must leave no null-keyed (phantom) index entry, got ${m.nullKeyedCount}`
		);
		strictEqual(
			m.danglingNonNullCount,
			0,
			`lazy evict() must leave no dangling index entry, got ${m.danglingNonNullCount}`
		);
		strictEqual(
			m.phantomForRemovedCount,
			0,
			`no evicted id may retain a phantom index entry, got ${m.phantomForRemovedCount}/${N}`
		);
	});

	// ---- Q1: background TTL/expiration SWEEP (scheduleCleanup(); RocksDB batcher path or LMDB ----
	// per-record evict() path) --------------------------------------------------------------------
	test('Q1 SweepTable: background TTL/expiration sweep phantom-null check', { timeout: 60_000 }, async () => {
		const sweepIds = ids('sweep', N);
		await post('/Load/', { table: 'SweepTable', ids: sweepIds, bucket: 'SWEEP' });
		let base = await dump('SweepTable');
		strictEqual(base.length, N, 'all rows present pre-expiry');
		await assertIndexPositiveControl('SweepTable', sweepIds, 'SWEEP');

		// expiration:3s, scanInterval:1s — poll until the background sweep drains the table. NO
		// intervening reads (isolates the sweep path from the lazy-read path tested in Q2).
		const deadline = Date.now() + 45_000;
		let baseLen = -1;
		while (Date.now() < deadline) {
			baseLen = (await dump('SweepTable')).length;
			if (baseLen === 0) break;
			await sleep(500);
		}

		const m = await measure('SweepTable', new Set(sweepIds));
		report('Q1 background-sweep', m, true);
		strictEqual(m.baseCount, 0, `all swept rows should be gone from base, got ${m.baseCount}`);
		strictEqual(
			m.nullKeyedCount,
			0,
			`background sweep must leave no null-keyed (phantom) index entry, got ${m.nullKeyedCount}`
		);
		strictEqual(
			m.danglingNonNullCount,
			0,
			`background sweep must leave no dangling index entry, got ${m.danglingNonNullCount}`
		);
		strictEqual(
			m.phantomForRemovedCount,
			0,
			`no swept id may retain a phantom index entry, got ${m.phantomForRemovedCount}/${N}`
		);
	});

	test('ZZ print matrix', { timeout: 5_000 }, async () => {
		console.log(`\n[QA-670 MATRIX ${ENGINE}]\n${JSON.stringify(matrix, null, 2)}`);
		ok(true);
	});
});
