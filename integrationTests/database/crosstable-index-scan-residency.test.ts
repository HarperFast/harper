/**
 * QA-656c -- THIRD/FINAL attempt at ARM1 ONLY: does WARMING a table's secondary-index resource
 * (a prior solo read) before it occupies slot 2 of a two-table request change whether it shorts?
 *
 * Follow-up to QA-653 (CONFIRMED the RocksDB-only cross-table secondary-index scan miss: within
 * a single request, a second table's indexed read can come back short/empty) and QA-656 (found
 * write/declaration order does NOT determine the vulnerable slot -- QA-653's repro got the
 * MIRROR polarity of the filed GH#1881 report despite identical seeding discipline). Two prior
 * attempts at this exact hypothesis (qa656-index-slot.test.ts: 11 tables/5 groups; qa656b-
 * warm-cold.test.ts: 5 tables, N=100 repeated samples) BOTH produced zero measured cells --
 * over-scoped and either output was swallowed or the run never returned inside 420s.
 *
 * This file is deliberately minimal: ONE arm, TWO legs, TWO tables total, ONE combo request per
 * leg (not a repeated N-sample loop), N~20 rows/table (not 100).
 *
 * NOTE on design: a first cut of this file used 4 tables (two independent pairs, so each leg
 * would start from a genuinely untouched "cold" table) but that caused a write-stall -- the
 * 3rd table's very first write exceeded its 15s fetch timeout, almost certainly RocksDB
 * backing up against the 8MB WriteBufferManager cap once cumulative write volume across tables
 * crossed it (2 tables at the same per-table volume did NOT stall). Reverted to the literal
 * 2-table design from the task brief:
 *   Leg 1 ("warm-A-first"): solo-warm WarmA, then ONE Drain(WarmA,WarmB) -- WarmB is
 *     cold-first-touch in slot 2.
 *   Leg 2 ("warm-B-first", warming swapped): solo-warm WarmB, then ONE Drain(WarmB,WarmA).
 * CAVEAT: because both legs reuse the SAME two physical tables, by leg 2 WarmA has already
 * been read twice (its own leg-1 solo warm, and leg-1's combo as slot 1) -- it is not a
 * pristine "cold" table when it lands in slot 2 of leg 2's request. Leg 2 therefore tests
 * "does an already-warmed table still avoid shorting when moved to slot 2", which is a WEAKER
 * form of the hypothesis than leg 1's genuinely-cold-WarmB case. This is reported as-is, not
 * papered over.
 *
 * QA-774 UPDATE (this run, SHA d112560b6): originally REQUIRED
 * storage.rocks.writeBufferManagerSize:8_388_608 to force memtable flushes / multiple sorted
 * runs. On this machine that cap now HANGS the seed indefinitely (WriteBufferManager write-stall
 * backpressure that never clears -- see QA-772's repro of the same stall). Per QA-772's proven
 * fix: the WBM cap is dropped entirely, and sorted runs are forced instead via an explicit
 * `POST /Flush/` (-> `table.primaryStore.flush()`) after every seeding wave -- RocksDB's native
 * flush is atomic across all column families sharing the schema directory, so one flush() call
 * seals that wave's memtable into its own SST for primary + every index CF. The oracle is armed
 * and verified explicitly below (filesystem .sst count AND engine levelstats sorted-run count on
 * the index CF, for BOTH tables) before either leg runs -- an unarmed oracle producing a green
 * here would be worthless.
 * RocksDB only (LMDB is established clean per QA-629/QA-653 and is not re-tested here).
 *
 * Harper SHA under test: d112560b6 (main).
 * Repro command:
 *   cd /home/kzyp/dev/harper && timeout 420 npm run test:integration -- \
 *     "integrationTests/qa-scratch/qa656c-warm-cold-min.test.ts" > "$TMPDIR/qa656c.log" 2>&1; \
 *     tail -150 "$TMPDIR/qa656c.log"
 *   (NEVER pipe the test command directly into tail/head -- the pipe buffers and a timeout kill
 *   discards everything already printed; redirect to a file first, tail the file after.)
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'crosstable-index-scan-residency');
const DATABASE_NAME = 'qa656c';

// Total on-disk sorted-run count from a 'rocksdb.levelstats' string: each L0 file is its own
// overlapping sorted run; L1+ files within a level don't overlap each other, so a populated
// level beyond L0 counts as ONE additional sorted run. Using only the L0 row is racy: RocksDB's
// own background compaction (level0_file_num_compaction_trigger defaults to 4) can merge L0
// down to 1 file between a flush and the next query, moving the merged data to a non-L0 level
// rather than eliminating the extra sorted run (confirmed empirically in qa632/qa633 — see
// their file headers).
function countSortedRuns(levelStats: string): number {
	let total = 0;
	for (const line of levelStats.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+/);
		if (!m) continue;
		const [, levelStr, filesStr] = m;
		const level = Number(levelStr);
		const files = Number(filesStr);
		if (files <= 0) continue;
		total += level === 0 ? files : 1;
	}
	return total;
}

// Recursively count *.sst files under a directory — the filesystem-level half of the armed-
// oracle precondition (mirrors qa772-flush-forcing.test.ts).
function countSstFiles(dir: string): { total: number; byDir: Record<string, number> } {
	const byDir: Record<string, number> = {};
	let total = 0;
	function walk(d: string) {
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) {
				walk(p);
			} else if (e.name.endsWith('.sst')) {
				total++;
				byDir[d] = (byDir[d] || 0) + 1;
			}
		}
	}
	walk(dir);
	return { total, byDir };
}

// Same per-table volume as the 2 tables that seeded cleanly in the 4-table dry run (10MB/table),
// which matches QA-653's known-good per-table volume closely enough to keep the flush behavior.
// WAVES stays at 20 (essential ingredient: every key touched every wave, scattering entries
// across many sorted runs). PER_KEY_PER_WAVE=1 (not 5) so EXPECTED_PER_KEY lands at ~20, not 100.
const KEYS = 125;
const PER_KEY_PER_WAVE = 1;
const WAVES = 20;
const BODY_KB = 4;
const EXPECTED = WAVES * PER_KEY_PER_WAVE; // 20
const DRAIN_KEY = 'repo-7';
const TABLES = ['WarmA', 'WarmB'];
const FETCH_TIMEOUT_MS = 15_000;

suite(
	'QA-656c ARM1 (minimal): warm/cold immunization of the vulnerable slot [rocksdb]',
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let dataRootDir = '';
		const armedSnapshot: Record<string, { l0Files: number | null; levelStats: string }> = {};

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				// QA-774: no storage.rocks.writeBufferManagerSize override — that cap now hangs this
				// fixture's seed on this machine (see file header). Sorted runs are forced explicitly
				// via POST /Flush/ between waves instead (QA-772 technique).
				config: {
					logging: { console: true, level: 'error' },
				},
				env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			dataRootDir = (ctx.harper as any).dataRootDir as string;

			// Poll for route readiness (component is pre-installed; no restart needed -- do NOT call
			// restartHttpWorkers() against a pre-installed fixture, it is fire-and-forget and races).
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const probe = await client.reqRest('/WarmA/').timeout(2000);
						if (probe.status !== 404) break;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
			}

			function post(path: string, body: unknown): Promise<Response> {
				return fetch(`${httpURL}${path}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				});
			}

			// Each wave is its own transaction, followed by an explicit /Flush/ (QA-772 technique):
			// RocksDB's atomic flush seals that wave's memtable into its own SST for primary + every
			// index CF, so by wave=N there are up to N separate on-disk sorted runs per table.
			//
			// WAVES=20 clears RocksDB's level0_file_num_compaction_trigger (default 4) five times
			// over, so background compaction eventually cascades ALL of a table's data down into a
			// single bottom-level file (confirmed empirically: querying levelstats well after BOTH
			// tables finish seeding shows a fully compacted "0 0 .. 6 1 0" — sortedRuns=1, oracle
			// unarmed). The multi-sorted-run state genuinely existed but is racy against RocksDB's
			// own background compaction, exactly as qa772/qa632/qa633 warn. Root-cause fix: snapshot
			// levelstats for a table IMMEDIATELY after that table's OWN last flush (before the other
			// table's 20-wave seeding gives compaction time to finish), and use THAT captured
			// snapshot — not a live re-query — as the armed-oracle precondition evidence.
			for (const table of TABLES) {
				for (let wave = 0; wave < WAVES; wave++) {
					const t0 = Date.now();
					const r = await post('/SeedWave/', {
						table,
						wave,
						keys: KEYS,
						perKeyPerWave: PER_KEY_PER_WAVE,
						bodyKb: BODY_KB,
					});
					console.log(`[QA-656c] SeedWave ${table} wave=${wave} status=${r.status} took ${Date.now() - t0}ms`);
					ok(r.status === 200, `SeedWave ${table} wave=${wave} should return 200, got ${r.status}`);
					const f = await post('/Flush/', { table });
					ok(f.status === 200, `Flush after ${table} wave=${wave} should return 200, got ${f.status}`);
				}
				const statsR = await fetch(`${httpURL}/IndexStats/?table=${table}&attribute=repositoryId`, {
					headers: { Authorization: client.headers.Authorization },
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				});
				ok(statsR.status === 200, `IndexStats(${table}) immediately post-seed should return 200, got ${statsR.status}`);
				const statsBody = (await statsR.json()) as { index: { l0Files: number | null; levelStats: string } };
				armedSnapshot[table] = statsBody.index;
				console.log(
					`[QA-656c] ${table} post-seed index(repositoryId) levelstats snapshot: ${JSON.stringify(statsBody.index)}`
				);
			}
			console.log(
				`[QA-656c] seeded ${TABLES.join(', ')}: ${KEYS} keys x ${PER_KEY_PER_WAVE} x ${WAVES} waves each (EXPECTED_PER_KEY=${EXPECTED})`
			);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		async function drain(
			tablesCsv: string,
			scan: 'index' | 'full' | 'rawindex',
			key = DRAIN_KEY
		): Promise<Record<string, number>> {
			const url = `${httpURL}/Drain/?tables=${encodeURIComponent(tablesCsv)}&scan=${scan}&key=${encodeURIComponent(key)}`;
			const r = await fetch(url, {
				headers: { Authorization: client.headers.Authorization },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			strictEqual(r.status, 200, `Drain ${tablesCsv} scan=${scan} should return 200, got ${r.status}`);
			const body = (await r.json()) as { order: string[]; counts: Record<string, number> };
			console.log(`[QA-656c] Drain(${tablesCsv}, scan=${scan}, key=${key}) -> ${JSON.stringify(body.counts)}`);
			return body.counts;
		}

		// ── ARMED-ORACLE PRECONDITION: prove (don't assume) multiple on-disk sorted runs exist for
		// BOTH tables before trusting either leg. An unarmed oracle producing a green run is
		// worthless (QA-772/QA-774) -- verify independently via the filesystem AND via RocksDB's own
		// levelstats on the exact index CF the Drain reads exercise, and FAIL LOUDLY if either is
		// unarmed rather than silently continuing into a meaningless comparison.
		test('ORACLE PRECONDITION: filesystem shows multiple .sst files under the schema dataRootDir', () => {
			ok(dataRootDir, 'ctx.harper.dataRootDir must be set');
			const { total, byDir } = countSstFiles(join(dataRootDir, 'database', DATABASE_NAME));
			console.log(`[QA-656c] .sst files under database/${DATABASE_NAME}: total=${total}`, byDir);
			ok(
				total > 1,
				`ARMED-ORACLE PRECONDITION FAILED: expected >1 .sst file across ${DATABASE_NAME}'s column families, found ${total} — ` +
					`the flush-forced sorted-run oracle is NOT armed; every result below would be meaningless. Aborting loudly.`
			);
		});

		test(
			"ORACLE PRECONDITION: RocksDB levelstats show >1 on-disk sorted run on both tables' repositoryId index CF (post-seed snapshot)",
			{ timeout: 30_000 },
			() => {
				// Uses the snapshot captured immediately after each table's OWN last flush (see
				// before() comment) rather than a live re-query — a live re-query here races
				// RocksDB's background compaction, which (confirmed empirically) fully cascades this
				// fixture's 20-wave/table dataset down to a single bottom-level file well within the
				// time it takes the OTHER table to finish seeding.
				for (const table of TABLES) {
					const snapshot = armedSnapshot[table];
					ok(snapshot, `no post-seed IndexStats snapshot captured for ${table}`);
					const sortedRuns = typeof snapshot.levelStats === 'string' ? countSortedRuns(snapshot.levelStats) : 0;
					console.log(
						`[QA-656c] ${table} post-seed snapshot sortedRuns=${sortedRuns} (from ${JSON.stringify(snapshot)})`
					);
					ok(
						sortedRuns > 1,
						`ARMED-ORACLE PRECONDITION FAILED: expected ${table}'s repositoryId index CF to show >1 on-disk sorted run ` +
							`immediately post-seed (L0 files + populated levels beyond L0), got ${sortedRuns} from ${JSON.stringify(snapshot)} — ` +
							`the flush-forced sorted-run oracle was NOT armed even at the earliest measurable point. Aborting loudly.`
					);
				}
			}
		);

		// ── LEG 1 (warm-A-first): solo-warm WarmA, then ONE Drain(WarmA,WarmB) -- WarmB cold-in-slot2 ──
		let leg1WarmCount = -1;
		let leg1ColdCount = -1;
		test('LEG warm-A-first: solo-warm WarmA, then Drain(WarmA,WarmB)', { timeout: 30_000 }, async () => {
			const solo = await drain('WarmA', 'index');
			console.log(`[QA-656c] LEG warm-A-first: solo warm-read WarmA -> ${solo.WarmA}/${EXPECTED}`);

			const combo = await drain('WarmA,WarmB', 'index');
			leg1WarmCount = combo.WarmA;
			leg1ColdCount = combo.WarmB;
			console.log(
				`[QA-656c] LEG warm-A-first RESULT: WarmA (slot1, pre-warmed)=${leg1WarmCount}/${EXPECTED}; ` +
					`WarmB (slot2, cold-first-touch)=${leg1ColdCount}/${EXPECTED}`
			);

			const full = await drain('WarmA,WarmB', 'full');
			strictEqual(full.WarmA, EXPECTED, 'full-scan oracle WarmA should be intact');
			strictEqual(full.WarmB, EXPECTED, 'full-scan oracle WarmB should be intact -- base rows must be untouched');

			const raw = await drain('WarmA,WarmB', 'rawindex');
			console.log(`[QA-656c] LEG warm-A-first rawindex (bypasses primary join): WarmA=${raw.WarmA} WarmB=${raw.WarmB}`);
		});

		// ── LEG 2 (warm-B-first, warming swapped): solo-warm WarmB, then ONE Drain(WarmB,WarmA) ──────
		// CAVEAT: WarmA is already warm by this point (leg 1 solo-warmed it and read it as slot 1) --
		// this leg tests "does an already-warmed table still avoid shorting in slot 2", not a
		// pristine cold-WarmA case. See file docstring.
		let leg2WarmCount = -1;
		let leg2NotColdCount = -1;
		test('LEG warm-B-first (swapped): solo-warm WarmB, then Drain(WarmB,WarmA)', { timeout: 30_000 }, async () => {
			const solo = await drain('WarmB', 'index');
			console.log(`[QA-656c] LEG warm-B-first: solo warm-read WarmB -> ${solo.WarmB}/${EXPECTED}`);

			const combo = await drain('WarmB,WarmA', 'index');
			leg2WarmCount = combo.WarmB;
			leg2NotColdCount = combo.WarmA;
			console.log(
				`[QA-656c] LEG warm-B-first RESULT: WarmB (slot1, pre-warmed)=${leg2WarmCount}/${EXPECTED}; ` +
					`WarmA (slot2, ALREADY-warmed-from-leg1, not pristine cold)=${leg2NotColdCount}/${EXPECTED}`
			);

			const full = await drain('WarmB,WarmA', 'full');
			strictEqual(full.WarmB, EXPECTED, 'full-scan oracle WarmB should be intact');
			strictEqual(full.WarmA, EXPECTED, 'full-scan oracle WarmA should be intact -- base rows must be untouched');

			const raw = await drain('WarmB,WarmA', 'rawindex');
			console.log(`[QA-656c] LEG warm-B-first rawindex (bypasses primary join): WarmB=${raw.WarmB} WarmA=${raw.WarmA}`);
		});

		// ── LEG 3 (confirmatory): does the SPECIFIC table that shorted in leg 1 (WarmB) stop
		// shorting once explicitly warmed, when placed back in slot 2? By this point WarmB has
		// been solo-warmed (leg 2 start) and read once as slot 1 (leg 2 combo) -- neither of those
		// touched it as a cold slot-2 occupant. This directly tests whether warming immunizes the
		// exact table that previously exhibited the shortfall, not just a different table.
		let leg3WarmBInSlot2Count = -1;
		test(
			'LEG confirmatory: place the now-warmed WarmB (the table that shorted in leg 1) back in slot 2',
			{ timeout: 30_000 },
			async () => {
				const combo = await drain('WarmA,WarmB', 'index');
				leg3WarmBInSlot2Count = combo.WarmB;
				console.log(
					`[QA-656c] LEG confirmatory RESULT: WarmA (slot1)=${combo.WarmA}/${EXPECTED}; ` +
						`WarmB (slot2, NOW WARMED, previously shorted in leg 1 at cold-first-touch)=${leg3WarmBInSlot2Count}/${EXPECTED}`
				);
			}
		);

		test(
			'ARM1 COMPARISON: does the shortfall follow the never-pre-warmed table (leg 1 is the clean case)?',
			{ timeout: 10_000 },
			() => {
				console.log(
					`[QA-656c] ARM1 COMPARISON: leg warm-A-first -> WarmA(warm,slot1)=${leg1WarmCount}/${EXPECTED} WarmB(cold,slot2)=${leg1ColdCount}/${EXPECTED}; ` +
						`leg warm-B-first -> WarmB(warm,slot1)=${leg2WarmCount}/${EXPECTED} WarmA(already-warm,slot2)=${leg2NotColdCount}/${EXPECTED}`
				);
				const leg1Short = leg1ColdCount !== EXPECTED || leg1WarmCount !== EXPECTED;
				const leg2Short = leg2NotColdCount !== EXPECTED || leg2WarmCount !== EXPECTED;
				if (!leg1Short && !leg2Short) {
					console.log(
						'[QA-656c] ARM1 READ: NO-VERDICT -- no shortfall observed in either leg on this run (no defect to compare against)'
					);
				} else {
					const leg1FollowsCold = leg1ColdCount !== EXPECTED && leg1WarmCount === EXPECTED;
					if (leg1FollowsCold) {
						console.log(
							'[QA-656c] ARM1 READ (leg 1, the clean genuinely-cold case): shortfall landed on the cold (never-pre-warmed) ' +
								'table, warmed table was intact -- consistent with hypothesis CONFIRMED for leg 1'
						);
					} else if (leg1Short) {
						console.log(
							'[QA-656c] ARM1 READ (leg 1): a shortfall occurred but did NOT cleanly land on the cold table -- REFUTED/MIXED for leg 1'
						);
					}
					console.log(
						`[QA-656c] ARM1 READ (leg 2, caveat: WarmA not pristine cold): ${leg2Short ? 'a shortfall WAS observed' : 'no shortfall observed'} -- ` +
							'see leg 2 caveat in file docstring before treating this as a clean warm/cold comparison'
					);
				}
				console.log(
					`[QA-656c] ARM1 READ (leg 3, confirmatory): WarmB (the table that shorted cold-in-slot2 in leg 1) now reads ` +
						`${leg3WarmBInSlot2Count}/${EXPECTED} in slot 2 after being explicitly warmed -- ` +
						(leg3WarmBInSlot2Count === EXPECTED
							? 'RECOVERED to full count once warmed: consistent with hypothesis CONFIRMED'
							: 'still short even though warmed: hypothesis REFUTED for this specific table')
				);
			}
		);
	}
);
