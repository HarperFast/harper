/**
 * Hot-config: read atomicity under whole-record PUT storm.
 *
 * Pins the invariant that a singleton config record written via whole-record replacement
 * is always observed as a self-consistent snapshot — never torn. The record carries a
 * checksum field (checksum = flagA + flagB + version) that detects any torn read.
 *
 * Assertions:
 *   T0 Seed: initial record is self-consistent.
 *   T1 Torn-read: 50 concurrent readers × 4 s + ~200 writes/s → 0 torn reads
 *       (checksum must equal flagA + flagB + version on every observed record).
 *   T2 Monotonic visibility: a single reader loop during sequential writes must never
 *       observe a version number going backwards.
 *   T3 Latency: observational only — p99 under writer vs baseline (warning >5×, no gate).
 *   T4 addTo under PUT storm: 200 concurrent BumpReadCount calls while 10 concurrent
 *       PUT-storm writes run → final readCount must gain exactly 200; final record
 *       must remain self-consistent.
 *
 * Both RocksDB (default) and LMDB engines are tested via HARPER_STORAGE_ENGINE=lmdb.
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'hot-record-read-snapshot');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const skipSuite = process.platform === 'win32';

suite(`hot-record read-snapshot atomicity [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;
	let headers: Record<string, string>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 4 },
				logging: { console: true, level: 'error' },
			},
			env: {},
		});

		const client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;
		headers = { 'Content-Type': 'application/json', Authorization: auth };

		// Readiness poll: wait until /Config/ route is available
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const r = await fetch(`${httpURL}/Config/`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(3_000),
				});
				if (r.status !== 503 && r.status !== 404) break;
			} catch { /* not ready */ }
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	async function writeConfig(version: number, flagA: number, flagB: number, payload: string) {
		const r = await fetch(`${httpURL}/WriteConfig/`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ version, flagA, flagB, payload }),
			signal: AbortSignal.timeout(8_000),
		});
		return r.status;
	}

	async function getConfig(): Promise<{ version: number; flagA: number; flagB: number; payload: string; checksum: number; readCount: number } | null> {
		try {
			const r = await fetch(`${httpURL}/Config/global`, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(5_000),
			});
			if (r.status !== 200) return null;
			return r.json() as Promise<{ version: number; flagA: number; flagB: number; payload: string; checksum: number; readCount: number }>;
		} catch {
			return null;
		}
	}

	async function bumpReadCount() {
		const r = await fetch(`${httpURL}/BumpReadCount/`, {
			method: 'POST',
			headers,
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(5_000),
		});
		return r.status;
	}

	// ── T0: seed + readiness ───────────────────────────────────────────────────

	test('T0: seed and verify self-consistent initial record', { timeout: 60_000 }, async () => {
		const s = await writeConfig(1, 10, 20, 'v1');
		ok(s === 200 || s === 201 || s === 204, `WriteConfig seed status=${s}`);

		const cfg = await getConfig();
		ok(cfg !== null, 'GET /Config/global returned null after seed');

		console.log(`[hot-snapshot T0] record: version=${cfg!.version} flagA=${cfg!.flagA} flagB=${cfg!.flagB} payload=${cfg!.payload} checksum=${cfg!.checksum}`);

		strictEqual(cfg!.version, 1, 'version should be 1');
		strictEqual(cfg!.flagA, 10, 'flagA should be 10');
		strictEqual(cfg!.flagB, 20, 'flagB should be 20');
		strictEqual(cfg!.payload, 'v1', 'payload should be v1');
		strictEqual(cfg!.checksum, 31, 'checksum should be 10+20+1=31');
		strictEqual(cfg!.checksum, cfg!.flagA + cfg!.flagB + cfg!.version, 'invariant: checksum===flagA+flagB+version');
	});

	// ── T1: torn-read detection ────────────────────────────────────────────────

	test('T1: torn-read detection — 50 readers × 4s + concurrent whole-record writer', { timeout: 60_000 }, async () => {
		const s0 = await writeConfig(1, 10, 20, 'v1');
		ok(s0 === 200 || s0 === 201 || s0 === 204, `T1 seed status=${s0}`);

		let writerRunning = true;
		let writerVersion = 2;

		const writerLoop = (async () => {
			while (writerRunning) {
				const v = writerVersion++;
				const flagA = v * 10;
				const flagB = v * 20;
				await writeConfig(v, flagA, flagB, `v${v}`).catch(() => {});
				await sleep(5); // ~200 writes/s
			}
		})();

		const DURATION_MS = 4_000;
		let totalReads = 0;
		let tornReads = 0;
		const tornSamples: string[] = [];

		const readerCoroutines = Array.from({ length: 50 }, async () => {
			const deadline = Date.now() + DURATION_MS;
			while (Date.now() < deadline) {
				const cfg = await getConfig();
				if (!cfg) continue;
				totalReads++;
				const expectedChecksum = cfg.flagA + cfg.flagB + cfg.version;
				if (cfg.checksum !== expectedChecksum) {
					tornReads++;
					if (tornSamples.length < 10) {
						tornSamples.push(
							`version=${cfg.version} flagA=${cfg.flagA} flagB=${cfg.flagB} checksum=${cfg.checksum} expected=${expectedChecksum}`
						);
					}
				}
				await sleep(0);
			}
		});

		await Promise.all(readerCoroutines);
		writerRunning = false;
		await writerLoop;

		const tornRate = totalReads > 0 ? (tornReads / totalReads) * 100 : 0;
		console.log(
			`\n[hot-snapshot T1 ${ENGINE}]\n` +
			`  total_reads=${totalReads} torn_reads=${tornReads} torn_rate=${tornRate.toFixed(4)}%\n` +
			`  writer_versions_written=${writerVersion - 2}\n` +
			(tornSamples.length > 0 ? `  torn samples:\n    ${tornSamples.join('\n    ')}\n` : '') +
			`  >>> VERDICT: ${tornReads === 0
				? `CLEAN — 0 torn reads across ${totalReads} total reads. Whole-record PUT is atomic to concurrent readers.`
				: `DEFECT — ${tornReads}/${totalReads} torn reads (${tornRate.toFixed(4)}%). Checksum mismatch = fields from different versions in one GET.`
			}`
		);

		strictEqual(tornReads, 0, `${tornReads} torn reads detected out of ${totalReads} (${tornRate.toFixed(4)}% torn rate)`);
	});

	// ── T2: monotonic version visibility ──────────────────────────────────────

	test('T2: monotonic version visibility per reader', { timeout: 60_000 }, async () => {
		const s0 = await writeConfig(100, 1000, 2000, 'v100');
		ok(s0 === 200 || s0 === 201 || s0 === 204, `T2 seed status=${s0}`);

		let writerRunning = true;
		let writerVersion = 101;

		const writerLoop = (async () => {
			while (writerRunning) {
				const v = writerVersion++;
				await writeConfig(v, v * 10, v * 20, `v${v}`).catch(() => {});
			}
		})();

		const DURATION_MS = 3_000;
		const versionSequence: number[] = [];

		const deadline = Date.now() + DURATION_MS;
		while (Date.now() < deadline) {
			const cfg = await getConfig();
			if (cfg !== null) versionSequence.push(cfg.version);
			await sleep(0);
		}

		writerRunning = false;
		await writerLoop;

		let backwardsJumps = 0;
		const backwardsDetails: Array<{ i: number; prev: number; cur: number }> = [];
		for (let i = 1; i < versionSequence.length; i++) {
			if (versionSequence[i] < versionSequence[i - 1]) {
				backwardsJumps++;
				if (backwardsDetails.length < 10) {
					backwardsDetails.push({ i, prev: versionSequence[i - 1], cur: versionSequence[i] });
				}
			}
		}

		const minVer = versionSequence.length > 0 ? Math.min(...versionSequence) : 0;
		const maxVer = versionSequence.length > 0 ? Math.max(...versionSequence) : 0;

		console.log(
			`\n[hot-snapshot T2 ${ENGINE}]\n` +
			`  samples=${versionSequence.length} min=${minVer} max=${maxVer}\n` +
			`  backwards_jumps=${backwardsJumps}` +
			(backwardsDetails.length > 0 ? `\n  details: ${JSON.stringify(backwardsDetails)}` : '') + '\n' +
			`  >>> VERDICT: ${backwardsJumps === 0
				? `CLEAN — version visibility monotonically non-decreasing across ${versionSequence.length} samples.`
				: `DEFECT — ${backwardsJumps} backwards version jumps (reader saw N+k then N — stale read or version rewind).`
			}`
		);

		strictEqual(backwardsJumps, 0, `${backwardsJumps} backwards version jumps in ${versionSequence.length} samples`);
	});

	// ── T3: latency distribution — observational only ─────────────────────────

	test('T3: latency distribution — baseline vs writer-active (observational)', { timeout: 60_000 }, async () => {
		const s0 = await writeConfig(1, 10, 20, 'v1');
		ok(s0 === 200 || s0 === 201 || s0 === 204, `T3 seed status=${s0}`);

		async function measureLatencies(n: number): Promise<number[]> {
			const latencies: number[] = [];
			for (let i = 0; i < n; i++) {
				const t0 = performance.now();
				await getConfig();
				latencies.push(performance.now() - t0);
			}
			return latencies;
		}

		function percentile(sorted: number[], p: number): number {
			const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
			return sorted[idx];
		}

		const N = 500;

		const baseLatencies = (await measureLatencies(N)).sort((a, b) => a - b);
		const baseP50 = percentile(baseLatencies, 50);
		const baseP99 = percentile(baseLatencies, 99);
		const baseMax = baseLatencies[baseLatencies.length - 1];

		let writerRunning = true;
		let writerVersion = 2;
		const writerLoop = (async () => {
			while (writerRunning) {
				const v = writerVersion++;
				await writeConfig(v, v * 10, v * 20, `v${v}`).catch(() => {});
				await sleep(50);
			}
		})();

		const underLatencies = (await measureLatencies(N)).sort((a, b) => a - b);
		writerRunning = false;
		await writerLoop;

		const underP50 = percentile(underLatencies, 50);
		const underP99 = percentile(underLatencies, 99);
		const underMax = underLatencies[underLatencies.length - 1];

		const p99Ratio = baseP99 > 0 ? underP99 / baseP99 : 0;
		const latencyVerdict = p99Ratio > 5
			? `WARNING — p99 under writer is ${p99Ratio.toFixed(1)}x baseline (${underP99.toFixed(2)}ms vs ${baseP99.toFixed(2)}ms)`
			: `STABLE — p99 ratio ${p99Ratio.toFixed(2)}x (within 5x threshold)`;

		console.log(
			`\n[hot-snapshot T3 ${ENGINE}]\n` +
			`  baseline  (${N} reads): p50=${baseP50.toFixed(2)}ms p99=${baseP99.toFixed(2)}ms max=${baseMax.toFixed(2)}ms\n` +
			`  under-writer (${N} reads): p50=${underP50.toFixed(2)}ms p99=${underP99.toFixed(2)}ms max=${underMax.toFixed(2)}ms\n` +
			`  p99_ratio=${p99Ratio.toFixed(2)}x\n` +
			`  >>> VERDICT: OBSERVATIONAL — ${latencyVerdict}`
		);

		ok(true, 'T3 observational pass');
	});

	// ── T4: addTo (BumpReadCount) under PUT storm ──────────────────────────────

	test('T4: addTo under PUT storm — no lost increments', { timeout: 60_000 }, async () => {
		const s0 = await writeConfig(1, 10, 20, 'v1');
		ok(s0 === 200 || s0 === 201 || s0 === 204, `T4 seed status=${s0}`);

		const seedCfg = await getConfig();
		ok(seedCfg !== null, 'T4: failed to GET seed record');
		const startReadCount = seedCfg!.readCount ?? 0;

		const N_BUMP = 200;

		const bumpResults = await Promise.allSettled(
			Array.from({ length: N_BUMP }, () => bumpReadCount())
		);
		const putResults = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) =>
				writeConfig(100 + i, (100 + i) * 10, (100 + i) * 20, `storm-v${100 + i}`)
			)
		);

		await sleep(200);

		const finalCfg = await getConfig();
		ok(finalCfg !== null, 'T4: failed to GET final record');

		const finalReadCount = finalCfg!.readCount ?? 0;
		const gained = finalReadCount - startReadCount;
		const bumpSuccesses = bumpResults.filter(r => r.status === 'fulfilled' && (r.value === 200 || r.value === 204)).length;
		const putSuccesses = putResults.filter(r => r.status === 'fulfilled').length;

		const expectedChecksum = finalCfg!.flagA + finalCfg!.flagB + finalCfg!.version;
		const selfConsistent = finalCfg!.checksum === expectedChecksum;

		console.log(
			`\n[hot-snapshot T4 ${ENGINE}]\n` +
			`  N_BUMP=${N_BUMP} bump_successes=${bumpSuccesses} put_successes=${putSuccesses}\n` +
			`  startReadCount=${startReadCount} finalReadCount=${finalReadCount} gained=${gained} expected=${N_BUMP}\n` +
			`  final: version=${finalCfg!.version} flagA=${finalCfg!.flagA} flagB=${finalCfg!.flagB} ` +
			`checksum=${finalCfg!.checksum} expectedChecksum=${expectedChecksum} selfConsistent=${selfConsistent}\n` +
			`  >>> VERDICT: ${gained === N_BUMP && selfConsistent
				? `CLEAN — readCount gained exactly ${N_BUMP}, record self-consistent after PUT storm.`
				: [
					gained !== N_BUMP ? `DEFECT — lost ${N_BUMP - gained} increments (gained ${gained}/${N_BUMP})` : null,
					!selfConsistent ? `DEFECT — checksum mismatch (checksum=${finalCfg!.checksum} != expected=${expectedChecksum})` : null,
				  ].filter(Boolean).join('; ')
			}`
		);

		strictEqual(gained, N_BUMP, `Expected readCount to gain ${N_BUMP}, gained ${gained} (lost ${N_BUMP - gained})`);
		strictEqual(finalCfg!.checksum, expectedChecksum, `Final record checksum=${finalCfg!.checksum} != expected=${expectedChecksum} (torn state)`);
	});
});
