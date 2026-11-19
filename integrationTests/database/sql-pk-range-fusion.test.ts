/**
 * SQL two-sided primary-key range must fuse into ONE bounded range-seek (#1822).
 *
 * A `WHERE id >= a AND id < b` predicate previously mapped to two independent
 * single-sided conditions; Table.search led with `id >= a`, streaming from `a`
 * to the end of the table and filtering `< b` in memory — O(table) latency
 * regardless of how narrow the window is. The fix fuses the two bounds into a
 * single `gelt`/`gele`/… comparator so the storage layer issues one bounded
 * getRange — O(window), matching the ops `between` path.
 *
 * This runs against the NEW SQL engine (HARPER_SQL_ENGINE=new, no legacy
 * fallback) and pins:
 *   (a) correctness + parity — the explicit two-sided range returns exactly the
 *       window, identical to the ops `search_by_conditions` between path;
 *   (b) mid-table window — bounded anywhere, not just at id 0;
 *   (c) perf guard — the explicit `>= AND <` form is within a small constant
 *       factor of the equivalent `BETWEEN` (which always fused). Both SQL
 *       statements share the exact same engine/HTTP path, so the ratio isolates
 *       the planner: pre-fix it is O(table)/O(window) (~14–34× at this scale),
 *       post-fix it is ~1×. A regression to a full scan trips the assertion.
 */

import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sql-pk-range-fusion');
const SCHEMA = 'data';
const TABLE = 'Item';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

// A large table with a small fixed window: the window is O(1) of the table, so a
// bounded seek is flat while a full scan grows with N.
const N = 60_000;
const WINDOW = 500;
const MID = 30_000;
// The explicit range must not be dramatically slower than the equivalent BETWEEN
// (both fuse to one seek post-fix). Generous enough to never trip on runner
// noise, tight enough that an O(table) scan (~14–34× at N=60k) fails it.
const MAX_RATIO = 6;

type Client = ReturnType<typeof createApiClient>;

async function runSql(client: Client, where: string): Promise<{ ids: number[]; status: number; ms: number }> {
	const t0 = Date.now();
	const r = await client
		.req()
		.send({ operation: 'sql', sql: `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${where}` })
		.timeout(120_000);
	const ms = Date.now() - t0;
	const rows: { id: number }[] = Array.isArray(r.body) ? r.body : [];
	const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
	return { ids, status: r.status, ms };
}

async function opsBetween(client: Client, lo: number, hi: number): Promise<{ ids: number[]; status: number }> {
	const r = await client
		.req()
		.send({
			operation: 'search_by_conditions',
			schema: SCHEMA,
			table: TABLE,
			operator: 'and',
			conditions: [{ search_attribute: 'id', search_type: 'between', search_value: [lo, hi] }],
			get_attributes: ['id'],
		})
		.timeout(120_000);
	const rows: { id: number }[] = Array.isArray(r.body) ? r.body : [];
	const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
	return { ids, status: r.status };
}

/** Best-of-N wall time for a SQL WHERE (min removes upward scheduling/GC noise). */
async function bestMs(client: Client, where: string, iterations = 6): Promise<{ ids: number[]; ms: number }> {
	let ids: number[] = [];
	let best = Infinity;
	// One warmup pass (cold caches / JIT) before measuring.
	for (let i = -1; i < iterations; i++) {
		const r = await runSql(client, where);
		strictEqual(r.status, 200, `SQL "${where}" returned ${r.status}`);
		ids = r.ids;
		if (i >= 0) best = Math.min(best, r.ms);
	}
	return { ids, ms: best };
}

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo }, (_, i) => lo + i);

suite(
	`SQL two-sided PK range fusion [engine=${ENGINE}]`,
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: Client;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
				// Force the new SQL engine with no legacy fallback so a planner regression
				// can't be masked by AlaSQL.
				env: { HARPER_SQL_ENGINE: 'new' },
			});
			client = createApiClient(ctx.harper);
			await restartHttpWorkers(client, `/${TABLE}/`, 120_000);

			const CHUNK = 3000;
			for (let i = 0; i < N; i += CHUNK) {
				const records = range(i, Math.min(i + CHUNK, N)).map((id) => ({ id, filler: `row ${id}` }));
				await client
					.req()
					.send({ operation: 'insert', schema: SCHEMA, table: TABLE, records })
					.timeout(120_000)
					.expect(200);
			}
			console.log(`[sql-pk-range-fusion ${ENGINE}] seeded ${N} rows`);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// (a) The explicit two-sided range returns exactly the window, matching ops between.
		test('(a) leading-window >=/< returns exactly the window and matches ops between', async () => {
			const sqlR = await runSql(client, `id >= 0 AND id < ${WINDOW}`);
			strictEqual(sqlR.status, 200, `SQL returned ${sqlR.status}`);
			deepStrictEqual(sqlR.ids, range(0, WINDOW));

			const ops = await opsBetween(client, 0, WINDOW - 1);
			strictEqual(ops.status, 200, `search_by_conditions returned ${ops.status}`);
			deepStrictEqual(sqlR.ids, ops.ids);
		});

		// (b) A window in the middle of the key space is equally bounded/correct.
		test('(b) mid-table window >=/< returns exactly that window', async () => {
			const sqlR = await runSql(client, `id >= ${MID} AND id < ${MID + WINDOW}`);
			strictEqual(sqlR.status, 200, `SQL returned ${sqlR.status}`);
			deepStrictEqual(sqlR.ids, range(MID, MID + WINDOW));
		});

		// (c) The explicit `>= AND <` form must be range-seek-bounded like BETWEEN — not a
		// full scan. Same rows, and latency within a small constant factor.
		test('(c) explicit >=/< is bounded like BETWEEN (not a full scan)', async () => {
			const explicit = await bestMs(client, `id >= 0 AND id < ${WINDOW}`);
			const between = await bestMs(client, `id BETWEEN 0 AND ${WINDOW - 1}`);
			deepStrictEqual(explicit.ids, range(0, WINDOW));
			deepStrictEqual(between.ids, range(0, WINDOW));

			const ratio = explicit.ms / Math.max(between.ms, 1);
			console.log(
				`[sql-pk-range-fusion ${ENGINE}] N=${N} window=${WINDOW}: explicit=${explicit.ms}ms between=${between.ms}ms ratio=${ratio.toFixed(2)} (limit ${MAX_RATIO})`
			);
			ok(
				ratio <= MAX_RATIO,
				`explicit two-sided range ran ${ratio.toFixed(2)}× the BETWEEN baseline (>${MAX_RATIO}× ⇒ likely full-scanning O(table) instead of range-seeking O(window)); explicit=${explicit.ms}ms between=${between.ms}ms`
			);
		});
	}
);
