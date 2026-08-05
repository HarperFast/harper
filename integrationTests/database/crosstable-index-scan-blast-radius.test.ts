/**
 * QA-631 — F-158 (GH #1881) blast-radius characterization. GH#1881 CLOSED/FIXED 2026-07-23.
 *
 * F-158 (confirmed HIGH pre-fix, RocksDB-only, see qa629-crosstable-index-miss.test.ts): when a
 * request reads TWO tables where the second is read via a SECONDARY INDEX, and that table's
 * rows for the queried slot span MORE THAN ONE flushed on-disk sorted run, the secondary-index
 * scan returns 0 rows even though the data is fully intact (full-scan of the same slot returns
 * everything).
 *
 * FAILS-ON-BASE (measured 2026-08-03): with @harperfast/rocksdb-js pinned to 2.4.0 (the last
 * pre-fix release; #1881 shipped in 2.5.0) this suite goes RED on three tests — `Q1 SPREAD`,
 * `Q3 no-heal control` and `Q3 HEAL`. Note that the full-scan positive control running earlier
 * in the file does NOT immunise these: a full scan warms the PRIMARY column family, and the
 * defect lives in the index-CF read path. Re-verify after any change to seeding or test order.
 *
 * QA-774 (this file): converts the original stalled RED candidate into a shipped-fix regression
 * anchor. The ORIGINAL repro forced multiple sorted runs via
 * `storage.rocks.writeBufferManagerSize: 8388608`; on this machine that cap now HANGS this
 * fixture's ~40MB/table seed indefinitely. Per QA-772, the WBM cap is dropped ENTIRELY and
 * replaced with an explicit `table.primaryStore.flush()` call (a `/Flush/` fixture resource)
 * between seeding waves — RocksDB's flush is atomic across every column family sharing the
 * schema directory, so one flush() after each wave seals that wave into its own SST for the
 * primary AND every index CF, across all four tables.
 *
 * ALSO CHANGED: `restartHttpWorkers()` was removed in favor of a plain readiness poll against
 * `/Probe/` (component is pre-installed; restarting races the worker respawn and flakes on CI —
 * see qa772-flush-forcing.test.ts, which has the proven-correct poll).
 *
 * This file still characterizes the same three blast-radius questions (Q1 SPREAD, Q2 ORDINARY
 * REST-CLIENT REACH, Q3 FULL-SCAN HEAL) from a 4-table harness (TableA..TableD, db
 * "qa631-blast"), but the assertions now encode the EXPECTED-FIXED (correct, full-count)
 * behavior rather than the pre-fix defect signature — this is a regression anchor, not a defect
 * characterization. Failure messages retain the historical defect signature (0 for a clean
 * miss, 10 for the partial degradation seen at position 4, pre-fix) so a regression is easy to
 * recognize.
 *
 * Oracle arming (explicit precondition, asserted below): filesystem `.sst` file count under the
 * schema's dataRootDir > 1. `rocksdb.levelstats` is logged only: compaction can legitimately
 * move Level-0 files to a lower level before it is sampled.
 *
 * Harper SHA under test: d112560b6 (main). Engine: RocksDB only (this technique relies on
 * `primaryStore.flush()`, a RocksDB-only API; LMDB confirmed clean by qa629 — no LSM/sorted-run
 * structure — not re-tested here).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'crosstable-index-scan-blast-radius');

// Same volume as qa629's confirmed repro, waved + flushed per QA-772's technique.
const KEYS = 50;
const PER_KEY_PER_WAVE = 5;
const WAVES = 20;
const BODY_KB = 4;
const EXPECTED_PER_KEY = WAVES * PER_KEY_PER_WAVE; // 100
const DRAIN_KEY = 'repo-7';
const TABLES = ['TableA', 'TableB', 'TableC', 'TableD'];

interface DrainStep {
	table: string;
	scan: 'index' | 'full';
	count: number;
	owners: string[];
}

function countSstFiles(dir: string): { total: number; byDir: Record<string, number> } {
	const byDir: Record<string, number> = {};
	let total = 0;
	// The root must be readable: returning 0 for an EACCES/ENOENT surfaces as "oracle not armed"
	// and sends the reader after a storage problem that is really a path problem.
	readdirSync(dir);
	function walk(d: string) {
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return; // a column-family dir removed mid-walk by compaction is expected
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

interface OracleStats {
	sstTotal: number;
	sstByDir: Record<string, number>;
}

suite('QA-631 F-158 blast-radius [rocksdb]', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let oracle: OracleStats;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			// Deliberately NO storage.rocks.writeBufferManagerSize override — that config now hangs
			// this data volume's seed on this machine (QA-772). We force flushes explicitly below.
			config: { logging: { console: true, level: 'error' } },
			env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;

		// Poll for route readiness directly against the probe route (component is pre-installed;
		// do NOT restartHttpWorkers() -- races the worker respawn and flakes on CI).
		{
			const deadline = Date.now() + 120_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Probe/').timeout(2000);
					if (probe.status === 200) {
						ready = true;
						break; // 500/503 during boot is NOT ready
					}
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
			assert.ok(ready, 'QA-631 Harper did not serve /Probe/ with 200 within 120s — boot failed');
		}

		function post(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
			});
		}

		const t0 = Date.now();
		oracle = { sstTotal: 0, sstByDir: {} };
		type Stats = { l0Files: number | null; numEntries?: number; levelStats: string };
		type Body = { primary: Stats; index: Stats };

		// Waved seeding across all 4 tables, flushed after EVERY wave: 20 separate transactions
		// each, each wave's memtable sealed to its own SST via an explicit /Flush/ before the next.
		// On the LAST wave for each table, the Flush call also requests levelstats for that table
		// IN THE SAME SERVER-SIDE CALL, immediately after flush() resolves -- a separate
		// /IndexStats/ GET afterward incurs an extra HTTP round-trip, which is empirically enough
		// scheduling time for RocksDB's background compaction thread to merge L0 away first (with
		// 20 waves and the default level0_file_num_compaction_trigger=4, L0 lands on a 20 % 4 === 0
		// boundary right when the last flush completes, so any added delay risks reading
		// post-compaction state instead of the pre-compaction sorted-run count).
		for (const table of TABLES) {
			for (let wave = 0; wave < WAVES; wave++) {
				const r = await post('/SeedWave/', {
					table,
					wave,
					keys: KEYS,
					perKeyPerWave: PER_KEY_PER_WAVE,
					bodyKb: BODY_KB,
				});
				assert.ok(r.status === 200, `SeedWave ${table} wave=${wave} should return 200, got ${r.status}`);
				const isLastWave = wave === WAVES - 1;
				const f = await post('/Flush/', isLastWave ? { statsFor: [{ table, attribute: 'repositoryId' }] } : {});
				assert.ok(f.status === 200, `Flush after ${table} wave=${wave} should return 200, got ${f.status}`);
				if (isLastWave) {
					const fBody = (await f.json()) as { stats: Record<string, Body> };
					const body = fBody.stats[table];
					console.log(`[QA-631] ${table} primary levelstats: ${JSON.stringify(body.primary)}`);
					console.log(`[QA-631] ${table} index(repositoryId) levelstats: ${JSON.stringify(body.index)}`);
				}
			}
		}
		console.log(
			`[QA-631] seeded+flushed ${TABLES.join(', ')}: ${KEYS} keys x ${PER_KEY_PER_WAVE} x ${WAVES} waves each in ${Date.now() - t0}ms, no WBM cap`
		);

		// Filesystem .sst count is NOT compaction-sensitive the same way (compaction moves rows to
		// a different level's file, it doesn't collapse below 1 file until fully merged to a single
		// bottom-level SST) -- safe to take after all tables finish.
		const dataRootDir = (ctx.harper as any).dataRootDir as string;
		assert.ok(dataRootDir, 'ctx.harper.dataRootDir must be set');
		const { total, byDir } = countSstFiles(join(dataRootDir, 'database', 'qa631-blast'));
		oracle.sstTotal = total;
		oracle.sstByDir = byDir;
		console.log(`[QA-631] .sst files under database/qa631-blast: total=${total}`, byDir);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function drain(steps: string, key = DRAIN_KEY): Promise<DrainStep[]> {
		const url = `${httpURL}/Drain/?steps=${encodeURIComponent(steps)}&key=${encodeURIComponent(key)}`;
		const r = await fetch(url, { headers: { Authorization: client.headers.Authorization } });
		assert.strictEqual(r.status, 200, `Drain steps=${steps} should return 200, got ${r.status}`);
		const body = (await r.json()) as { steps: DrainStep[]; key: string };
		console.log(`[QA-631] Drain(steps=${steps}, key=${key}) -> ${JSON.stringify(body.steps)}`);
		// Every returned row must belong to the table it was read from. Asserted here rather than
		// per-test so no call site can opt out: #1881's severe outcome is a read resolved against a
		// foreign column family returning a SIBLING TABLE's row, and at the expected cardinality a
		// count assertion passes while the caller holds another table's data.
		// Assert the shape rather than defaulting it: `body?.steps ?? []` would make this ownership
		// check iterate NOTHING on a malformed response and pass silently, which is the vacuity
		// this assertion exists to remove.
		assert.ok(Array.isArray(body.steps), `Drain(${steps}) returned no steps array — cannot verify row ownership`);
		const requestedTables = steps.split(',').map((step) => step.trim().split(':')[0]);
		assert.deepStrictEqual(
			body.steps.map((step) => step.table),
			requestedTables,
			`Drain(${steps}) returned steps that do not cover the requested tables`
		);
		for (const step of body.steps) {
			assert.ok(Array.isArray(step.owners), `Drain(${steps}) returned no owners for ${step.table}`);
			assert.deepStrictEqual(
				step.owners.filter((owner) => owner !== step.table),
				[],
				`Drain(${steps}) read ${step.table} but got rows owned by ${JSON.stringify(step.owners)} — ` +
					`a foreign column family answered this read`
			);
		}
		return body.steps;
	}

	// ── ARM THE ORACLE (hard, loud gate): >1 .sst file. If this fails, every test below is
	// meaningless — the multi-sorted-run precondition never held and a green result would NOT be
	// evidence the fix holds.
	test('oracle precondition ARMED: >1 .sst file', () => {
		assert.ok(
			oracle.sstTotal > 1,
			`UNARMED ORACLE: expected >1 .sst file across qa631-blast's column families, found ${oracle.sstTotal} — ` +
				`the flush-forced multi-sorted-run precondition did NOT hold; any green result below is WORTHLESS`
		);
	});

	// ── Q2 baseline: plain ordinary REST GET, BEFORE any internal Drain call has touched any
	// table in this run — the "nothing has happened yet" anchor for the Q2 comparison below.
	test('Q2 anchor: plain REST GET, first-ever read of the run, returns the full count', async () => {
		const r = await client.reqRest(`/TableA/?repositoryId=${DRAIN_KEY}&limit(0,500)`);
		assert.strictEqual(r.status, 200, `GET /TableA/?repositoryId=... should return 200, got ${r.status}`);
		const rows = r.body as unknown[];
		console.log(`[QA-631] REST anchor GET /TableA/?repositoryId=${DRAIN_KEY} -> ${rows.length} rows`);
		assert.strictEqual(
			rows.length,
			EXPECTED_PER_KEY,
			`TableA REST anchor read expected ${EXPECTED_PER_KEY}, got ${rows.length}`
		);
	});

	// ── Positive control (required): full-scan of all 4 tables in ONE request must return the
	// full count for every table — proves the data is fully intact and the oracle discriminates.
	test('positive control: full-scan of all 4 tables in one request returns the full count', async () => {
		const steps = await drain('TableA:full,TableB:full,TableC:full,TableD:full');
		for (const s of steps) {
			assert.strictEqual(
				s.count,
				EXPECTED_PER_KEY,
				`${s.table} full-scan expected ${EXPECTED_PER_KEY}, got ${s.count}`
			);
		}
	});

	// ── Q1 SPREAD: A full-scan (position 1), then B, C, D via secondary index (positions 2,3,4)
	// in ONE request. Pre-fix, B/C came back clean-0 and D came back partial (10/100). Post-fix,
	// all three should return the full count — a regression would reproduce one of those exact
	// pre-fix signatures.
	test('Q1 SPREAD: A(full)->B,C,D(index) in one request', async () => {
		const steps = await drain('TableA:full,TableB:index,TableC:index,TableD:index');
		const [a, b, c, d] = steps;
		assert.strictEqual(
			a.count,
			EXPECTED_PER_KEY,
			`TableA (position 1, full scan) expected ${EXPECTED_PER_KEY}, got ${a.count}`
		);
		assert.strictEqual(
			b.count,
			EXPECTED_PER_KEY,
			`TableB (position 2, index) expected ${EXPECTED_PER_KEY} now that GH#1881 is fixed — got ${b.count} ` +
				`(0 would match the pre-fix F-158 clean-miss signature: REGRESSION)`
		);
		assert.strictEqual(
			c.count,
			EXPECTED_PER_KEY,
			`TableC (position 3, index) SPREAD CHECK: expected ${EXPECTED_PER_KEY} — got ${c.count} ` +
				`(0 would match the pre-fix spread-miss signature: REGRESSION)`
		);
		assert.strictEqual(
			d.count,
			EXPECTED_PER_KEY,
			`TableD (position 4, index) SPREAD CHECK: expected ${EXPECTED_PER_KEY} — got ${d.count} ` +
				`(10 would match the pre-fix partial-degradation signature seen at position 4: REGRESSION)`
		);
	});

	// ── Q2 REACH: after Q1's Drain call has already exercised index reads across this worker,
	// does a plain ordinary external REST GET on a table also hit the 0-row miss?
	test('Q2 REACH: ordinary REST GET on TableD after prior index-read activity on this worker', async () => {
		const r = await client.reqRest(`/TableD/?repositoryId=${DRAIN_KEY}&limit(0,500)`);
		assert.strictEqual(r.status, 200, `GET /TableD/?repositoryId=... should return 200, got ${r.status}`);
		const rows = r.body as unknown[];
		console.log(`[QA-631] REST reach GET /TableD/?repositoryId=${DRAIN_KEY} -> ${rows.length} rows`);
		assert.strictEqual(
			rows.length,
			EXPECTED_PER_KEY,
			`TableD ordinary REST GET expected ${EXPECTED_PER_KEY} — got ${rows.length}`
		);
	});

	// ── Q3 FULL-SCAN HEAL, no-heal control: A(full) -> B(index). Pre-fix, B (position 2) missed
	// unconditionally; post-fix it should return the full count regardless of any heal touch.
	test('Q3 no-heal control: A(full)->B(index) — expected full count now that the fix holds', async () => {
		const steps = await drain('TableA:full,TableB:index');
		const [a, b] = steps;
		assert.strictEqual(a.count, EXPECTED_PER_KEY, `TableA (position 1) expected ${EXPECTED_PER_KEY}, got ${a.count}`);
		assert.strictEqual(
			b.count,
			EXPECTED_PER_KEY,
			`TableB (position 2, index, no heal touch) expected ${EXPECTED_PER_KEY} — got ${b.count} ` +
				`(0 would match the pre-fix baseline: REGRESSION)`
		);
	});

	// ── Q3 FULL-SCAN HEAL, treatment: A(full) -> B(full, heal touch) -> B(index). Post-fix, the
	// index read should succeed with or without a prior full-scan touch of the same table.
	test('Q3 HEAL: A(full)->B(full, heal touch)->B(index) — expected full count either way', async () => {
		const steps = await drain('TableA:full,TableB:full,TableB:index');
		const [a, bFull, bIndex] = steps;
		assert.strictEqual(a.count, EXPECTED_PER_KEY, `TableA (position 1) expected ${EXPECTED_PER_KEY}, got ${a.count}`);
		assert.strictEqual(
			bFull.count,
			EXPECTED_PER_KEY,
			`TableB (position 2, full-scan heal touch) expected ${EXPECTED_PER_KEY}, got ${bFull.count}`
		);
		assert.strictEqual(
			bIndex.count,
			EXPECTED_PER_KEY,
			`TableB (position 3, index, AFTER heal touch) expected ${EXPECTED_PER_KEY} — got ${bIndex.count} ` +
				`(0 would match the pre-fix no-heal signature: REGRESSION)`
		);
	});
});
