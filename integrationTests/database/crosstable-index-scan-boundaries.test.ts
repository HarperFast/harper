/**
 * QA-633 — F-158 / harper issue #1881 CLOSEOUT re-run on new main. Harness is a carry-over of
 * qa632-f158-bounds.test.ts (READ THAT FIRST, and qa629-crosstable-index-miss.test.ts before
 * it, for fixture shape / forced-flush rationale) — only the SHA note, fixture path, and suite
 * name differ. This harness answers three closeout questions:
 *
 *   1. STILL REPRODUCES? — smallest sorted-run/wave count that triggers it, and whether a
 *      SINGLE table (no cross-table involvement at all) already misses when its OWN
 *      secondary-index read is the 2nd+ operation within one request (DrainOwn: two reads
 *      against the SAME table, SAME request). Swept incrementally over waves 1..5 with an
 *      IndexStats ground-truth probe (RocksDB's own L0-file-count, parsed from
 *      'rocksdb.levelstats') alongside the row-count oracle.
 *   2. COMPACTION HEAL — does @harperfast/rocksdb-js's native `compact()` (called on the
 *      table's primary CF + every secondary-index CF) merge the sorted runs back down and
 *      make the index read correct again?
 *   3. SQL / WRITE REACH — does the miss propagate into a SQL COUNT aggregate (dual-subquery,
 *      two tables, one statement), and can it cause a durable WRONG WRITE via an upsert-guard
 *      pattern (UpsertViaIndex)?
 *
 * Every "0 rows" claim below is paired with a same-run full-scan positive control so the
 * oracle is proven to discriminate, per the QA-632/QA-633 brief.
 *
 * QA-774 UPDATE (this run, SHA d112560b6): originally this fixture used
 * `storage.rocks.writeBufferManagerSize: 8_388_608` to force real memtable flushes. On this
 * machine that cap now HANGS the seed indefinitely (WriteBufferManager write-stall backpressure
 * that never clears — see the original findings this file used to carry, and QA-772's repro of
 * the same stall). Per QA-772's proven fix: the WBM cap is dropped entirely, and sorted runs are
 * forced instead via an explicit `POST /Flush/` (-> `table.primaryStore.flush()`) after every
 * seeding wave. RocksDB's native flush is atomic across all column families sharing the schema
 * directory, so one flush() call seals that wave's memtable into its own SST for the primary AND
 * every index CF. The oracle is armed and verified explicitly below (filesystem .sst count AND
 * engine levelstats L0 count on the index CF) before any of the characterization tests run —
 * an unarmed oracle producing a green here would be worthless.
 *
 * Repro command:
 *   cd /home/kzyp/dev/harper && timeout 900 npm run test:integration -- \
 *     "integrationTests/qa-scratch/qa633-f158-closeout.test.ts"
 *
 * NOTE: this file intentionally contains assertions that are EXPECTED TO FAIL where F-158
 * reproduces (mirrors qa629's convention) — a red assertion IS the defect signal. See the
 * final console FINDINGS SUMMARY for the consolidated answer to each question.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import request from 'supertest';

const FIXTURE_PATH = resolve(import.meta.dirname, 'crosstable-index-scan-boundaries');
const ENGINE = 'rocksdb'; // RocksDB-only defect (LMDB has no LSM/sorted-run structure) — forced, not conditional.
const DATABASE_NAME = 'f158bounds';

// Same per-wave seeding parameters as qa629/qa772. Wave COUNT is 5: each wave is followed by an
// explicit POST /Flush/ (QA-772 technique), so 5 waves == 5 forced memtable flushes == up to 5
// separate on-disk SSTs for MinRepro, well past the >1-sorted-run threshold the oracle needs.
const KEYS = 50;
const PER_KEY_PER_WAVE = 5;
const BODY_KB = 4;
const DRAIN_KEY = 'repo-7';
const MAX_WAVES = 5;
const EXPECTED_FINAL = MAX_WAVES * PER_KEY_PER_WAVE;
const WAVE_CHECKPOINTS = [1, 2, 3, 4, 5]; // waves after which we probe
const FETCH_TIMEOUT_MS = 45_000;
const SEED_TIMEOUT_MS = 45_000; // no WBM cap -> no write-stall risk; a plain generous budget is enough.

function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// Total on-disk sorted-run count from a 'rocksdb.levelstats' string: each L0 file is its own
// overlapping sorted run; L1+ files within a level don't overlap each other, so a populated
// level beyond L0 counts as ONE additional sorted run (this is the invariant F-158 actually
// cares about — "rows span >1 sorted run" — not literally ">1 L0 file"). Using only the L0 row
// is racy: RocksDB's own background compaction (level0_file_num_compaction_trigger defaults to
// 4) can merge L0 down to 1 file between a flush and the next query, moving the merged data to
// a non-L0 level rather than eliminating the extra sorted run.
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

const findings: string[] = [];
function log(line: string) {
	findings.push(line);
	console.log(`[QA-633] ${line}`);
}

suite(`QA-633 F-158 closeout re-run [${ENGINE}]`, { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let opsURL: string;
	let authHeader: string;

	// Per-checkpoint: { wave, expected, ownReads: number[], indexStats }
	const sweepResults: Array<{ wave: number; expected: number; ownReads: number[]; indexL0?: unknown }> = [];
	let minReproBAvailable = false;
	let dataRootDir = '';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			// QA-774: no storage.rocks.writeBufferManagerSize override — that cap now hangs this
			// fixture's seed on this machine (see file header). Sorted runs are forced explicitly
			// via POST /Flush/ between waves instead (QA-772 technique).
			config: {
				logging: { console: true, level: 'error' },
			},
			env: { HARPER_STORAGE_ENGINE: ENGINE },
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		opsURL = client.operationsURL;
		authHeader = client.headers.Authorization;
		dataRootDir = (ctx.harper as any).dataRootDir as string;

		// Poll for route readiness (component is pre-installed; do NOT call restartHttpWorkers()
		// against a pre-installed fixture — it races the worker respawn and flakes).
		{
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/MinRepro/').timeout(2000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
		}

		function post(path: string, body: unknown): Promise<Response> {
			return fetchWithTimeout(
				`${httpURL}${path}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
					body: JSON.stringify(body),
				},
				SEED_TIMEOUT_MS
			);
		}
		function get(path: string): Promise<Response> {
			return fetchWithTimeout(`${httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		}

		// ── Question 1: MINIMAL REPRO — incremental wave sweep on a SINGLE table ──────────────
		// Each wave is its own transaction, followed by an explicit /Flush/ (QA-772 technique):
		// RocksDB's atomic flush seals that wave's memtable into its own SST for primary + every
		// index CF, so by wave=N there are up to N separate on-disk sorted runs for MinRepro.
		let waveNum = 0;
		for (const checkpoint of WAVE_CHECKPOINTS) {
			while (waveNum < checkpoint) {
				const r = await post('/SeedWave/', {
					table: 'MinRepro',
					wave: waveNum,
					keys: KEYS,
					perKeyPerWave: PER_KEY_PER_WAVE,
					bodyKb: BODY_KB,
				});
				ok(r.status === 200, `SeedWave MinRepro wave=${waveNum} should return 200, got ${r.status}`);
				const f = await post('/Flush/', { table: 'MinRepro' });
				ok(f.status === 200, `Flush after MinRepro wave=${waveNum} should return 200, got ${f.status}`);
				waveNum++;
			}
			const expected = waveNum * PER_KEY_PER_WAVE;

			const statsR = await get(`/IndexStats/?table=MinRepro&attribute=repositoryId`);
			const stats = statsR.status === 200 ? await statsR.json() : { error: statsR.status };

			const ownR = await get(`/DrainOwn/?table=MinRepro&key=${DRAIN_KEY}&reads=2&scan=index`);
			const own = (await ownR.json()) as { counts: number[] };

			sweepResults.push({ wave: waveNum, expected, ownReads: own.counts, indexL0: stats });
			log(
				`wave=${waveNum} expected=${expected} DrainOwn(index).counts=${JSON.stringify(own.counts)} ` +
					`indexStats=${JSON.stringify(stats)}`
			);
		}

		// Full-scan control, taken once the sweep is done (final state, wave=MAX_WAVES) — proves
		// the oracle discriminates: an unconditioned scan must return the true count regardless
		// of read position, even though the equivalent index read (above) is what's under test.
		const fullCtl = await get(`/DrainOwn/?table=MinRepro&key=${DRAIN_KEY}&reads=2&scan=full`);
		const fullCtlBody = (await fullCtl.json()) as { counts: number[] };
		log(`[control] wave=${MAX_WAVES} (final) DrainOwn(full).counts=${JSON.stringify(fullCtlBody.counts)}`);
		(sweepResults[sweepResults.length - 1] as any).fullControl = fullCtlBody.counts;

		// ── Cross-table comparison (mirrors qa629's order check, at matching data volume) ──────
		// Identical final dataset to MAX_WAVES separate SeedWave calls (same key/n coverage,
		// since n = wave*perKeyPerWave+i either way), but written as ONE transaction — MinReproB
		// is the "decoy" table read first in the cross-table probes below and doesn't itself need
		// multiple sorted runs. With no WBM cap there is no write-stall risk, so this is a plain,
		// unconditional seed (the old try/catch degrade-gracefully path is gone — QA-774).
		const r = await post('/SeedWave/', {
			table: 'MinReproB',
			wave: 0,
			keys: KEYS,
			perKeyPerWave: PER_KEY_PER_WAVE * MAX_WAVES,
			bodyKb: BODY_KB,
		});
		ok(r.status === 200, `SeedWave MinReproB (single transaction) should return 200, got ${r.status}`);
		const fB = await post('/Flush/', { table: 'MinReproB' });
		ok(fB.status === 200, `Flush after MinReproB seed should return 200, got ${fB.status}`);
		minReproBAvailable = true;
		log(
			`seeded MinReproB: ${KEYS} keys x ${PER_KEY_PER_WAVE * MAX_WAVES} rows/key, one transaction + flush (same volume as ${MAX_WAVES} waves)`
		);
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log(`\n[QA-633 ${ENGINE}] FINDINGS SUMMARY:`);
		for (const line of findings) console.log(`  ${line}`);
	});

	// ══════════════════════════════════════════════════════════════════════════════════════
	// ARMED-ORACLE PRECONDITION — must hold before any characterization test below is meaningful.
	// An unarmed oracle producing a green run is worthless (QA-772/QA-774): verify, independently,
	// that MinRepro's rows actually span >1 on-disk sorted run, both via the filesystem and via
	// RocksDB's own level-0 file count on the index CF actually exercised by the reads below.
	// ══════════════════════════════════════════════════════════════════════════════════════

	test('ORACLE PRECONDITION: filesystem shows multiple .sst files under the schema dataRootDir', () => {
		ok(dataRootDir, 'ctx.harper.dataRootDir must be set');
		const { total, byDir } = countSstFiles(join(dataRootDir, 'database', DATABASE_NAME));
		console.log(`[QA-633] .sst files under database/${DATABASE_NAME}: total=${total}`, byDir);
		ok(
			total > 1,
			`ARMED-ORACLE PRECONDITION FAILED: expected >1 .sst file across ${DATABASE_NAME}'s column families, found ${total} — ` +
				`the flush-forced sorted-run oracle is NOT armed; every result below would be meaningless. Aborting loudly.`
		);
	});

	test('ORACLE PRECONDITION: RocksDB levelstats show >1 on-disk sorted run on MinRepro.repositoryId index CF', async () => {
		const r = await fetchWithTimeout(`${httpURL}/IndexStats/?table=MinRepro&attribute=repositoryId`, {
			headers: { Authorization: authHeader },
		});
		strictEqual(r.status, 200, `IndexStats(MinRepro) should return 200, got ${r.status}`);
		const body = (await r.json()) as { index: { l0Files: number | null; levelStats: string } };
		const sortedRuns = typeof body.index.levelStats === 'string' ? countSortedRuns(body.index.levelStats) : 0;
		console.log(
			`[QA-633] MinRepro index(repositoryId) levelstats: ${JSON.stringify(body.index)} -> sortedRuns=${sortedRuns}`
		);
		ok(
			sortedRuns > 1,
			`ARMED-ORACLE PRECONDITION FAILED: expected MinRepro's repositoryId index CF to show >1 on-disk sorted run ` +
				`(L0 files + populated levels beyond L0), got ${sortedRuns} from ${JSON.stringify(body.index)} — ` +
				`the flush-forced sorted-run oracle is NOT armed. Aborting loudly.`
		);
	});

	// ══════════════════════════════════════════════════════════════════════════════════════
	// QUESTION 1 — MINIMAL REPRO
	// ══════════════════════════════════════════════════════════════════════════════════════

	test('Q1 control: DrainOwn full-scan (both reads) returns full count at final state — oracle discriminates', async () => {
		const last = (sweepResults[sweepResults.length - 1] as any).fullControl as number[];
		const lastExpected = sweepResults[sweepResults.length - 1].expected;
		const lastWave = sweepResults[sweepResults.length - 1].wave;
		strictEqual(last[0], lastExpected, `full-scan read#1 @wave=${lastWave} expected ${lastExpected}, got ${last[0]}`);
		strictEqual(last[1], lastExpected, `full-scan read#2 @wave=${lastWave} expected ${lastExpected}, got ${last[1]}`);
	});

	test('Q1: DrainOwn(index) first read is always correct at every checkpoint (position-1 baseline)', async () => {
		for (const r of sweepResults) {
			strictEqual(
				r.ownReads[0],
				r.expected,
				`wave=${r.wave}: index read #1 (first in request) expected ${r.expected}, got ${r.ownReads[0]}`
			);
		}
	});

	test('Q1: MINIMAL REPRO — single-table, second-in-request index read (no other table involved)', async () => {
		// This is the core minimal-repro probe: same table, same key, same request, 2nd read.
		// EXPECTED to start failing at the smallest wave count where MinRepro's rows for
		// DRAIN_KEY span >1 sorted run — that wave number IS the answer to "what's the
		// minimal number of sorted runs/rows that triggers it" and whether 2 is enough.
		for (const r of sweepResults) {
			strictEqual(
				r.ownReads[1],
				r.expected,
				`wave=${r.wave}: index read #2 (SAME table, SAME request) expected ${r.expected}, got ${r.ownReads[1]} — ` +
					`if this fails, a SINGLE table's own repeat read already reproduces F-158 at wave=${r.wave} ` +
					`(no second table needed); see FINDINGS SUMMARY / IndexStats log for the sorted-run count at this point`
			);
		}
	});

	test('Q1 cross-table: MinReproB,MinRepro (index) — order check at matching wave scale', async (t) => {
		if (!minReproBAvailable)
			return t.skip('MinReproB seeding did not complete this run (write-stall) — see FINDINGS SUMMARY');
		const r = await fetchWithTimeout(`${httpURL}/Drain/?tables=MinReproB,MinRepro&scan=index&key=${DRAIN_KEY}`, {
			headers: { Authorization: authHeader },
		});
		const counts = ((await r.json()) as { counts: Record<string, number> }).counts;
		log(`cross-table Drain(MinReproB,MinRepro,index) -> ${JSON.stringify(counts)}`);
		strictEqual(
			counts.MinReproB,
			EXPECTED_FINAL,
			`MinReproB (first, indexed) expected ${EXPECTED_FINAL}, got ${counts.MinReproB}`
		);
		strictEqual(
			counts.MinRepro,
			EXPECTED_FINAL,
			`MinRepro (second, indexed) expected ${EXPECTED_FINAL}, got ${counts.MinRepro} — cross-table order defect check`
		);
	});

	test('Q1 cross-table control: MinReproB,MinRepro (full scan) — proves the oracle discriminates', async (t) => {
		if (!minReproBAvailable)
			return t.skip('MinReproB seeding did not complete this run (write-stall) — see FINDINGS SUMMARY');
		const r = await fetchWithTimeout(`${httpURL}/Drain/?tables=MinReproB,MinRepro&scan=full&key=${DRAIN_KEY}`, {
			headers: { Authorization: authHeader },
		});
		const counts = ((await r.json()) as { counts: Record<string, number> }).counts;
		log(`cross-table Drain(MinReproB,MinRepro,full) -> ${JSON.stringify(counts)}`);
		strictEqual(
			counts.MinReproB,
			EXPECTED_FINAL,
			`MinReproB (first, full scan) expected ${EXPECTED_FINAL}, got ${counts.MinReproB}`
		);
		strictEqual(
			counts.MinRepro,
			EXPECTED_FINAL,
			`MinRepro (second, full scan) expected ${EXPECTED_FINAL}, got ${counts.MinRepro}`
		);
	});

	// ══════════════════════════════════════════════════════════════════════════════════════
	// QUESTION 3 — WRITE / COUNT REACH (probed BEFORE compaction so the defect is still live)
	// ══════════════════════════════════════════════════════════════════════════════════════

	test('Q3a: SQL COUNT aggregate — dual-subquery over MinReproB then MinRepro, one HTTP request', async (t) => {
		if (!minReproBAvailable)
			return t.skip('MinReproB seeding did not complete this run (write-stall) — see FINDINGS SUMMARY');
		// QA-774: derived-table subqueries in FROM are NOT supported by Harper's current SQL
		// validator on this SHA — sqlTranslator/SelectValidator.ts's validateTable() throws
		// "schema not defined for table undefined" for ANY FROM-clause subquery (comma-joined or
		// explicit CROSS JOIN, schema-qualified or not), independent of F-158 and independent of
		// this fixture's data. This is a pre-existing, separately-characterized SQL-engine gap —
		// see qa637-f158-sql-reach.test.ts (shape1/1b), which also found UNION ALL silently drops
		// a row (shape3) and WHERE...IN subqueries throw "Circular reference" (shape4): there is
		// no confirmed-working single-statement shape for two independent per-table COUNT(*)s.
		// Skip rather than force a workaround for an unrelated defect family; the solo-SQL control
		// below still proves SQL COUNT works correctly for a single table post-seed.
		return t.skip(
			'Harper SQL has no supported FROM-clause derived-table shape for two independent COUNT(*) subqueries on this SHA ' +
				'(see qa637-f158-sql-reach.test.ts) — unrelated to F-158, not exercised here'
		);
	});

	test('Q3a control: solo SQL COUNT over MinRepro alone (single statement, no prior table touch) — must be correct', async () => {
		const sql = `SELECT COUNT(*) AS cnt FROM f158bounds.MinRepro WHERE repositoryId = '${DRAIN_KEY}'`;
		const r = await request(opsURL)
			.post('')
			.set({ 'Authorization': authHeader, 'Content-Type': 'application/json' })
			.send(JSON.stringify({ operation: 'sql', sql }))
			.timeout(60_000);
		const row = Array.isArray(r.body) ? r.body[0] : r.body;
		log(`Q3a control solo SQL COUNT(MinRepro) cnt=${row?.cnt} (expected ${EXPECTED_FINAL})`);
		strictEqual(
			Number(row?.cnt),
			EXPECTED_FINAL,
			`solo SQL COUNT(MinRepro) expected ${EXPECTED_FINAL}, got ${row?.cnt}`
		);
	});

	test('Q3b: UpsertViaIndex — does the read-side 0-row miss cause a durable WRONG WRITE?', async (t) => {
		if (!minReproBAvailable)
			return t.skip('MinReproB seeding did not complete this run (write-stall) — see FINDINGS SUMMARY');
		const r = await fetchWithTimeout(`${httpURL}/UpsertViaIndex/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
			body: JSON.stringify({ decoyTable: 'MinReproB', table: 'MinRepro', key: DRAIN_KEY, marker: 'q3b' }),
		});
		ok(r.status === 200, `UpsertViaIndex should return 200, got ${r.status}`);
		const body = (await r.json()) as { decoyCount: number; existing: number; wroteMarker: boolean; markerId: string };
		log(`Q3b UpsertViaIndex(decoy=MinReproB,target=MinRepro,key=${DRAIN_KEY}) -> ${JSON.stringify(body)}`);

		// Positive control: verify via a full scan (independent of the index) whether MinRepro
		// actually already had rows for DRAIN_KEY at the time of the guard check.
		const controlR = await fetchWithTimeout(`${httpURL}/DrainOwn/?table=MinRepro&key=${DRAIN_KEY}&reads=1&scan=full`, {
			headers: { Authorization: authHeader },
		});
		const control = (await controlR.json()) as { counts: number[] };
		log(`Q3b full-scan control (post-write) MinRepro[${DRAIN_KEY}] count=${control.counts[0]}`);
		ok(
			control.counts[0] >= EXPECTED_FINAL,
			`full-scan control should show >=${EXPECTED_FINAL} pre-existing rows for ${DRAIN_KEY}, got ${control.counts[0]}`
		);

		strictEqual(
			body.wroteMarker,
			false,
			`UpsertViaIndex wrote a DUPLICATE marker row (${body.markerId}) despite ${control.counts[0]} rows already existing for ${DRAIN_KEY} ` +
				`(index lookup reported existing=${body.existing}) — F-158's read-side 0-row miss CAUSED A DURABLE WRONG WRITE`
		);
	});

	// ══════════════════════════════════════════════════════════════════════════════════════
	// QUESTION 2 — COMPACTION HEAL (run LAST: mutates MinRepro's on-disk state)
	// ══════════════════════════════════════════════════════════════════════════════════════

	test('Q2: COMPACTION HEAL — manual compact() on primary + index CFs, then re-check the ACTUAL cross-table defect', async (t) => {
		if (!minReproBAvailable)
			return t.skip('MinReproB seeding did not complete this run (write-stall) — see FINDINGS SUMMARY');
		// Re-establish the pre-compact baseline using the SAME cross-table probe that showed
		// the defect above (Q1 cross-table: MinRepro short at position 2) — DrainOwn's
		// self-repeat pattern never showed a miss in this harness, so re-checking it here
		// would prove nothing about healing.
		const preR = await fetchWithTimeout(`${httpURL}/Drain/?tables=MinReproB,MinRepro&scan=index&key=${DRAIN_KEY}`, {
			headers: { Authorization: authHeader },
		});
		const preCounts = ((await preR.json()) as { counts: Record<string, number> }).counts;
		const oracleR = await fetchWithTimeout(`${httpURL}/Drain/?tables=MinReproB,MinRepro&scan=full&key=${DRAIN_KEY}`, {
			headers: { Authorization: authHeader },
		});
		const oracleCounts = ((await oracleR.json()) as { counts: Record<string, number> }).counts;
		log(
			`Q2 pre-compact cross-table Drain(index)=${JSON.stringify(preCounts)} oracle(full)=${JSON.stringify(oracleCounts)}`
		);

		const preStatsR = await fetchWithTimeout(`${httpURL}/IndexStats/?table=MinRepro&attribute=repositoryId`, {
			headers: { Authorization: authHeader },
		});
		log(`Q2 pre-compact IndexStats: ${JSON.stringify(await preStatsR.json())}`);

		// Compact BOTH tables' primary + index CFs — the defect involves the read ORDER across
		// two tables, so healing only the "victim" (second-position) table's stores may not be
		// sufficient; compact everything touched by the cross-table probe.
		const compactResults: Record<string, unknown> = {};
		for (const table of ['MinReproB', 'MinRepro']) {
			const compactR = await fetchWithTimeout(`${httpURL}/CompactTable/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ table }),
			});
			ok(compactR.status === 200, `CompactTable(${table}) should return 200, got ${compactR.status}`);
			compactResults[table] = await compactR.json();
		}
		log(`Q2 CompactTable results -> ${JSON.stringify(compactResults)}`);

		const postStatsR = await fetchWithTimeout(`${httpURL}/IndexStats/?table=MinRepro&attribute=repositoryId`, {
			headers: { Authorization: authHeader },
		});
		log(`Q2 post-compact IndexStats: ${JSON.stringify(await postStatsR.json())}`);

		const postR = await fetchWithTimeout(`${httpURL}/Drain/?tables=MinReproB,MinRepro&scan=index&key=${DRAIN_KEY}`, {
			headers: { Authorization: authHeader },
		});
		const postCounts = ((await postR.json()) as { counts: Record<string, number> }).counts;
		log(
			`Q2 post-compact cross-table Drain(index)=${JSON.stringify(postCounts)} (oracle expects ${JSON.stringify(oracleCounts)})`
		);

		const anyCompactUnreachable = Object.values(compactResults).some((body: any) =>
			Object.values(body?.results || {}).some((v) => typeof v === 'string' && v.startsWith('unreachable'))
		);
		ok(
			!anyCompactUnreachable,
			`compact() should be reachable on a RocksDB store; results=${JSON.stringify(compactResults)}`
		);

		strictEqual(
			postCounts.MinRepro,
			oracleCounts.MinRepro,
			`COMPACTION HEAL CHECK: post-compact cross-table index read for MinRepro (2nd position) = ${postCounts.MinRepro}, ` +
				`oracle (full scan) = ${oracleCounts.MinRepro} — pre-compact it was ${preCounts.MinRepro} ` +
				`(short by ${oracleCounts.MinRepro - preCounts.MinRepro}); if post-compact still short, manual compaction ` +
				`does NOT heal F-158 in this harness`
		);
	});
});
