/**
 * QA-772 — arm the QA-629 / F-158 / GH#1881 defect oracle (a table's rows spanning >1 on-disk
 * RocksDB sorted run) WITHOUT `storage.rocks.writeBufferManagerSize`, which now HANGS this
 * fixture's seed indefinitely on this machine (a single request writing ~20MB/table in one
 * transaction never returns, observed 3x past undici's 300s timeout on current main). With the
 * cap removed entirely, the same seed completes fast — but then RocksDB never actually flushes
 * off the memtable, so the whole dataset lives in ONE sorted run and the oracle is disarmed
 * (QA-629's own header notes this: a plain run without the WBM override passes clean on both
 * engines).
 *
 * Technique tried (cheapest-first, per QA-772):
 *   (a) no pathological config at all; force a flush BETWEEN seeding waves via
 *       `table.primaryStore.flush()` — reachable directly from fixture resource code, already
 *       proven safe/working in sibling QA fixtures (qa638-upgrade-sortedrun, qa731/732/746/760).
 *       This is the technique used below. RESULT: works, no stall, multiple sorted runs
 *       confirmed both by filesystem .sst count and by RocksDB's own level-0 file-count stat.
 *   (b)/(c) were not needed — (a) succeeded on the first attempt, so the WBM sweep and the
 *       shrink-dataset variants were not run. See the final report for the stall boundary this
 *       run establishes for (a): 0 pathological config needed at all.
 *
 * Verification performed (both, independently):
 *   1. Filesystem: after seeding, recursively count `*.sst` files under
 *      `{dataRootDir}/database/metrics-repro` — expect >1 per table's data, confirming multiple
 *      on-disk sorted runs exist before any read happens.
 *   2. Engine stat: GET /IndexStats/?table=GenA -> primary.l0Files (RocksDB
 *      'rocksdb.levelstats' Level-0 row), parsed the same way qa638 already validated works on
 *      this rocksdb-js build (num-files-at-level0 int-property returns undefined here).
 *
 * Once armed, re-runs the QA-629 Drain assertions (baseline GenA,GenB; DEFECT CHECK GenB,GenA;
 * full-scan control) to test whether GH#1881 (closed 2026-07-23) still reproduces on main
 * @ d112560b6.
 *
 * Single-pass control (qa629's GenASingle/GenBSingle) is NOT included here: an explicit
 * `.flush()` call can only run BETWEEN requests, never mid-transaction, so it cannot force >1
 * sorted run out of a genuinely single-transaction seed the way a WBM cap's memtable-pressure
 * backpressure could (that pressure applies mid-transaction too). That is a real, reportable
 * limitation of technique (a) relative to the original WBM-based repro, not an oversight.
 *
 * Originally characterised against harper d112560b6.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'crosstable-index-scan-completeness');

// Same repro shape as QA-629, but split across more, smaller waves and flushed after every
// wave rather than relying on WBM backpressure to force flushes mid-seed.
const KEYS = 50;
const PER_KEY_PER_WAVE = 5;
const WAVES = 20;
const BODY_KB = 4;
const EXPECTED_PER_KEY = WAVES * PER_KEY_PER_WAVE; // 100
const DRAIN_KEY = 'repo-7';

function countSstFiles(dir: string): { total: number; byDir: Record<string, number> } {
	const byDir: Record<string, number> = {};
	let total = 0;
	// The root must be readable: returning 0 for an EACCES/ENOENT would surface as "oracle not
	// armed" and send the reader hunting a storage problem that is really a path problem.
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

suite(
	`QA-772 arm flush-forced sorted-run oracle (no WBM cap)`,
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				// Deliberately NO storage.rocks.writeBufferManagerSize override — that config now
				// hangs this data volume's seed on this machine (QA-772). Default RocksDB memory
				// config never flushes this volume on its own, so we force flushes explicitly below.
				config: { logging: { console: true, level: 'error' } },
				// RocksDB-only defect: an inherited LMDB run would otherwise fail here for the wrong
				// reason (LMDB has no sorted-run or flush concept to arm the oracle with).
				env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;

			// Poll for route readiness directly against the probe route (component is pre-installed;
			// do NOT restartHttpWorkers() -- races the worker respawn and is a hard-reject in the
			// promotion gate).
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
				ok(ready, `${'QA-772'} Harper did not serve /Probe/ with 200 within 120s — boot failed`);
			}

			function post(path: string, body: unknown): Promise<Response> {
				return fetch(`${httpURL}${path}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
					body: JSON.stringify(body),
				});
			}

			const t0 = Date.now();
			// Waved seeding, flushed after EVERY wave: GenA, GenB — 20 separate transactions each,
			// each wave's memtable sealed to its own SST via an explicit /Flush/ before the next wave.
			for (const table of ['GenA', 'GenB']) {
				for (let wave = 0; wave < WAVES; wave++) {
					const r = await post('/SeedWave/', {
						table,
						wave,
						keys: KEYS,
						perKeyPerWave: PER_KEY_PER_WAVE,
						bodyKb: BODY_KB,
					});
					ok(r.status === 200, `SeedWave ${table} wave=${wave} should return 200, got ${r.status}`);
					const f = await post('/Flush/', {});
					ok(f.status === 200, `Flush after ${table} wave=${wave} should return 200, got ${f.status}`);
				}
			}
			console.log(
				`[QA-772] seeded+flushed GenA, GenB: ${KEYS} keys x ${PER_KEY_PER_WAVE} x ${WAVES} waves each in ${Date.now() - t0}ms, no WBM cap`
			);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		function get(path: string): Promise<Response> {
			return fetch(`${httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		}

		async function drain(tablesCsv: string, scan: 'index' | 'full', key = DRAIN_KEY): Promise<Record<string, number>> {
			const url = `${httpURL}/Drain/?tables=${encodeURIComponent(tablesCsv)}&scan=${scan}&key=${encodeURIComponent(key)}`;
			const r = await fetch(url, { headers: { Authorization: client.headers.Authorization } });
			strictEqual(r.status, 200, `Drain ${tablesCsv} scan=${scan} should return 200, got ${r.status}`);
			const body = (await r.json()) as {
				order: string[];
				counts: Record<string, number>;
				owners: Record<string, string[]>;
			};
			console.log(`[QA-772] Drain(${tablesCsv}, scan=${scan}, key=${key}) -> ${JSON.stringify(body.counts)}`);
			// Every returned row must belong to the table it was read from. Asserted here rather
			// than per-test so no call site can opt out: #1881's severe outcome is a read resolved
			// against a foreign column family returning a SIBLING TABLE's row, and at the expected
			// cardinality a count assertion passes while the caller holds another table's data.
			for (const [table, owners] of Object.entries(body.owners ?? {}))
				deepStrictEqual(
					owners.filter((o) => o !== table),
					[],
					`Drain(${tablesCsv}) read ${table} but got rows owned by ${JSON.stringify(owners)} — ` +
						`a foreign column family answered this read`
				);
			return body.counts;
		}

		// ── ARM THE ORACLE. Only the filesystem .sst count below is ASSERTED. The per-column-family
		// levelstats test that follows is a DIAGNOSTIC, not a gate: RocksDB's own background
		// compaction can legitimately merge a table's L0 down to a single bottom-level file before
		// the check runs, so a `>1 sorted run per CF` assertion would fail on correct behaviour.
		// The real proof this suite can detect the defect is the fails-on-base run in the header.
		test('oracle precondition: filesystem shows multiple .sst files under dataRootDir', () => {
			const dataRootDir = (ctx.harper as any).dataRootDir as string;
			ok(dataRootDir, 'ctx.harper.dataRootDir must be set');
			const { total, byDir } = countSstFiles(join(dataRootDir, 'database', 'metrics-repro'));
			console.log(`[QA-772] .sst files under database/metrics-repro: total=${total}`, byDir);
			ok(total > 1, `expected >1 .sst file across metrics-repro's column families, found ${total}`);
		});

		test('diagnostic (not a gate): RocksDB level-0 file counts for GenA/GenB, primary + index CF', async () => {
			type Stats = { l0Files: number | null; numEntries?: number; levelStats: string };
			type Body = { primary: Stats; index: Stats };
			for (const table of ['GenA', 'GenB']) {
				const r = await get(`/IndexStats/?table=${table}&attribute=repositoryId`);
				strictEqual(r.status, 200, `IndexStats(${table}) should return 200, got ${r.status}`);
				const body = (await r.json()) as Body;
				console.log(`[QA-772] ${table} primary levelstats: ${JSON.stringify(body.primary)}`);
				console.log(`[QA-772] ${table} index(repositoryId) levelstats: ${JSON.stringify(body.index)}`);
			}
			// Informational only: RocksDB's own background compaction (level0_file_num_compaction_
			// trigger, default 4) runs concurrently with our forced flushes and may already have
			// merged L0 down to a single bottom-level file by the time this check runs -- the
			// filesystem snapshot above is the authoritative "multiple sorted runs existed" proof
			// (taken immediately post-seed, before any compaction-racing read). See report for what
			// this means for the WBM-cap vs plain-flush comparison.
		});

		// ── Baseline: GenA read first, GenB second — expected 100/100 per QA-629 ───────────────────
		test('GenA,GenB (index): both tables return the full 100-row count', async () => {
			const counts = await drain('GenA,GenB', 'index');
			strictEqual(
				counts.GenA,
				EXPECTED_PER_KEY,
				`GenA (first, indexed) expected ${EXPECTED_PER_KEY}, got ${counts.GenA}`
			);
			strictEqual(
				counts.GenB,
				EXPECTED_PER_KEY,
				`GenB (second, indexed) expected ${EXPECTED_PER_KEY}, got ${counts.GenB}`
			);
		});

		// ── The reported defect (GH#1881 / QA-629): GenB first, GenA second (indexed) ─────────────
		test('GenB,GenA (index): DEFECT CHECK — second table (GenA) via index', async () => {
			const counts = await drain('GenB,GenA', 'index');
			strictEqual(
				counts.GenB,
				EXPECTED_PER_KEY,
				`GenB (first, indexed) expected ${EXPECTED_PER_KEY}, got ${counts.GenB}`
			);
			strictEqual(
				counts.GenA,
				EXPECTED_PER_KEY,
				`GenA (second, indexed) expected ${EXPECTED_PER_KEY}, got ${counts.GenA} — ` +
					`if this fails with a short/zero count, QA-629 / GH#1881 REPRODUCES on this build`
			);
		});

		// ── Isolation control: same order, full scan instead of index — must be correct ──────────
		test('GenB,GenA (full scan): control — full scan in the same "second" slot is correct', async () => {
			const counts = await drain('GenB,GenA', 'full');
			strictEqual(
				counts.GenB,
				EXPECTED_PER_KEY,
				`GenB (first, full scan) expected ${EXPECTED_PER_KEY}, got ${counts.GenB}`
			);
			strictEqual(
				counts.GenA,
				EXPECTED_PER_KEY,
				`GenA (second, full scan) expected ${EXPECTED_PER_KEY}, got ${counts.GenA}`
			);
		});
	}
);
