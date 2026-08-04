/**
 * QA-606 — the residual uncovered corner of QA-478: does an in-place cross-major upgrade,
 * once `randomAccessFields: true` is enabled and NEW writes are driven against it, route the
 * legacy-origin dataset onto the unbounded typed-struct path (#1453-class OOM), or does its
 * typedStructs count plateau the way a fresh-install table does (QA-598)?
 *
 * Background (what this does NOT re-derive)
 * -------------------------------------------
 * QA-478 (2026-07-06) already proved a genuine harperdb@4.7.34 -> current-main in-place
 * upgrade on the SAME dataRootDir migrates 20,000 width-drifting records DECODE-clean (0
 * mismatches/nulls, exact range-query ID-set match, durable across a 2nd cold restart, and
 * durable even with global randomAccessFields:true flipped for a 3rd restart). Its own explicit
 * caveat: it measured decode faithfulness ONLY. It never drove NEW writes against the upgraded
 * dataset with randomAccessFields:true active, so it never actually exercised the unbounded
 * typed-struct MINTING path (the OOM class) on a legacy-origin table -- only its 0-growth
 * classic-path absence. This suite closes that gap.
 *
 * Mechanism this scenario depends on (read, not assumed -- resources/databases.ts table()):
 *   "An explicit [randomAccessFields] directive PINS this table's encoding ... Tables WITHOUT
 *   the directive are intentionally not persisted here -- they follow the current global
 *   default on each open". harperdb@4.7.34 never wrote (or knew about) a randomAccessFields
 *   directive, so the migrated WidthDrift table's persisted primaryKeyAttribute carries no
 *   such flag -- it MUST follow whatever storage.randomAccessFields is set to globally on the
 *   restart that follows the migration. This is the mechanism the scenario asks us to exploit
 *   (not a schema.graphql directive -- see schema.graphql in the fixture for why WidthDrift is
 *   deliberately left undeclared there).
 *
 * Design -- controlled A/B on ONE running instance
 * -------------------------------------------------
 *   - Arm "upgraded": WidthDrift -- the harperdb@4.7.34-created, in-place-migrated table (this
 *     is the QA-478 fixture/dataset, reused as-is via the SAME legacy-boot -> seed -> stop ->
 *     migrate machinery).
 *   - Arm "fresh control": FreshControl -- a table current-main creates for the very first time
 *     (never touched by the v4 binary), with an EXPLICIT randomAccessFields: true directive --
 *     the QA-598-style plateau oracle, run live in THIS suite (not just cited from memory).
 *   - Both arms are driven by the IDENTICAL width-heterogeneous generator (QA-598's technique:
 *     fixed key set/order, counter width drifts across 3 temporal phases, score/gauge/label/tag
 *     cycle a fixed-radix odometer independent of position) at the SAME batch cadence, so any
 *     divergence between the two curves isolates "legacy-origin store" as the variable, not
 *     generator differences. IDs on both arms are padStart'ed to a CONSTANT width across the
 *     whole run (D-224: structon types strings by cumulative encode-time refOffset, not
 *     declared width -- an incidental id-width difference between arms would itself be a
 *     confound, so both arms hold id width constant even though their prefixes differ to avoid
 *     colliding with WidthDrift's pre-existing r0..r{N-1} legacy rows).
 *   - Per QA-598's own empirical finding: a write alone does not mint a typedStruct, only a
 *     decode does. Both arms' pre-existing classic-encoded (legacy, WidthDrift only) rows and
 *     newly-typed rows are decoded every checkpoint by the SAME full-table getRange scan,
 *     but struct-header bytes (0x20-0x3f, typed) and classic-record bytes (0x40-0x7f) are
 *     disjoint on read (OpenDBIObject.ts), so decoding old classic rows cannot itself mint new
 *     typedStructs entries -- only the newly-written typed rows can. This isolates the curve.
 *
 * Oracle (this scenario's verdict)
 * ---------------------------------
 *   PLATEAU / EXPECTED: WidthDrift's typedStructsLen trace rises in discrete steps and goes
 *   FLAT within the tail (mirrors QA-598's fresh-install curve), stays under the cap (256), and
 *   tracks FreshControl's curve closely (same generator, same cadence -> comparable shape
 *   counts).
 *   DEFECT / UNBOUNDED: WidthDrift's typedStructsLen exceeds the cap, or keeps climbing in the
 *   tail where FreshControl (or QA-598's own fresh-install baseline) has already gone flat, or
 *   diverges sharply upward from FreshControl's curve under IDENTICAL input.
 *
 * Standing rule D-224: do not predict shape counts from declared field widths -- measure.
 *
 * Requires HARPER_LEGACY_VERSION_PATH pointing at an installed `harperdb` v4.x package —
 * the SAME env var (and skip-guard) the existing 4.x-upgrade.test.ts in this directory
 * uses; skipped together with that suite when the var is absent. CI must provision a v4.x
 * `harperdb` install and export HARPER_LEGACY_VERSION_PATH, or this spec silently skips.
 *
 * Regression anchor: §2 axis G(cross-major-upgrade) × A(width-heterogeneous). Pins that the
 * #1453-class unbounded typed-struct (OOM) minting path does NOT reproduce on a legacy-origin
 * in-place-upgraded table under NEW randomAccessFields writes — the upgraded arm plateaus
 * identically to a fresh-install control. Promoted from qa-explorer QA-606 / candidate P-395.
 *
 * Cold-gated GREEN on harper main 56a2bace9 (2/2 pass; both arms plateau typedStructs=38,
 * upgraded/fresh ratio 1.00x; legacy precondition fired — not a silent skip).
 * Reproduction:
 *   HARPER_LEGACY_VERSION_PATH=/path/to/harperdb-4.x \
 *     npm run test:integration -- "integrationTests/upgrade/qa606-upgrade-structgrowth.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa606-upgrade-structgrowth');
const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
const testsBun = process.env.HARPER_RUNTIME === 'bun';

const CAP = 256; // RecordEncoder pins maxOwnStructures = 256 (resources/RecordEncoder.ts)

// ---- legacy seed (mirrors QA-478's buildSeedData -- the pre-upgrade dataset body) ----------
const SEED_COUNT = 5_000;
const RANGE_MIN = 50_000;
const RANGE_MAX = 3_000_000;

function buildLegacySeedData(count: number) {
	const INTS8 = [1, 2, 3, 100, 127];
	const INTS32 = [70000, 123456, 2_000_000_000];
	const FLOATS = [0.5, 1.23456789012345, 3.14159265358979, 1e-10, 1e100, -42.5];
	const STRLENS = [2, 8, 32, 128, 512];
	let a = 0x9e3779b9;
	const rng = () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const records: Array<Record<string, unknown>> = [];
	const idsInRange: string[] = [];
	for (let j = 0; j < count; j++) {
		let n: number;
		const kind = j % 4;
		if (kind === 0) n = INTS8[j % INTS8.length];
		else if (kind === 1) n = INTS32[j % INTS32.length];
		else if (kind === 2) n = FLOATS[j % FLOATS.length];
		else n = j;
		const rec: Record<string, unknown> = {
			id: `r${j}`,
			n,
			s: kind % 2 === 0 ? 'x'.repeat(STRLENS[j % STRLENS.length]) : j % 3,
		};
		if (rng() > 0.5) rec.extra1 = Math.floor(rng() * 1000);
		if (rng() > 0.5) rec.extra2 = rng();
		if (rng() > 0.5) rec.extra3 = 'tag' + (j % 7);
		records.push(rec);
		if (n >= RANGE_MIN && n <= RANGE_MAX) idsInRange.push(rec.id as string);
	}
	idsInRange.sort();
	return { records, idsInRange };
}

// ---- width-hetero NEW-write generator (QA-598's technique, reused verbatim) -----------------
// Fixed key SET/ORDER; only per-field value WIDTH varies. counter drifts across 3 TEMPORAL
// phases; score/gauge/label/tag cycle a fixed-radix odometer (3*2*4*4=96) independent of
// position. Applied IDENTICALLY to both arms so any curve divergence isolates store origin.
function counterValue(tier: number, idx: number): number {
	if (tier === 0) return 3 + (idx % 29);
	if (tier === 1) return 100_000 + (idx % 900_000);
	return Number.MAX_SAFE_INTEGER - (idx % 1_000_000);
}
function scoreValue(tier: number, idx: number): number {
	if (tier === 0) return idx % 31;
	if (tier === 1) return 300_000 + (idx % 700_000);
	return Number.MAX_SAFE_INTEGER - 7 - (idx % 500_000) * 3;
}
function gaugeValue(tier: number, idx: number): number {
	if (tier === 0) return 1.5 + (idx % 8) * 0.25;
	return Math.PI * (1 + (idx % 97));
}
function labelValue(tier: number, idx: number): string {
	if (tier === 0) return '';
	if (tier === 1) return 'lbl' + (idx % 97);
	if (tier === 2) return 'L'.repeat(300);
	return 'étiquette-' + (idx % 50);
}
function tagValue(tier: number, idx: number): string {
	if (tier === 0) return '';
	if (tier === 1) return 'tg' + (idx % 89);
	if (tier === 2) return 'T'.repeat(300);
	return '标签-' + (idx % 50);
}
function counterPhase(idx: number, total: number): number {
	if (idx < total / 3) return 0;
	if (idx < (2 * total) / 3) return 1;
	return 2;
}
const RADICES = [3, 2, 4, 4];
const ODOMETER_SIZE = RADICES.reduce((a, b) => a * b, 1);
function odometerDigits(idx: number): number[] {
	let rem = idx % ODOMETER_SIZE;
	const digits: number[] = [];
	for (let i = 0; i < RADICES.length; i++) {
		let placeValue = 1;
		for (let j = i + 1; j < RADICES.length; j++) placeValue *= RADICES[j];
		digits.push(Math.floor(rem / placeValue) % RADICES[i]);
	}
	return digits;
}
/** Width-heterogeneous record body (everything but id) -- identical across both arms. */
function hetBody(idx: number, total: number): Record<string, unknown> {
	const ct = counterPhase(idx, total);
	const [st, gt, lt, tt] = odometerDigits(idx);
	return {
		counter: counterValue(ct, idx),
		score: scoreValue(st, idx),
		gauge: gaugeValue(gt, idx),
		label: labelValue(lt, idx),
		tag: tagValue(tt, idx),
	};
}
// IDs held at a CONSTANT width across the whole run on BOTH arms (D-224: an incidental
// id-width drift between arms would itself confound refOffset-driven string typing). WidthDrift
// uses a distinct prefix only to avoid colliding with its pre-existing legacy r0..r{N-1} rows.
const ID_DIGITS = 6;
function widthDriftId(idx: number): string {
	return 'w' + String(idx).padStart(ID_DIGITS, '0');
}
function freshControlId(idx: number): string {
	return 'f' + String(idx).padStart(ID_DIGITS, '0');
}

interface TableStats {
	randomAccessStructure: boolean | null;
	maxOwnStructures: number | null;
	typedStructsLen: number | null;
	transitionNodes: number | null;
	scannedRecords: number | null;
}
interface StatsProbeResult {
	pid: number;
	heapUsed: number;
	rss: number;
	WidthDrift: TableStats;
	FreshControl: TableStats;
}
interface StructReportResult {
	pid: number;
	table: string;
	randomAccessStructure: boolean | null;
	typedStructs: number | null;
	classicStructures: number | null;
	maxOwnStructures: number | null;
}

suite(
	'QA-606: in-place upgrade + randomAccessFields NEW-write struct growth vs fresh-install control',
	{ skip: !legacyPath || testsBun || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		const { records: legacyRecords, idsInRange } = buildLegacySeedData(SEED_COUNT);
		let client: ReturnType<typeof createApiClient>;

		before(async () => {
			// Phase 1: boot the legacy v4.x instance raw and seed the pre-upgrade dataset —
			// identical machinery to QA-478.
			await startHarper(ctx, {
				config: {},
				env: { TC_AGREEMENT: 'yes' },
				harperBinPath: join(legacyPath!, 'bin', 'harperdb.js'),
			});
			await sendOperation(ctx.harper, { operation: 'create_schema', schema: 'data' });
			await sendOperation(ctx.harper, {
				operation: 'create_table',
				schema: 'data',
				table: 'WidthDrift',
				hash_attribute: 'id',
			});
			await sendOperation(ctx.harper, {
				operation: 'create_attribute',
				schema: 'data',
				table: 'WidthDrift',
				attribute: 'n',
			});
			const BATCH = 500;
			for (let i = 0; i < legacyRecords.length; i += BATCH) {
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					schema: 'data',
					table: 'WidthDrift',
					records: legacyRecords.slice(i, i + BATCH),
				});
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('precondition: legacy pre-upgrade ground truth matches the seed', async () => {
			const rows = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				schema: 'data',
				table: 'WidthDrift',
				conditions: [
					{ search_attribute: 'n', search_type: 'greater_than', search_value: RANGE_MIN },
					{ search_attribute: 'n', search_type: 'less_than_equal', search_value: RANGE_MAX },
				],
				operator: 'and',
				get_attributes: ['id'],
			});
			deepStrictEqual(
				(rows as Array<{ id: string }>).map((r) => r.id).sort(),
				idsInRange,
				'pre-upgrade range query on legacy v4 must match the ground truth ID set exactly'
			);
		});

		test(
			'in-place upgrade -> randomAccessFields enabled -> width-hetero NEW writes: WidthDrift vs FreshControl typedStructs curves',
			{ timeout: 600_000 },
			async () => {
				// ── Phase 2: stop legacy, drop the QA-606 probe component, upgrade in place ──────
				await killHarper(ctx);
				await mkdir(join(ctx.harper.dataRootDir, 'components'), { recursive: true });
				await cp(FIXTURE_PATH, join(ctx.harper.dataRootDir, 'components', 'qa606-probe'), {
					recursive: true,
					dereference: true,
				});

				await startHarper(ctx, {
					config: { storage: { migrateOnStart: true }, threads: { count: 1 } },
					env: {},
					startupTimeoutMs: 120_000,
				});
				// Capture startup output from THIS boot before it's overwritten by the next start.
				const migrationBootStdout = ctx.harper.startupOutput?.stdout ?? '';
				client = createApiClient(ctx.harper);

				// ── PRECONDITION 1 (hard): the migration actually ran, not a no-op / fresh dir ───
				ok(
					/Running migrate on start/i.test(migrationBootStdout),
					'[PRECONDITION FAILED] migrateOnStart never logged "Running migrate on start" -- ' +
						'migration path was not entered; the rest of this test would be measuring nothing'
				);
				ok(
					/[Mm]igrat(ed|ing) database ['"]?data['"]? (from LMDB )?to RocksDB/i.test(migrationBootStdout) ||
						/migrated database data to RocksDB/i.test(migrationBootStdout),
					'[PRECONDITION FAILED] no "migrat(ed|ing) database data ... to RocksDB" log line found -- ' +
						`the LMDB->RocksDB migration of the legacy dataset did not demonstrably complete. stdout tail:\n` +
						migrationBootStdout.slice(-2000)
				);

				// ── PRECONDITION 2 (hard): the migrated dataset decodes clean BEFORE we touch it ─
				const scan = await fetch(`${ctx.harper.httpURL}/ScanVerify606/?table=WidthDrift`).then((r) => r.json());
				strictEqual(scan.count, SEED_COUNT, `expected ${SEED_COUNT} legacy rows after migration, got ${scan.count}`);
				strictEqual(scan.nullValues, 0, `[DEFECT] ${scan.nullValues} undecodable/null legacy rows after migration`);
				const rangeRows = await sendOperation(ctx.harper, {
					operation: 'search_by_conditions',
					schema: 'data',
					table: 'WidthDrift',
					conditions: [
						{ attribute: 'n', comparator: 'greater_than', value: RANGE_MIN },
						{ attribute: 'n', comparator: 'less_than_equal', value: RANGE_MAX },
					],
					operator: 'and',
					get_attributes: ['id'],
				});
				deepStrictEqual(
					(rangeRows as Array<{ id: string }>).map((r) => r.id).sort(),
					idsInRange,
					'[PRECONDITION FAILED] post-migration range query does not match pre-upgrade ground truth'
				);

				// Baseline struct report BEFORE the config flip: WidthDrift has no per-table
				// randomAccessFields directive and the global default is still off here.
				const preFlip = (await (
					await fetch(`${ctx.harper.httpURL}/StructReport606/?table=WidthDrift`)
				).json()) as StructReportResult;
				ok(
					preFlip.randomAccessStructure !== true,
					`expected WidthDrift NOT on the randomAccess path before the config flip; got randomAccessStructure=${preFlip.randomAccessStructure}`
				);

				// ── Phase 3: restart with storage.randomAccessFields:true (global) -- the lever ─
				// that routes tables WITHOUT a persisted per-table directive (WidthDrift, a v4-era
				// migrated table, has none) onto the typed struct path (databases.ts table()).
				await killHarper(ctx);
				await startHarper(ctx, {
					config: { storage: { randomAccessFields: true }, threads: { count: 1 } },
					env: {},
					startupTimeoutMs: 120_000,
				});
				client = createApiClient(ctx.harper);

				// ── PRECONDITION 3 (hard): randomAccessFields ACTUALLY took effect on the migrated
				// table -- a green curve that never entered the typed-struct path proves nothing.
				const postFlipWidthDrift = (await (
					await fetch(`${ctx.harper.httpURL}/StructReport606/?table=WidthDrift`)
				).json()) as StructReportResult;
				ok(
					postFlipWidthDrift.randomAccessStructure === true,
					`[PRECONDITION FAILED] WidthDrift is not on the randomAccess typed path after the global ` +
						`storage.randomAccessFields:true restart (got ${postFlipWidthDrift.randomAccessStructure}) -- ` +
						'the legacy-origin table did not pick up the global default; the escape this scenario ' +
						'targets was never exercised'
				);
				const postFlipFreshControl = (await (
					await fetch(`${ctx.harper.httpURL}/StructReport606/?table=FreshControl`)
				).json()) as StructReportResult;
				ok(
					postFlipFreshControl.randomAccessStructure === true,
					`[PRECONDITION FAILED] FreshControl (explicit randomAccessFields:true directive) is not on ` +
						`the randomAccess typed path (got ${postFlipFreshControl.randomAccessStructure}) -- control arm is broken`
				);

				// ── Phase 4: drive IDENTICAL width-hetero NEW writes into BOTH arms, checkpointing
				// the real decode-minted typedStructs count after every batch.
				const TOTAL_RECORDS = 18_000;
				const BATCH_COUNT = 12;
				const RECORDS_PER_BATCH = TOTAL_RECORDS / BATCH_COUNT; // 1,500; phase boundaries land on batch edges

				async function checkpoint(batch: number) {
					const r = await client.reqRest('/StatsProbe606/').timeout(30_000);
					const body = r.body as StatsProbeResult;
					trace.push({ batch, heapUsed: body.heapUsed, widthDrift: body.WidthDrift, freshControl: body.FreshControl });
				}

				const trace: { batch: number; heapUsed: number; widthDrift: TableStats; freshControl: TableStats }[] = [];
				await checkpoint(0); // baseline, before any new writes post-flip

				for (let b = 0; b < BATCH_COUNT; b++) {
					const baseIdx = b * RECORDS_PER_BATCH;
					const widthDriftRecords = Array.from({ length: RECORDS_PER_BATCH }, (_, i) => {
						const idx = baseIdx + i;
						return { id: widthDriftId(idx), ...hetBody(idx, TOTAL_RECORDS) };
					});
					const freshControlRecords = Array.from({ length: RECORDS_PER_BATCH }, (_, i) => {
						const idx = baseIdx + i;
						return { id: freshControlId(idx), ...hetBody(idx, TOTAL_RECORDS) };
					});

					const wRes = await client
						.req()
						.send({ operation: 'insert', schema: 'data', table: 'WidthDrift', records: widthDriftRecords })
						.timeout(60_000);
					ok(
						wRes.status === 200,
						`WidthDrift batch ${b + 1} insert failed: status=${wRes.status} body=${JSON.stringify(wRes.body)}`
					);

					const fRes = await client
						.req()
						.send({ operation: 'insert', schema: 'data', table: 'FreshControl', records: freshControlRecords })
						.timeout(60_000);
					ok(
						fRes.status === 200,
						`FreshControl batch ${b + 1} insert failed: status=${fRes.status} body=${JSON.stringify(fRes.body)}`
					);

					await sleep(100);
					await checkpoint(b + 1);
				}

				// ---- growth-curve report ----
				console.log(
					`\n[QA-606] ${TOTAL_RECORDS} NEW records ingested into EACH arm across ${BATCH_COUNT} batches ` +
						`(WidthDrift also carries ${SEED_COUNT} pre-existing legacy classic-encoded rows):`
				);
				console.log(
					`  batch  heapUsedMB   WidthDrift.typedStructs  WidthDrift.transitionNodes  FreshControl.typedStructs`
				);
				for (const t of trace) {
					console.log(
						`  ${String(t.batch).padStart(5)}  ${(t.heapUsed / 1024 / 1024).toFixed(1).padStart(10)}  ` +
							`${String(t.widthDrift.typedStructsLen).padStart(23)}  ${String(t.widthDrift.transitionNodes).padStart(26)}  ` +
							`${String(t.freshControl.typedStructsLen).padStart(25)}`
					);
				}

				const widthDriftTrace = trace.map((t) => t.widthDrift.typedStructsLen ?? -1);
				const freshControlTrace = trace.map((t) => t.freshControl.typedStructsLen ?? -1);
				const heapTrace = trace.map((t) => t.heapUsed);

				const maxWidthDriftTyped = Math.max(...widthDriftTrace);
				const maxFreshControlTyped = Math.max(...freshControlTrace);

				const half = Math.floor(trace.length / 2);
				const firstHalfMaxHeap = Math.max(...heapTrace.slice(0, Math.max(1, half)));
				const secondHalfMaxHeap = Math.max(...heapTrace.slice(half));
				const heapRatio = secondHalfMaxHeap / Math.max(1, firstHalfMaxHeap);

				const tail = widthDriftTrace.slice(-4);
				const tailFlat = Math.max(...tail) - Math.min(...tail) === 0;
				const controlTail = freshControlTrace.slice(-4);
				const controlTailFlat = Math.max(...controlTail) - Math.min(...controlTail) === 0;

				const anyExceededCap = maxWidthDriftTyped > CAP;
				const anyMonotonicHeap = heapRatio > 3.0 && !tailFlat;
				// Divergence check: with an IDENTICAL generator/cadence, a legacy-origin defect
				// would show WidthDrift minting substantially MORE distinct shapes than the fresh
				// control under the same input (a generous 1.5x band -- exact equality isn't
				// guaranteed since the two stores' typedStructs caches are independent objects).
				const divergenceRatio = maxWidthDriftTyped / Math.max(1, maxFreshControlTyped);

				console.log(
					`\n[QA-606] SUMMARY:\n` +
						`  WidthDrift (upgraded)   typedStructs: max=${maxWidthDriftTyped} (cap=${CAP}) tailFlat=${tailFlat}\n` +
						`  FreshControl (fresh)    typedStructs: max=${maxFreshControlTyped} tailFlat=${controlTailFlat}\n` +
						`  upgraded/fresh shape-count ratio = ${divergenceRatio.toFixed(2)}x\n` +
						`  heapUsed ratio (2ndHalfMax/1stHalfMax) = ${heapRatio.toFixed(3)}`
				);
				console.log(
					`\n  >>> VERDICT: ${
						!anyExceededCap && tailFlat && divergenceRatio <= 1.5
							? 'PLATEAU / EXPECTED (upgraded arm tracks the fresh-install control; no unbounded growth)'
							: anyExceededCap
								? 'DEFECT -- WidthDrift typedStructs EXCEEDED the maxOwnStructures cap'
								: divergenceRatio > 1.5
									? 'DEFECT -- WidthDrift minted substantially MORE shapes than the fresh control under identical input'
									: 'DEFECT -- WidthDrift typedStructs did not plateau (still climbing in the tail)'
					} <<<`
				);

				// ---- assertions ----
				// REGRESSION ANCHOR 1: cap must never be exceeded, at any checkpoint.
				ok(
					!anyExceededCap,
					`WidthDrift typedStructs exceeded maxOwnStructures cap (${CAP}) at some checkpoint (max=${maxWidthDriftTyped}) — DEFECT`
				);

				// REGRESSION ANCHOR 2: probe must actually be exercising the mint path (rules out a
				// broken/frozen-encoder read) but stay well under the cap.
				ok(
					maxWidthDriftTyped > 1,
					`WidthDrift typedStructs should mint multiple real shapes under width drift; got max=${maxWidthDriftTyped} — probe may be broken`
				);
				ok(maxWidthDriftTyped < CAP, `WidthDrift typedStructs reached the cap (${CAP}); got max=${maxWidthDriftTyped}`);

				// REGRESSION ANCHOR 3: tail must be flat -- no growth after the shape universe is
				// exhausted (the plateau signature; failing this is the "grows unbounded" defect).
				ok(tailFlat, `WidthDrift typedStructs tail is not flat — still growing at the end: tail=[${tail.join(',')}]`);

				// REGRESSION ANCHOR 4: fresh control must also mint multiple shapes and plateau
				// (sanity -- confirms the oracle itself is alive in THIS run, not just cited from QA-598).
				ok(
					maxFreshControlTyped > 1,
					`FreshControl typedStructs should mint multiple real shapes; got max=${maxFreshControlTyped} — control probe may be broken`
				);
				ok(
					controlTailFlat,
					`FreshControl (fresh-install) typedStructs tail is not flat: tail=[${controlTail.join(',')}] — the oracle itself failed to plateau in this run`
				);

				// REGRESSION ANCHOR 5: heap must not blow up (generous 3x bound, same heuristic as QA-598/QA-305).
				ok(!anyMonotonicHeap, `heap grew monotonically (>3x, non-plateauing) under a stable working set — DEFECT`);

				// REGRESSION ANCHOR 6 (the decisive upgrade-vs-fresh comparison): under IDENTICAL
				// generator/cadence, the upgraded arm must not mint substantially more shapes than
				// the fresh-install control.
				ok(
					divergenceRatio <= 1.5,
					`[DEFECT] WidthDrift (upgraded) minted ${maxWidthDriftTyped} shapes vs FreshControl's ${maxFreshControlTyped} ` +
						`under an IDENTICAL width-hetero write workload (ratio=${divergenceRatio.toFixed(2)}x) — the legacy-origin ` +
						'table diverges from the fresh-install plateau'
				);
			}
		);
	}
);
