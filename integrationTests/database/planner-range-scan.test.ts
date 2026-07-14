/** Guards against a generalization of harper#1796 planner over-scan: PK-between + low-selectivity indexed-equals on a user table must return correct results flat across table growth. */
/**
 * QA-558 — generalization probe for harper#1796 (get_analytics condition-reordering
 * cost-misestimation), TESTING THE GENERALIZATION, NOT RE-PROVING #1796.
 *
 * #1796 (assigned to someone else, NOT re-repro'd here): in `get_analytics` on a large
 * `hdb_analytics` table, the planner costs an `equals` on an indexed attribute (`metric`)
 * BELOW a `between` on the primary key, so a narrow-time-window query scans the ENTIRE
 * history of that metric instead of the small PK range.
 *
 * HYPOTHESIS UNDER TEST: does the same cost-misestimation cause over-scans on an ORDINARY
 * USER TABLE — i.e. is this a general planner defect for `PK between X and Y AND indexedAttr
 * equals Z` (low-selectivity attr), or is it specific to the analytics/get_analytics query
 * construction?
 *
 * TABLE: Event { id: Long @primaryKey (0..N-1, monotonic), kind: String @indexed (90% of
 * rows = 'common', 10% = 'rare' — LOW selectivity), payload: String filler (forces real
 * row decode, not just an index-only count) }.
 *
 * FIXED PK WINDOW: id BETWEEN 5000 AND 5099 (100 rows), seeded in the FIRST batch and never
 * touched again — every later insert only appends higher ids, so the window's row set and
 * kind mix (~90 common / ~10 rare) never changes across tiers.
 *
 * METHOD: three tiers — N=100_000 (1x), N=200_000 (2x, +100_000 appended), N=300_000
 * (3x, +100_000 appended). At each tier, measure wall-clock time for:
 *   - PK-only control:      id BETWEEN 5000 AND 5099                      (should stay flat)
 *   - kind-only control:    kind = 'common'                               (should scale ~0.9*N)
 *   - combined (author order):  id BETWEEN ... AND kind = 'common'
 *   - combined (reversed order): kind = 'common' AND id BETWEEN ...
 * via BOTH SQL (`SELECT id, payload FROM data.Event WHERE ...`) and ops
 * `search_by_conditions` (get_attributes: ['id']).
 *
 * DISCRIMINATOR: if combined-query time TRACKS THE PK-ONLY CONTROL (flat across tiers) →
 * the planner correctly uses the narrow PK range → SCOPED-TO-ANALYTICS. If combined-query
 * time TRACKS THE KIND-ONLY CONTROL (grows ~linearly with N) → the planner is scanning the
 * wrong axis on an ordinary user table too → GENERALIZES (a broader planner defect).
 * Single-point timings are noisy; the tiered SCALING TREND is the actual signal, not any one
 * absolute number.
 *
 * Correctness (not just timing) is also asserted at every tier: the combined query must
 * always return exactly the ~90 rows in the window with kind='common', regardless of engine
 * plan choice — a scan-shape defect should not corrupt results, only cost.
 *
 * Engine: rocksdb (default). LMDB not run — this is a planner-cost question, not a storage-
 * engine question, and running both would ~double an already multi-minute test.
 *
 * Harper SHA: f85f41179 (main)
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/planner-range-scan.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'planner-range-scan');
const SCHEMA = 'data';
const TABLE = 'Event';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';
const skipSuite = process.platform === 'win32';

const BATCH_SIZE = 2_000;

// Fixed narrow PK window — seeded in tier 1, never touched again.
const WIN_LO = 5_000;
const WIN_HI = 5_099; // 100 ids, inclusive

// Cumulative row-count tiers. Each tier appends new higher ids on top of the previous tier.
const TIERS = [100_000, 200_000, 300_000];

type Client = ReturnType<typeof createApiClient>;
interface Row {
	id: number;
	kind: string;
	payload: string;
}

const PAYLOAD_FILLER = 'x'.repeat(64);

/** Deterministic 90/10 split: kind is a pure function of id, stable across tiers. */
function kindFor(i: number): string {
	return i % 10 < 9 ? 'common' : 'rare';
}

function makeEvent(i: number): Row {
	return { id: i, kind: kindFor(i), payload: `p-${i}-${PAYLOAD_FILLER}` };
}

/** Expected ids in the fixed window with kind='common', for correctness assertions. */
const EXPECTED_WINDOW_COMMON = new Set<number>();
for (let i = WIN_LO; i <= WIN_HI; i++) if (kindFor(i) === 'common') EXPECTED_WINDOW_COMMON.add(i);

async function insertRange(client: Client, startId: number, endExclusive: number): Promise<number> {
	const t0 = Date.now();
	for (let base = startId; base < endExclusive; base += BATCH_SIZE) {
		const end = Math.min(base + BATCH_SIZE, endExclusive);
		const records: Row[] = [];
		for (let i = base; i < end; i++) records.push(makeEvent(i));
		await client
			.req()
			.send({ operation: 'insert', schema: SCHEMA, table: TABLE, records })
			.timeout(120_000)
			.expect(200);
	}
	return Date.now() - t0;
}

async function sql(client: Client, where: string, attrs = 'id, payload'): Promise<{ rows: any[]; ms: number }> {
	const t0 = Date.now();
	const r = await client
		.req()
		.send({ operation: 'sql', sql: `SELECT ${attrs} FROM ${SCHEMA}.${TABLE} WHERE ${where}` })
		.timeout(120_000);
	const ms = Date.now() - t0;
	ok(r.status === 200, `SQL failed status=${r.status} where="${where}" body=${JSON.stringify(r.body)?.slice(0, 300)}`);
	return { rows: Array.isArray(r.body) ? r.body : [], ms };
}

async function searchByConditions(client: Client, conditions: any[]): Promise<{ rows: any[]; ms: number }> {
	const t0 = Date.now();
	const r = await client
		.req()
		.send({
			operation: 'search_by_conditions',
			schema: SCHEMA,
			table: TABLE,
			operator: 'and',
			conditions,
			get_attributes: ['id'],
		})
		.timeout(120_000);
	const ms = Date.now() - t0;
	ok(r.status === 200, `search_by_conditions failed status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 300)}`);
	return { rows: Array.isArray(r.body) ? r.body : [], ms };
}

const pkCond = { search_attribute: 'id', search_type: 'between', search_value: [WIN_LO, WIN_HI] };
const kindCond = { search_attribute: 'kind', search_type: 'equals', search_value: 'common' };

suite(`QA-558 planner over-scan generalization [engine=${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: Client;
	const timingLog: Array<{ tier: number; label: string; ms: number }> = [];

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: { HARPER_STORAGE_ENGINE: ENGINE } });
		client = createApiClient(ctx.harper);

		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest(`/${TABLE}/`).timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log('\n=== QA-558 timing log (engine=' + ENGINE + ') ===');
		for (const e of timingLog)
			console.log(`  tier=${String(e.tier).padStart(7)} ${e.label.padEnd(38)} ${String(e.ms).padStart(7)}ms`);

		// ── Verdict ──────────────────────────────────────────────────────────────
		const combined = timingLog.filter((e) => e.label === 'combined (author order) SQL');
		const pkOnly = timingLog.filter((e) => e.label === 'PK-only control SQL');
		const kindOnly = timingLog.filter((e) => e.label === 'kind-only control SQL');
		const pkOnlyOps = timingLog.filter((e) => e.label === 'PK-only control ops');
		const kindOnlyOps = timingLog.filter((e) => e.label === 'kind-only control ops');
		const combinedOps = timingLog.filter((e) => e.label === 'combined (author order) ops');
		const growth = (arr: typeof combined) => arr[arr.length - 1].ms / Math.max(1, arr[0].ms);
		if (combined.length === TIERS.length && pkOnly.length === TIERS.length && kindOnly.length === TIERS.length) {
			console.log(
				`\n[QA-558 VERDICT INPUTS] table growth=${(TIERS[TIERS.length - 1] / TIERS[0]).toFixed(2)}x\n` +
					`  SQL:  combined=${growth(combined).toFixed(2)}x  PK-only=${growth(pkOnly).toFixed(2)}x  kind-only=${growth(kindOnly).toFixed(2)}x\n` +
					`  ops:  combined=${growth(combinedOps).toFixed(2)}x  PK-only=${growth(pkOnlyOps).toFixed(2)}x  kind-only=${growth(kindOnlyOps).toFixed(2)}x`
			);
		}
	});

	// ── Tier loop: seed, then measure ─────────────────────────────────────────────

	let seededUpTo = 0;
	for (const N of TIERS) {
		test(`seed to N=${N} rows (append ${N - seededUpTo} new ids)`, async () => {
			const start = seededUpTo;
			const insertMs = await insertRange(client, start, N);
			console.log(`[QA-558] appended ids [${start}, ${N}) in ${insertMs}ms`);
			seededUpTo = N;
			const r = await client
				.req()
				.send({ operation: 'sql', sql: `SELECT count(*) AS c FROM ${SCHEMA}.${TABLE}` })
				.timeout(60_000);
			const count = Number((r.body as any)?.[0]?.c) || 0;
			strictEqual(count, N, `expected ${N} total rows after seeding, got ${count}`);
		});

		test(`N=${N}: PK-only control (id BETWEEN ${WIN_LO} AND ${WIN_HI}) — SQL + ops`, async () => {
			const { rows, ms } = await sql(client, `id BETWEEN ${WIN_LO} AND ${WIN_HI}`);
			timingLog.push({ tier: N, label: 'PK-only control SQL', ms });
			strictEqual(rows.length, WIN_HI - WIN_LO + 1, `PK-only window must return exactly ${WIN_HI - WIN_LO + 1} rows`);

			const opsR = await searchByConditions(client, [pkCond]);
			timingLog.push({ tier: N, label: 'PK-only control ops', ms: opsR.ms });
			strictEqual(
				opsR.rows.length,
				WIN_HI - WIN_LO + 1,
				`ops PK-only window must return exactly ${WIN_HI - WIN_LO + 1} rows`
			);

			console.log(
				`[QA-558 N=${N}] PK-only control: SQL ${rows.length} rows in ${ms}ms, ops ${opsR.rows.length} rows in ${opsR.ms}ms`
			);
		});

		test(`N=${N}: kind-only control (kind = 'common') — SQL + ops`, async () => {
			const { rows, ms } = await sql(client, `kind = 'common'`, 'id');
			timingLog.push({ tier: N, label: 'kind-only control SQL', ms });
			const expectedCount = Array.from({ length: N }, (_, i) => i).filter((i) => kindFor(i) === 'common').length;
			strictEqual(rows.length, expectedCount, `kind='common' must return ${expectedCount} rows at N=${N}`);

			const opsR = await searchByConditions(client, [kindCond]);
			timingLog.push({ tier: N, label: 'kind-only control ops', ms: opsR.ms });
			strictEqual(opsR.rows.length, expectedCount, `ops kind='common' must return ${expectedCount} rows at N=${N}`);

			console.log(
				`[QA-558 N=${N}] kind-only control: SQL ${rows.length} rows in ${ms}ms, ops ${opsR.rows.length} rows in ${opsR.ms}ms`
			);
		});

		test(`N=${N}: combined query, author order (PK between AND kind equals) — SQL + ops, both orders`, async () => {
			// SQL, author order
			const authorSql = await sql(client, `id BETWEEN ${WIN_LO} AND ${WIN_HI} AND kind = 'common'`);
			timingLog.push({ tier: N, label: 'combined (author order) SQL', ms: authorSql.ms });
			strictEqual(
				new Set(authorSql.rows.map((r: any) => r.id)).size,
				EXPECTED_WINDOW_COMMON.size,
				`combined SQL (author order) must return exactly ${EXPECTED_WINDOW_COMMON.size} rows at N=${N}`
			);

			// SQL, reversed order (per #1796 signature: condition REORDERING, so author order
			// in the query text may not matter — the planner reorders internally regardless).
			const reversedSql = await sql(client, `kind = 'common' AND id BETWEEN ${WIN_LO} AND ${WIN_HI}`);
			timingLog.push({ tier: N, label: 'combined (reversed order) SQL', ms: reversedSql.ms });
			strictEqual(
				new Set(reversedSql.rows.map((r: any) => r.id)).size,
				EXPECTED_WINDOW_COMMON.size,
				`combined SQL (reversed order) must return exactly ${EXPECTED_WINDOW_COMMON.size} rows at N=${N}`
			);

			// ops search_by_conditions, author order [pk, kind]
			const authorOps = await searchByConditions(client, [pkCond, kindCond]);
			timingLog.push({ tier: N, label: 'combined (author order) ops', ms: authorOps.ms });
			strictEqual(
				new Set(authorOps.rows.map((r: any) => r.id)).size,
				EXPECTED_WINDOW_COMMON.size,
				`combined ops (author order) must return exactly ${EXPECTED_WINDOW_COMMON.size} rows at N=${N}`
			);

			// ops search_by_conditions, reversed order [kind, pk]
			const reversedOps = await searchByConditions(client, [kindCond, pkCond]);
			timingLog.push({ tier: N, label: 'combined (reversed order) ops', ms: reversedOps.ms });
			strictEqual(
				new Set(reversedOps.rows.map((r: any) => r.id)).size,
				EXPECTED_WINDOW_COMMON.size,
				`combined ops (reversed order) must return exactly ${EXPECTED_WINDOW_COMMON.size} rows at N=${N}`
			);

			console.log(
				`[QA-558 N=${N}] combined: sql-author=${authorSql.ms}ms sql-reversed=${reversedSql.ms}ms ` +
					`ops-author=${authorOps.ms}ms ops-reversed=${reversedOps.ms}ms (all → ${EXPECTED_WINDOW_COMMON.size} rows)`
			);
		});
	}
});
