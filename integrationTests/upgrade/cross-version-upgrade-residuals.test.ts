/**
 * QA-promoted regression anchor — promoted from QA-660 (P-438), a gated qa-explorer finding.
 * Originating QA scenario: QA-660 (gh#1865 + QA-658/P-437 residual).
 * Coverage anchored: cross-version 5.1.22 -> current upgrade stays read-consistent at 55k rows
 * through a SIGKILL-dirty shutdown and boot-boundary writes.
 *
 * The honest remainder of the cross-version upgrade-boot read-visibility investigation.
 *
 * cross-version-upgrade-visibility.test.ts (QA-658/P-437) already ran the GENUINE 5.1.22 ->
 * current cross-version upgrade boot (real npm install, real dataRootDir handoff, real
 * 6-surface matrix vs the index-independent base-store-scan oracle) and found 0/24 misses on a
 * small, UNIFORM-width dataset stopped with a CLEAN shutdown. That result narrows #1865 but
 * leaves three variables untested: dataset scale/shape, a DIRTY (SIGKILL) shutdown, and writes
 * racing the boot boundary. This suite varies all three, stacked onto ONE upgrade boot (not
 * three isolated runs — see the "why stacked, not isolated" note below), and reuses QA-658's
 * oracle-vs-surface methodology verbatim.
 *
 * Arms exercised on the SAME dataRootDir handoff (5.1.22 -> current build):
 *   (a) SCALE + SHAPE   — waveA: 50,000 rows, WIDTH-HETEROGENEOUS (6 disjoint field-set shapes
 *       cycling by index — narrow/no-extras, arrays, long strings, nested objects, mixed
 *       scalars, unicode — see resources.js hetExtra()), seeded and left to complete CLEANLY
 *       under 5.1.22. This is the scale+shape control population within the same run.
 *   (b) DIRTY SHUTDOWN  — waveB: a SECOND width-heterogeneous load (target 40,000 rows) is
 *       split into 40 independent 1,000-row HTTP requests (so partial completion is possible —
 *       a single giant request is one atomic transaction; see "why chunked" below) fired with
 *       concurrency 6, and 5.1.22 is SIGKILLed ~150ms in. The current build then boots over
 *       this DIRTY (mid-write, unclean-shutdown) state.
 *   (c) CONCURRENT WRITES ACROSS THE BOOT BOUNDARY — waveC: starting the instant the current
 *       build is spawned (before `startHarper()`'s promise resolves), a writer loop fires
 *       single-row POST /Load/ requests every ~3ms against the instance's known hostname:port,
 *       continuing for 2s past the moment the instance reports ready, to see whether any land
 *       DURING the boot window (not just immediately after).
 *
 * Why chunked+concurrent for (b), not one giant unawaited request: an empirical probe (see run
 * history) found a single large POST /Load/ call is ATOMIC at the Resource-handler-transaction
 * boundary — killing mid-handler loses either ~0 or ~all of it, never a genuine partial. Many
 * independent concurrent HTTP requests, each its own request/transaction, is what QA-608 used
 * to get a real mixed acked/unacked/committed-but-unacked outcome, and is reused here.
 *
 * Why stacked in ONE run, not three isolated arms: budget (one foreground CI-timeout run) and
 * the task's own framing ("does any of (a)/(b)/(c) — alone or combined —"). Each wave's rows
 * are batch-tagged, so a miss can still be attributed to whichever wave it belongs to even
 * without three separate boots. This is a real methodological tradeoff — noted, not hidden.
 *
 * Oracle discipline (unchanged from QA-658/D-230): base-store scan (index-independent) is the
 * ORACLE. search_by_value is a secondary-index scan that JOINS through the primary record and
 * SKIPs on absence — it can never reveal a dangling index entry, so every surface is compared
 * against the oracle's id set, never against another surface.
 *
 * Read-surface transport note: at this scale, per-id HTTP round trips for all 6 surfaces would
 * not finish in any sane budget. Oracle scan, ops search_by_value, cached point-GET, ops
 * search_by_id, and SQL-by-batch are all tested at FULL POPULATION using bulk-capable transports
 * (a single scan / a bulk custom endpoint that loops the SAME per-id read call server-side /
 * ops's native `ids` array / a batch-predicate SQL query) — the READ SEMANTICS under test
 * (does this id resolve on this surface) are unchanged; only the transport is batched. REST
 * (GET /Widget/<id>, no bulk verb) and a point-lookup form of SQL (`WHERE id IN (...)`) are
 * SAMPLED at a stratified ~2,000 ids (see buildSample()) covering all three waves and the
 * region around wave B's kill point, run with bounded concurrency.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   timeout 1500 npm run test:integration -- "integrationTests/upgrade/cross-version-upgrade-residuals.test.ts"
 * Harper SHA under test: 07c2bbcb9 (main)
 * 5.1.x version installed: harper@5.1.22 (via ~/dev/tmp/qa658-harper51, HARPER_LEGACY_51_PATH honored)
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	startHarper,
	setupHarperWithFixture,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'cross-version-upgrade-residuals');
const DB = 'qa660';
const TABLE = 'Widget';

// ---- workload sizing --------------------------------------------------------------------
const WAVE_A_COUNT = 50_000; // (a) scale + width-heterogeneous shape, clean completion
const WAVE_B_TARGET = 40_000; // (b) dirty-shutdown target; actual persisted count is empirical
const WAVE_B_CHUNK = 1_000; // per-request row count -> 40 independent requests
const WAVE_B_CONCURRENCY = 6;
const WAVE_B_KILL_DELAY_MS = 150;
const WAVE_C_WRITE_INTERVAL_MS = 3; // (c) boot-boundary writer cadence
const WAVE_C_POST_READY_MS = 2_000; // keep writing this long past the ready signal

const SAMPLE_SIZE = 2_000; // stratified REST / SQL-IN sample size
const BULK_CHUNK = 8_000; // chunk size for cachedGetBulk / opsById bulk requests
const SQL_IN_CHUNK = 200; // chunk size for SQL `WHERE id IN (...)`

// Provisioned by: cd ~/dev/tmp/qa658-harper51 && npm install harper@5.1.22 --no-save
const LEGACY_51_BIN_PATH =
	process.env.HARPER_LEGACY_51_PATH ??
	resolve(process.env.HOME ?? '', 'dev/tmp/qa658-harper51/node_modules/harper/dist/bin/harper.js');
const legacy51Available = existsSync(LEGACY_51_BIN_PATH);
const skipSuite = process.platform === 'win32' || !legacy51Available;

// Re-passed verbatim on every startHarper() call across every restart — never omitted.
const BOOT_CONFIG = { logging: { console: true, level: 'error' } };

interface ScanRow {
	id: string;
	batch: string;
}
interface SurfaceMatrix {
	label: string;
	oracle: Map<string, string>; // id -> batch, from ScanAll (full population, ground truth)
	opsScanIds: Set<string>; // full population (search_by_value per known batch, unioned)
	cachedGetMisses: string[]; // full population (bulk custom endpoint, same table.get() path)
	opsByIdMisses: string[]; // full population (ops search_by_id, ids array, chunked)
	sqlByBatchIds: Set<string>; // full population (SQL WHERE batch=X, per batch, unioned)
	sampleIds: string[]; // stratified sample used for REST + SQL-IN
	restMisses: string[]; // sampled
	sqlInMisses: string[]; // sampled (WHERE id IN (...))
}

suite(
	'QA-660 cross-version upgrade-boot read visibility: scale+shape, dirty shutdown, boot-boundary concurrency (#1865)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		const findings: string[] = [];
		function log(line: string) {
			findings.push(line);
			console.log(`[QA-660] ${line}`);
		}

		function get(path: string, baseURL = httpURL): Promise<Response> {
			return fetch(`${baseURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		}
		function post(path: string, body: unknown, baseURL = httpURL): Promise<Response> {
			return fetch(`${baseURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client?.headers.Authorization ?? '' },
				body: JSON.stringify(body),
			});
		}

		async function pollReady(path: string, maxWaitMs = 60_000, baseURL = httpURL): Promise<void> {
			const deadline = Date.now() + maxWaitMs;
			while (Date.now() < deadline) {
				try {
					const r = await get(path, baseURL);
					if (r.status !== 404) return;
				} catch {
					/* not up yet */
				}
				await sleep(100);
			}
			throw new Error(`route ${path} still 404 after ${maxWaitMs}ms`);
		}

		async function refreshClient() {
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
		}

		function chunkArray<T>(arr: T[], size: number): T[][] {
			const out: T[][] = [];
			for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
			return out;
		}

		async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
			const results: R[] = new Array(items.length);
			let idx = 0;
			async function worker() {
				for (;;) {
					const i = idx++;
					if (i >= items.length) return;
					results[i] = await fn(items[i]);
				}
			}
			await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
			return results;
		}

		// ---- (a) clean, width-heterogeneous bulk load -------------------------------------
		async function loadClean(batch: string, count: number, concurrency: number): Promise<{ completed: number }> {
			const r = await post('/Load/', { count, batch, concurrency });
			strictEqual(r.status, 200, `Load(${batch}) should return 200`);
			const body = (await r.json()) as { completed: number };
			return body;
		}

		// ---- (b) chunked concurrent load + SIGKILL mid-write --------------------------------
		async function dirtyShutdownLoad(
			batch: string,
			target: number,
			chunkSize: number,
			concurrency: number,
			killDelayMs: number
		): Promise<{ numChunks: number; ackedChunks: number }> {
			const numChunks = Math.ceil(target / chunkSize);
			let acked = 0;
			let nextChunk = 0;
			async function chunkWorker() {
				for (;;) {
					const c = nextChunk++;
					if (c >= numChunks) return;
					const startIndex = c * chunkSize;
					const count = Math.min(chunkSize, target - startIndex);
					try {
						const r = await post('/Load/', { count, batch, startIndex, concurrency: 20 });
						if (r.status === 200) {
							await r.json();
							acked++;
						}
					} catch {
						/* in-flight at kill time */
					}
				}
			}
			const workers = Array.from({ length: concurrency }, () => chunkWorker());
			const allDone = Promise.allSettled(workers);

			await sleep(killDelayMs);
			log(`(b) dirty-shutdown trigger: ${acked}/${numChunks} chunk requests ACKed (client received 200) before kill`);
			const proc = ctx.harper.process;
			const pid = proc.pid!;
			process.kill(-pid, 'SIGKILL');
			await new Promise<void>((res) => proc.once('exit', res));
			await allDone;
			return { numChunks, ackedChunks: acked };
		}

		// ---- (c) writer loop racing the current-build boot boundary --------------------------
		interface WriteAttempt {
			t0: number;
			ok: boolean;
		}
		function startBootBoundaryWriter(bootHttpURL: string, batch: string) {
			let stop = false;
			let idx = 0;
			const attempts: WriteAttempt[] = [];
			const loopPromise = (async () => {
				while (!stop) {
					const i = idx++;
					const t0 = Date.now();
					try {
						const r = await fetch(`${bootHttpURL}/Load/`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ count: 1, batch, startIndex: i, concurrency: 1 }),
							signal: AbortSignal.timeout(2_000),
						});
						attempts.push({ t0, ok: r.status === 200 });
					} catch {
						attempts.push({ t0, ok: false });
					}
					await sleep(WAVE_C_WRITE_INTERVAL_MS);
				}
			})();
			return {
				stop: async () => {
					stop = true;
					await loopPromise;
				},
				attempts,
			};
		}

		// ---- full-population oracle scan ------------------------------------------------------
		async function oracleScan(): Promise<Map<string, string>> {
			const r = await get('/ScanAll/');
			strictEqual(r.status, 200, `/ScanAll/ should return 200, got ${r.status}`);
			const body = (await r.json()) as { count: number; rows: ScanRow[] };
			const m = new Map<string, string>();
			for (const row of body.rows) m.set(row.id, row.batch);
			return m;
		}

		async function opsScanByValue(batches: string[]): Promise<Set<string>> {
			const ids = new Set<string>();
			for (const batch of batches) {
				const res = await sendOperation(ctx.harper, {
					operation: 'search_by_value',
					schema: DB,
					table: TABLE,
					search_attribute: 'batch',
					search_value: batch,
					get_attributes: ['id'],
				});
				for (const r of res as Array<{ id: string }>) ids.add(r.id);
			}
			return ids;
		}

		async function cachedGetBulkMisses(ids: string[]): Promise<string[]> {
			const misses: string[] = [];
			for (const chunk of chunkArray(ids, BULK_CHUNK)) {
				const r = await post('/PointGetBulk/', { ids: chunk });
				strictEqual(r.status, 200, 'PointGetBulk should return 200');
				const body = (await r.json()) as { misses: string[] };
				misses.push(...body.misses);
			}
			return misses;
		}

		async function opsByIdBulkMisses(ids: string[]): Promise<string[]> {
			const misses: string[] = [];
			for (const chunk of chunkArray(ids, BULK_CHUNK)) {
				const res = (await sendOperation(ctx.harper, {
					operation: 'search_by_id',
					schema: DB,
					table: TABLE,
					ids: chunk,
					get_attributes: ['id'],
				})) as Array<{ id: string }>;
				const found = new Set(res.map((r) => r.id));
				for (const id of chunk) if (!found.has(id)) misses.push(id);
			}
			return misses;
		}

		async function sqlByBatch(batches: string[]): Promise<Set<string>> {
			const ids = new Set<string>();
			for (const batch of batches) {
				const res = (await sendOperation(ctx.harper, {
					operation: 'sql',
					sql: `SELECT id FROM ${DB}.${TABLE} WHERE batch = '${batch}'`,
				})) as Array<{ id: string }>;
				for (const r of res) ids.add(r.id);
			}
			return ids;
		}

		async function sqlInMisses(ids: string[]): Promise<string[]> {
			const misses: string[] = [];
			for (const chunk of chunkArray(ids, SQL_IN_CHUNK)) {
				const inList = chunk.map((id) => `'${id}'`).join(',');
				const res = (await sendOperation(ctx.harper, {
					operation: 'sql',
					sql: `SELECT id FROM ${DB}.${TABLE} WHERE id IN (${inList})`,
				})) as Array<{ id: string }>;
				const found = new Set(res.map((r) => r.id));
				for (const id of chunk) if (!found.has(id)) misses.push(id);
			}
			return misses;
		}

		async function restMisses(ids: string[]): Promise<string[]> {
			const results = await mapLimit(ids, 40, async (id) => {
				const r = await get(`/Widget/${id}`);
				return { id, ok: r.status === 200 };
			});
			return results.filter((r) => !r.ok).map((r) => r.id);
		}

		/** Stratified sample: proportional per-batch coverage, plus every id near wave B's kill boundary. */
		function buildSample(oracle: Map<string, string>): string[] {
			const byBatch = new Map<string, string[]>();
			for (const [id, batch] of oracle) {
				if (!byBatch.has(batch)) byBatch.set(batch, []);
				byBatch.get(batch)!.push(id);
			}
			const sample: string[] = [];
			for (const [, ids] of byBatch) {
				ids.sort();
				const take = Math.max(1, Math.min(ids.length, Math.round((SAMPLE_SIZE * ids.length) / oracle.size)));
				const step = Math.max(1, Math.floor(ids.length / take));
				for (let i = 0; i < ids.length && sample.length < SAMPLE_SIZE; i += step) sample.push(ids[i]);
			}
			return [...new Set(sample)];
		}

		async function buildMatrix(label: string): Promise<SurfaceMatrix> {
			const oracle = await oracleScan();
			const batches = [...new Set(oracle.values())];
			const allIds = [...oracle.keys()];
			const sampleIds = buildSample(oracle);

			const [opsScanIds, cachedMisses, opsByIdMissesResult, sqlByBatchIds, sqlInM, restM] = await Promise.all([
				opsScanByValue(batches),
				cachedGetBulkMisses(allIds),
				opsByIdBulkMisses(allIds),
				sqlByBatch(batches),
				sqlInMisses(sampleIds),
				restMisses(sampleIds),
			]);

			const m: SurfaceMatrix = {
				label,
				oracle,
				opsScanIds,
				cachedGetMisses: cachedMisses,
				opsByIdMisses: opsByIdMissesResult,
				sqlByBatchIds,
				sampleIds,
				restMisses: restM,
				sqlInMisses: sqlInM,
			};
			log(
				`${label}: oracle=${oracle.size} opsScan=${opsScanIds.size} sqlByBatch=${sqlByBatchIds.size} ` +
					`cachedGET-misses=${cachedMisses.length} opsById-misses=${opsByIdMissesResult.length} ` +
					`(sample=${sampleIds.length}) REST-misses=${restM.length} SQL-IN-misses=${sqlInM.length}`
			);
			if (opsScanIds.size !== oracle.size)
				log(`${label}: [#1865 CHECK] opsScan size (${opsScanIds.size}) != oracle size (${oracle.size})`);
			if (sqlByBatchIds.size !== oracle.size)
				log(`${label}: [#1865 CHECK] sqlByBatch size (${sqlByBatchIds.size}) != oracle size (${oracle.size})`);
			if (cachedMisses.length)
				log(
					`${label}: [#1865 CHECK] cachedGET MISSES (${cachedMisses.length}): ${cachedMisses.slice(0, 20).join(',')}${cachedMisses.length > 20 ? ',...' : ''}`
				);
			if (opsByIdMissesResult.length)
				log(
					`${label}: [#1865 CHECK] opsById MISSES (${opsByIdMissesResult.length}): ${opsByIdMissesResult.slice(0, 20).join(',')}${opsByIdMissesResult.length > 20 ? ',...' : ''}`
				);
			if (restM.length)
				log(
					`${label}: [#1865 CHECK] REST MISSES (sampled, ${restM.length}): ${restM.slice(0, 20).join(',')}${restM.length > 20 ? ',...' : ''}`
				);
			if (sqlInM.length)
				log(
					`${label}: [#1865 CHECK] SQL-IN MISSES (sampled, ${sqlInM.length}): ${sqlInM.slice(0, 20).join(',')}${sqlInM.length > 20 ? ',...' : ''}`
				);
			return m;
		}

		let matrixPreUpgrade: SurfaceMatrix;
		let matrixPostUpgrade: SurfaceMatrix;
		let matrixAfterHeal: SurfaceMatrix | null = null;
		let matrixAfterRestart2: SurfaceMatrix;
		let bWaveResult: { numChunks: number; ackedChunks: number };
		let cWaveAttempts: WriteAttempt[];
		let cWaveReadyAt: number;

		before(async () => {
			log(`harper SHA under test: 07c2bbcb9; legacy 5.1.x bin: ${LEGACY_51_BIN_PATH}`);
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: BOOT_CONFIG,
				env: { TC_AGREEMENT: 'yes' },
				harperBinPath: LEGACY_51_BIN_PATH,
			});
			await refreshClient();
			await pollReady('/ScanAll/');
			log(`cold boot (5.1.x) complete at ${httpURL}, dataRootDir=${ctx.harper.dataRootDir}`);
		});

		after(async () => {
			await teardownHarper(ctx);
			log('--- FINDINGS SUMMARY ---');
			for (const line of findings) console.log(`[QA-660][summary] ${line}`);
		});

		test('Q0 (a) seed waveA CLEANLY under 5.1.x: 50k width-heterogeneous rows', { timeout: 120_000 }, async () => {
			const { completed } = await loadClean('waveA', WAVE_A_COUNT, 300);
			strictEqual(completed, WAVE_A_COUNT, `PRECONDITION: waveA load must report ${WAVE_A_COUNT} completed puts`);
			matrixPreUpgrade = await buildMatrix('PRE-UPGRADE (5.1.x, waveA only)');
			strictEqual(
				matrixPreUpgrade.oracle.size,
				WAVE_A_COUNT,
				'PRECONDITION: oracle scan must see all waveA rows pre-upgrade'
			);
			strictEqual(
				matrixPreUpgrade.opsScanIds.size,
				WAVE_A_COUNT,
				'PRECONDITION: ops search_by_value must see all waveA rows pre-upgrade'
			);
			strictEqual(
				matrixPreUpgrade.cachedGetMisses.length,
				0,
				'PRECONDITION: cached point-GET must miss nothing pre-upgrade'
			);
			strictEqual(matrixPreUpgrade.restMisses.length, 0, 'PRECONDITION: REST sample must miss nothing pre-upgrade');
			strictEqual(
				matrixPreUpgrade.opsByIdMisses.length,
				0,
				'PRECONDITION: ops search_by_id must miss nothing pre-upgrade'
			);
			strictEqual(matrixPreUpgrade.sqlInMisses.length, 0, 'PRECONDITION: SQL-IN sample must miss nothing pre-upgrade');
			strictEqual(
				matrixPreUpgrade.sqlByBatchIds.size,
				WAVE_A_COUNT,
				'PRECONDITION: SQL-by-batch must see all waveA rows pre-upgrade'
			);
		});

		test(
			'Q1 (b) dirty-shutdown waveB: chunked concurrent load + SIGKILL 5.1.x mid-write',
			{ timeout: 60_000 },
			async () => {
				bWaveResult = await dirtyShutdownLoad(
					'waveB',
					WAVE_B_TARGET,
					WAVE_B_CHUNK,
					WAVE_B_CONCURRENCY,
					WAVE_B_KILL_DELAY_MS
				);
				log(
					`(b) 5.1.x SIGKILLed mid-write: ${bWaveResult.ackedChunks}/${bWaveResult.numChunks} of waveB's ${WAVE_B_CHUNK}-row chunk requests ACKed before kill (${WAVE_B_TARGET} rows targeted)`
				);
				// PRECONDITION: the kill must have landed while write requests were genuinely still
				// outstanding, not after every chunk had already been acked (a vacuous "clean-ish" kill).
				ok(
					bWaveResult.ackedChunks < bWaveResult.numChunks,
					`PRECONDITION FAILED: all ${bWaveResult.numChunks} waveB chunks were ACKed before the kill — the SIGKILL landed after the write drained, not mid-write`
				);
			}
		);

		test(
			'Q2 (a)+(b)+(c) CROSS-VERSION UPGRADE BOOT: current build over the dirty 5.1.x state, writes racing the boot boundary',
			{ timeout: 120_000 },
			async () => {
				const hostname = ctx.harper.hostname;
				const bootHttpURL = `http://${hostname}:9926`;
				const startPromise = startHarper(ctx, { config: BOOT_CONFIG, env: {} });
				const writer = startBootBoundaryWriter(bootHttpURL, 'waveC');

				await startPromise;
				cWaveReadyAt = Date.now();
				await sleep(WAVE_C_POST_READY_MS);
				await writer.stop();
				cWaveAttempts = writer.attempts;

				const beforeReady = cWaveAttempts.filter((a) => a.t0 < cWaveReadyAt);
				const afterReady = cWaveAttempts.filter((a) => a.t0 >= cWaveReadyAt);
				const beforeReadyOk = beforeReady.filter((a) => a.ok).length;
				const afterReadyOk = afterReady.filter((a) => a.ok).length;
				log(
					`(c) boot-boundary writer: ${cWaveAttempts.length} attempts total; ` +
						`before-ready=${beforeReady.length} (${beforeReadyOk} succeeded), after-ready=${afterReady.length} (${afterReadyOk} succeeded)`
				);
				if (beforeReadyOk === 0) {
					log(
						'(c) COULD NOT ARM: 0 of ' +
							beforeReady.length +
							' write attempts issued before the ready signal succeeded — every one hit connection-refused. ' +
							"Harper's HTTP listener does not appear to accept connections until boot (including crash " +
							'recovery + cross-version migration) is fully complete; there is no externally-observable ' +
							'partial-availability window via plain HTTP for this build/config. Reporting plainly per the brief ' +
							'rather than substituting a weaker arm.'
					);
				} else {
					log(
						`(c) ARMED: ${beforeReadyOk} write(s) landed genuinely DURING the boot window (before the ready signal).`
					);
				}

				await refreshClient();
				await pollReady('/ScanAll/');
				log(`cross-version upgrade boot (current build over dirty 5.1.x data) complete at ${httpURL}`);

				matrixPostUpgrade = await buildMatrix('POST-CROSSVER-UPGRADE (dirty waveB + boot-boundary waveC)');

				// The oracle itself must be internally sane: every waveA row (clean, pre-kill) must
				// still be present — a scale/shape-triggered defect big enough to lose ORACLE-visible
				// rows would be a much larger problem than a read-visibility miss.
				let waveACount = 0;
				for (const batch of matrixPostUpgrade.oracle.values()) if (batch === 'waveA') waveACount++;
				strictEqual(
					waveACount,
					WAVE_A_COUNT,
					`ORACLE: all ${WAVE_A_COUNT} waveA rows must still be scan-visible after the upgrade boot`
				);
			}
		);

		test('Q3 POST-UPGRADE: does any surface miss what the oracle sees? (#1865 check, all three waves)', () => {
			const m = matrixPostUpgrade;
			strictEqual(
				m.opsScanIds.size,
				m.oracle.size,
				`[#1865 CHECK] ops search_by_value union expected ${m.oracle.size}, got ${m.opsScanIds.size}`
			);
			strictEqual(
				m.sqlByBatchIds.size,
				m.oracle.size,
				`[#1865 CHECK] SQL-by-batch union expected ${m.oracle.size}, got ${m.sqlByBatchIds.size}`
			);
			strictEqual(
				m.cachedGetMisses.length,
				0,
				`[#1865 CHECK] cached point-GET (bulk) expected 0 misses, got ${m.cachedGetMisses.length}`
			);
			strictEqual(
				m.opsByIdMisses.length,
				0,
				`[#1865 CHECK] ops search_by_id (bulk) expected 0 misses, got ${m.opsByIdMisses.length}`
			);
			strictEqual(
				m.restMisses.length,
				0,
				`[#1865 CHECK] REST (sampled ${m.sampleIds.length}) expected 0 misses, got ${m.restMisses.length}`
			);
			strictEqual(
				m.sqlInMisses.length,
				0,
				`[#1865 CHECK] SQL WHERE id IN (sampled ${m.sampleIds.length}) expected 0 misses, got ${m.sqlInMisses.length}`
			);
		});

		test('Q4 write-then-read heal: does re-putting a missed row repair it?', { timeout: 30_000 }, async (t) => {
			const anyMisses =
				matrixPostUpgrade.cachedGetMisses.length ||
				matrixPostUpgrade.restMisses.length ||
				matrixPostUpgrade.opsByIdMisses.length ||
				matrixPostUpgrade.sqlInMisses.length;
			if (!anyMisses) {
				t.skip('no miss observed after the cross-version upgrade boot on any point surface — nothing to heal');
				return;
			}
			const targetId =
				matrixPostUpgrade.cachedGetMisses[0] ??
				matrixPostUpgrade.restMisses[0] ??
				matrixPostUpgrade.opsByIdMisses[0] ??
				matrixPostUpgrade.sqlInMisses[0];
			const batch = matrixPostUpgrade.oracle.get(targetId) ?? 'unknown';
			log(`Q4: healing probe targets ${targetId} (batch=${batch}, missed pre-heal)`);

			const beforeHealRes = await post('/PointGetBulk/', { ids: [targetId] });
			const beforeHeal = ((await beforeHealRes.json()) as { misses: string[] }).misses.length === 0;
			const r = await post('/Touch/', {
				id: targetId,
				sku: `SKU-${batch}-touched`,
				batch,
				name: `Widget ${batch} touched`,
			});
			strictEqual(r.status, 200, 'Touch should return 200');
			const touchBody = (await r.json()) as { foundAfterTouch: boolean };
			const afterHealRes = await post('/PointGetBulk/', { ids: [targetId] });
			const afterHeal = ((await afterHealRes.json()) as { misses: string[] }).misses.length === 0;
			log(
				`Q4: ${targetId} cachedGET before-write=${beforeHeal}, Touch.foundAfterTouch=${touchBody.foundAfterTouch}, ` +
					`cachedGET after-write=${afterHeal} -> ${afterHeal ? 'WRITE HEALS the miss' : 'STILL MISSING after the write'}`
			);
			matrixAfterHeal = await buildMatrix('POST-HEAL');
			ok(true, `heal probe recorded (before=${beforeHeal}, after=${afterHeal})`);
		});

		test(
			'Q5 RESTART #2 (current build, no further version change): is any miss stable, cleared, or does it grow?',
			{ timeout: 120_000 },
			async () => {
				await killHarper(ctx);
				log('killed Harper cleanly (SIGTERM) for restart #2 (same-build, boot-order check)');
				await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
				await refreshClient();
				await pollReady('/ScanAll/');
				log(`restart #2 (same-build) complete at ${httpURL}`);

				matrixAfterRestart2 = await buildMatrix('POST-RESTART-2 (same-build)');
				strictEqual(
					matrixAfterRestart2.oracle.size,
					matrixPostUpgrade.oracle.size,
					'ORACLE: population size must be stable across the second (same-build) restart'
				);

				const cmp = (name: string, a: string[], b: string[]) => {
					log(
						`Q5 boot-order check (${name}): post-crossver-upgrade misses=${b.length}, post-restart#2 misses=${a.length} -> ` +
							`${a.length === 0 && b.length > 0 ? 'CLEARED on 2nd (same-build) boot (order-dependent)' : a.length > 0 && b.length === 0 ? 'NEW MISS introduced by 2nd boot alone' : a.length === b.length ? 'UNCHANGED across boots (stable)' : 'CHANGED (different miss count)'}`
					);
				};
				cmp('cachedGetMisses', matrixAfterRestart2.cachedGetMisses, matrixPostUpgrade.cachedGetMisses);
				cmp('opsByIdMisses', matrixAfterRestart2.opsByIdMisses, matrixPostUpgrade.opsByIdMisses);
				cmp('restMisses (sampled)', matrixAfterRestart2.restMisses, matrixPostUpgrade.restMisses);
				cmp('sqlInMisses (sampled)', matrixAfterRestart2.sqlInMisses, matrixPostUpgrade.sqlInMisses);

				log(
					`FINAL VISIBILITY MATRIX SUMMARY:\n` +
						`  PRE-UPGRADE (5.1.x, waveA)   : oracle=${matrixPreUpgrade.oracle.size} opsScan=${matrixPreUpgrade.opsScanIds.size} sqlByBatch=${matrixPreUpgrade.sqlByBatchIds.size} cachedGET-misses=${matrixPreUpgrade.cachedGetMisses.length} opsById-misses=${matrixPreUpgrade.opsByIdMisses.length} REST-misses=${matrixPreUpgrade.restMisses.length} SQL-IN-misses=${matrixPreUpgrade.sqlInMisses.length}\n` +
						`  POST-CROSSVER-UPGRADE (a+b+c): oracle=${matrixPostUpgrade.oracle.size} opsScan=${matrixPostUpgrade.opsScanIds.size} sqlByBatch=${matrixPostUpgrade.sqlByBatchIds.size} cachedGET-misses=${matrixPostUpgrade.cachedGetMisses.length} opsById-misses=${matrixPostUpgrade.opsByIdMisses.length} REST-misses=${matrixPostUpgrade.restMisses.length} SQL-IN-misses=${matrixPostUpgrade.sqlInMisses.length}\n` +
						(matrixAfterHeal
							? `  POST-HEAL                    : oracle=${matrixAfterHeal.oracle.size} cachedGET-misses=${matrixAfterHeal.cachedGetMisses.length} opsById-misses=${matrixAfterHeal.opsByIdMisses.length} REST-misses=${matrixAfterHeal.restMisses.length} SQL-IN-misses=${matrixAfterHeal.sqlInMisses.length}\n`
							: '') +
						`  POST-RESTART-2                : oracle=${matrixAfterRestart2.oracle.size} opsScan=${matrixAfterRestart2.opsScanIds.size} sqlByBatch=${matrixAfterRestart2.sqlByBatchIds.size} cachedGET-misses=${matrixAfterRestart2.cachedGetMisses.length} opsById-misses=${matrixAfterRestart2.opsByIdMisses.length} REST-misses=${matrixAfterRestart2.restMisses.length} SQL-IN-misses=${matrixAfterRestart2.sqlInMisses.length}\n` +
						`  (b) dirty-shutdown trigger     : ${bWaveResult.ackedChunks}/${bWaveResult.numChunks} waveB chunks ACKed before SIGKILL (target ${WAVE_B_TARGET} rows)\n` +
						`  (c) boot-boundary writer       : ${cWaveAttempts.filter((a) => a.t0 < cWaveReadyAt).length} pre-ready attempts, ${cWaveAttempts.filter((a) => a.t0 < cWaveReadyAt && a.ok).length} succeeded pre-ready`
				);
			}
		);
	}
);
