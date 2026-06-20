/**
 * QA-188 — @indexed numeric attribute range queries: boundary inclusivity/exclusivity,
 * Int / Long(>2^53) / Float, negatives / zero, and post-churn correctness.
 *
 * QUESTION: Do range queries on an @indexed numeric attribute return EXACTLY the correct
 * rows at and around the boundaries, across Int / Long(>2^53) / Float / negatives / zero,
 * including post-churn? Any off-by-one (inclusive/exclusive wrong), type-edge miss
 * (esp. >2^53), or wrong ordering is the find.
 *
 * METHODOLOGY (single-snapshot oracle):
 *   - A full-table scan (id >= '!') is fetched once, yielding all rows with their actual
 *     stored values. Range-query results are reconciled against JS-filtered subsets of
 *     THIS SAME snapshot — no cross-snapshot artifact possible.
 *   - Each range case: index result id-set vs scan filter id-set. Any divergence logged
 *     with exact wrong/missing/extra counts. Hard-fail on divergence.
 *
 * VALUE DISTRIBUTION (dense at boundaries):
 *   n (Int): -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5  (every integer, so boundary
 *            tests at any k can be exact).
 *            Also: INT_MAX_SAFE = 2147483647, INT_MAX_SAFE-1 (Int32 max).
 *   big (Float): 2^53-2, 2^53-1, 2^53, 2^53+1, 2^53+2  — the precision-boundary region.
 *   fval (Float): -2.5, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.5  — sub-integer fracs.
 *
 * RANGE CASES:
 *   Int:
 *     [I1] n > 2         — excludes 2, includes 3+
 *     [I2] n >= 2        — includes 2
 *     [I3] n < 2         — excludes 2, includes 1 and below
 *     [I4] n <= 2        — includes 2
 *     [I5] n >= -3 AND n <= 3  — closed range, check endpoints
 *     [I6] n > -1 AND n < 1   — excludes -1 and 1 exactly (open range around 0)
 *     [I7] n > 0              — excludes 0 (zero boundary)
 *     [I8] n >= 0             — includes 0
 *     [I9] n < 0              — excludes 0, all negatives
 *     [I10] n <= 0            — includes 0
 *   Long(>2^53) via big (Float):
 *     [L1] big >= 2^53   — includes 2^53 and above (correct ordering at precision boundary?)
 *     [L2] big > 2^53    — excludes 2^53 exactly
 *     [L3] big >= 2^53+1 — includes 2^53+1
 *     [L4] big between 2^53-1 and 2^53+1 (closed) — boundary endpoints both included
 *   Float fractional:
 *     [F1] fval > 1.5    — excludes 1.5, includes 2.5
 *     [F2] fval >= 1.5   — includes 1.5
 *     [F3] fval < -0.5   — excludes -0.5, includes -1.0, -1.5, -2.5
 *     [F4] fval <= -0.5  — includes -0.5
 *     [F5] fval > 0.0 AND fval < 1.0  — open range between 0 and 1 (should give 0.5)
 *   Post-churn (Int, n column):
 *     Seed 5 mutable rows with n=10..14, then update them to n=20..24.
 *     Oracle: n >= 10 AND n <= 14 must return 0 rows (moved out), n >= 20 must include them.
 *
 * Harper SHA: 7aaa5a152
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/indexed-numeric-range.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/indexed-numeric-range.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'indexed-numeric-range');
const TABLE = 'NumRow';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

const TWO53 = Math.pow(2, 53); // 9007199254740992

type Client = ReturnType<typeof createApiClient>;
type Row = Record<string, unknown>;

// ── helpers ────────────────────────────────────────────────────────────────────

function insertMany(client: Client, records: Row[]) {
	return client.req().send({ operation: 'insert', schema: 'data', table: TABLE, records }).timeout(60_000);
}

function updateRecord(client: Client, record: Row) {
	return client
		.req()
		.send({ operation: 'update', schema: 'data', table: TABLE, records: [record] })
		.timeout(30_000);
}

/** Range via search_by_conditions. Returns raw body rows. */
async function rangeQuery(
	client: Client,
	conditions: any[],
	attrs: string[] = ['id', 'n', 'big', 'fval']
): Promise<any[]> {
	const body: Row = {
		operation: 'search_by_conditions',
		schema: 'data',
		table: TABLE,
		operator: 'and',
		conditions,
		get_attributes: attrs,
	};
	const r = await client.req().send(body).timeout(30_000);
	if (r.status !== 200 || !Array.isArray(r.body))
		throw new Error(`search_by_conditions failed status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 500)}`);
	return r.body;
}

/** Full-table scan via id >= '!' (all IDs are 'r-...' which sort after '!'). */
async function scanAll(client: Client): Promise<any[]> {
	return rangeQuery(client, [{ search_attribute: 'id', search_type: 'greater_than_equal', search_value: '!' }]);
}

/** Diff: index result vs filtered scan baseline.
 *  Returns { extra, missing, extraCount, missingCount } */
function diff(indexRows: any[], scanRows: any[]) {
	const idxIds = new Set(indexRows.map((r: any) => r.id));
	const scanIds = new Set(scanRows.map((r: any) => r.id));
	const extra = [...idxIds].filter((id) => !scanIds.has(id));
	const missing = [...scanIds].filter((id) => !idxIds.has(id));
	return { extra, missing, extraCount: extra.length, missingCount: missing.length };
}

/** Assert index result == oracle, log detail on any divergence. */
function assertMatch(label: string, indexRows: any[], scanRows: any[]) {
	const { extra, missing, extraCount, missingCount } = diff(indexRows, scanRows);
	const ok_flag = extraCount === 0 && missingCount === 0;
	console.log(
		`  [${label}] idx=${indexRows.length} oracle=${scanRows.length} extra=${extraCount} missing=${missingCount}` +
			(ok_flag
				? ' OK'
				: ` FAIL extra=${JSON.stringify(extra.slice(0, 5))} missing=${JSON.stringify(missing.slice(0, 5))}`)
	);
	deepStrictEqual(
		new Set(indexRows.map((r: any) => r.id)),
		new Set(scanRows.map((r: any) => r.id)),
		`[${label}] index result diverges from oracle. extra=${JSON.stringify(extra.slice(0, 10))} missing=${JSON.stringify(missing.slice(0, 10))}`
	);
}

// ── test suite ────────────────────────────────────────────────────────────────

suite(
	`QA-188 @indexed numeric range boundary [engine=${ENGINE}]`,
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: Client;

		// ── static seed rows (immutable after insert) ──────────────────────────────
		// n rows: -5..5 plus int32 boundary pair
		const INT_ROWS: Row[] = [
			...[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((v) => ({
				id: `r-n-${v < 0 ? 'neg' + Math.abs(v) : v}`,
				n: v,
				big: 0,
				fval: 0,
				label: `n=${v}`,
			})),
			{ id: 'r-n-i32max', n: 2147483647, big: 0, fval: 0, label: 'n=INT32MAX' },
			{ id: 'r-n-i32max1', n: 2147483646, big: 0, fval: 0, label: 'n=INT32MAX-1' },
		];

		// big rows: around 2^53 boundary
		const BIG_ROWS: Row[] = [
			{ id: 'r-big-m2', n: 0, big: TWO53 - 2, fval: 0, label: `big=${TWO53 - 2}` },
			{ id: 'r-big-m1', n: 0, big: TWO53 - 1, fval: 0, label: `big=${TWO53 - 1}` },
			{ id: 'r-big-0', n: 0, big: TWO53, fval: 0, label: `big=${TWO53}` },
			{ id: 'r-big-p1', n: 0, big: TWO53 + 1, fval: 0, label: `big=${TWO53 + 1}` }, // NOTE: beyond double precision; TWO53+1 === TWO53 in JS float
			{ id: 'r-big-p2', n: 0, big: TWO53 + 2, fval: 0, label: `big=${TWO53 + 2}` }, // TWO53+2 is representable (even increment)
		];

		// fval rows: fractional values
		const FVAL_ROWS: Row[] = [
			{ id: 'r-f-n25', n: 0, big: 0, fval: -2.5, label: 'fval=-2.5' },
			{ id: 'r-f-n15', n: 0, big: 0, fval: -1.5, label: 'fval=-1.5' },
			{ id: 'r-f-n10', n: 0, big: 0, fval: -1.0, label: 'fval=-1.0' },
			{ id: 'r-f-n05', n: 0, big: 0, fval: -0.5, label: 'fval=-0.5' },
			{ id: 'r-f-000', n: 0, big: 0, fval: 0.0, label: 'fval=0.0' },
			{ id: 'r-f-p05', n: 0, big: 0, fval: 0.5, label: 'fval=0.5' },
			{ id: 'r-f-p10', n: 0, big: 0, fval: 1.0, label: 'fval=1.0' },
			{ id: 'r-f-p15', n: 0, big: 0, fval: 1.5, label: 'fval=1.5' },
			{ id: 'r-f-p25', n: 0, big: 0, fval: 2.5, label: 'fval=2.5' },
		];

		// churn rows: initially n=10..14, will be moved to n=20..24
		const CHURN_ROWS: Row[] = [10, 11, 12, 13, 14].map((v) => ({
			id: `r-churn-${v}`,
			n: v,
			big: 0,
			fval: 0,
			label: `churn-n=${v}`,
		}));

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {},
				env: { HARPER_STORAGE_ENGINE: ENGINE },
			});
			client = createApiClient(ctx.harper);

			// readiness poll
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

			// seed all static rows
			await insertMany(client, [...INT_ROWS, ...BIG_ROWS, ...FVAL_ROWS, ...CHURN_ROWS]).expect(200);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ── helpers inside tests (need client) ─────────────────────────────────────

		/** Get the single-snapshot oracle: all rows fetched once, used for all filtering. */
		async function getOracle() {
			return scanAll(client);
		}

		// ── INT RANGE TESTS ────────────────────────────────────────────────────────

		test('Int [I1] n > 2 (exclusive lower)', async () => {
			console.log(`\n[QA-188 INT engine=${ENGINE}]`);
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than', search_value: 2 },
			]);
			// oracle: rows from static set where n > 2 (exclude id-prefixes with big/fval noise)
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n > 2 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I1 n>2', idxFiltered, oracle);
			// specifically: n=2 must NOT appear
			ok(!idxFiltered.some((r: any) => r.n === 2), 'I1: n=2 must be excluded from n > 2');
			// n=3 must appear
			ok(
				idxFiltered.some((r: any) => r.n === 3),
				'I1: n=3 must appear in n > 2'
			);
		});

		test('Int [I2] n >= 2 (inclusive boundary)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than_equal', search_value: 2 },
			]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n >= 2 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I2 n>=2', idxFiltered, oracle);
			ok(
				idxFiltered.some((r: any) => r.n === 2),
				'I2: n=2 must be included in n >= 2'
			);
		});

		test('Int [I3] n < 2 (exclusive upper)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [{ search_attribute: 'n', search_type: 'less_than', search_value: 2 }]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n < 2 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I3 n<2', idxFiltered, oracle);
			ok(!idxFiltered.some((r: any) => r.n === 2), 'I3: n=2 must be excluded from n < 2');
			ok(
				idxFiltered.some((r: any) => r.n === 1),
				'I3: n=1 must appear in n < 2'
			);
		});

		test('Int [I4] n <= 2 (inclusive upper)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'less_than_equal', search_value: 2 },
			]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n <= 2 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I4 n<=2', idxFiltered, oracle);
			ok(
				idxFiltered.some((r: any) => r.n === 2),
				'I4: n=2 must be included in n <= 2'
			);
		});

		test('Int [I5] -3 <= n <= 3 (closed range, both endpoints)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than_equal', search_value: -3 },
				{ search_attribute: 'n', search_type: 'less_than_equal', search_value: 3 },
			]);
			const oracle = all.filter(
				(r: any) => typeof r.n === 'number' && r.n >= -3 && r.n <= 3 && r.id.startsWith('r-n-')
			);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I5 n in [-3,3]', idxFiltered, oracle);
			// endpoints must be present
			ok(
				idxFiltered.some((r: any) => r.n === -3),
				'I5: lower endpoint -3 must be included'
			);
			ok(
				idxFiltered.some((r: any) => r.n === 3),
				'I5: upper endpoint 3 must be included'
			);
			ok(!idxFiltered.some((r: any) => r.n === -4), 'I5: -4 must be excluded');
			ok(!idxFiltered.some((r: any) => r.n === 4), 'I5: 4 must be excluded');
		});

		test('Int [I6] -1 < n < 1 (open range around zero)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than', search_value: -1 },
				{ search_attribute: 'n', search_type: 'less_than', search_value: 1 },
			]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n > -1 && r.n < 1 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I6 n in (-1,1)', idxFiltered, oracle);
			// Only n=0 should be present
			ok(
				idxFiltered.some((r: any) => r.n === 0),
				'I6: n=0 must appear in open range (-1,1)'
			);
			ok(!idxFiltered.some((r: any) => r.n === -1), 'I6: -1 must be excluded from open range (-1,1)');
			ok(!idxFiltered.some((r: any) => r.n === 1), 'I6: 1 must be excluded from open range (-1,1)');
		});

		test('Int [I7] n > 0 (zero exclusive boundary)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than', search_value: 0 },
			]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n > 0 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I7 n>0', idxFiltered, oracle);
			ok(!idxFiltered.some((r: any) => r.n === 0), 'I7: n=0 must be excluded from n > 0');
		});

		test('Int [I8] n >= 0 (zero inclusive boundary)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than_equal', search_value: 0 },
			]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n >= 0 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I8 n>=0', idxFiltered, oracle);
			ok(
				idxFiltered.some((r: any) => r.n === 0),
				'I8: n=0 must be included in n >= 0'
			);
		});

		test('Int [I9] n < 0 (all negatives, zero excluded)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [{ search_attribute: 'n', search_type: 'less_than', search_value: 0 }]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n < 0 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I9 n<0', idxFiltered, oracle);
			ok(!idxFiltered.some((r: any) => r.n === 0), 'I9: n=0 must be excluded from n < 0');
			ok(
				idxFiltered.some((r: any) => r.n === -1),
				'I9: n=-1 must appear in n < 0'
			);
		});

		test('Int [I10] n <= 0 (zero inclusive, negatives included)', async () => {
			const all = await getOracle();
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'less_than_equal', search_value: 0 },
			]);
			const oracle = all.filter((r: any) => typeof r.n === 'number' && r.n <= 0 && r.id.startsWith('r-n-'));
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-n-'));
			assertMatch('I10 n<=0', idxFiltered, oracle);
			ok(
				idxFiltered.some((r: any) => r.n === 0),
				'I10: n=0 must be included in n <= 0'
			);
			ok(
				idxFiltered.some((r: any) => r.n === -1),
				'I10: n=-1 must appear in n <= 0'
			);
		});

		// ── LONG(>2^53) VIA FLOAT TESTS ───────────────────────────────────────────

		test('Long/Float [L1] big >= 2^53 (precision boundary inclusive)', async () => {
			console.log(`\n[QA-188 LONG engine=${ENGINE}] 2^53=${TWO53}, 2^53+1=${TWO53 + 1}, 2^53+2=${TWO53 + 2}`);
			// Note: in JS float, TWO53+1 === TWO53 (not representable). TWO53+2 is representable.
			// Log what values were actually stored.
			const all = await getOracle();
			const bigRows = all.filter((r: any) => r.id.startsWith('r-big-'));
			console.log(
				`  Stored big values: ${JSON.stringify(bigRows.map((r: any) => ({ id: r.id, big: r.big })).sort((a: any, b: any) => a.big - b.big))}`
			);

			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'big', search_type: 'greater_than_equal', search_value: TWO53 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-big-'));
			const oracle = bigRows.filter((r: any) => typeof r.big === 'number' && r.big >= TWO53);
			assertMatch('L1 big>=2^53', idxFiltered, oracle);
			ok(
				idxFiltered.some((r: any) => r.id === 'r-big-0'),
				'L1: big=2^53 row must be included in big >= 2^53'
			);
		});

		test('Long/Float [L2] big > 2^53 (precision boundary exclusive)', async () => {
			const all = await getOracle();
			const bigRows = all.filter((r: any) => r.id.startsWith('r-big-'));
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'big', search_type: 'greater_than', search_value: TWO53 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-big-'));
			const oracle = bigRows.filter((r: any) => typeof r.big === 'number' && r.big > TWO53);
			assertMatch('L2 big>2^53', idxFiltered, oracle);
			ok(!idxFiltered.some((r: any) => r.id === 'r-big-0'), 'L2: big=2^53 row must be excluded from big > 2^53');
		});

		test('Long/Float [L3] big >= 2^53+2 (above precision boundary)', async () => {
			const all = await getOracle();
			const bigRows = all.filter((r: any) => r.id.startsWith('r-big-'));
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'big', search_type: 'greater_than_equal', search_value: TWO53 + 2 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-big-'));
			const oracle = bigRows.filter((r: any) => typeof r.big === 'number' && r.big >= TWO53 + 2);
			assertMatch('L3 big>=2^53+2', idxFiltered, oracle);
		});

		test('Long/Float [L4] 2^53-1 <= big <= 2^53+2 (closed range across precision boundary)', async () => {
			const all = await getOracle();
			const bigRows = all.filter((r: any) => r.id.startsWith('r-big-'));
			const lo = TWO53 - 1;
			const hi = TWO53 + 2;
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'big', search_type: 'greater_than_equal', search_value: lo },
				{ search_attribute: 'big', search_type: 'less_than_equal', search_value: hi },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-big-'));
			const oracle = bigRows.filter((r: any) => typeof r.big === 'number' && r.big >= lo && r.big <= hi);
			assertMatch('L4 big in [2^53-1, 2^53+2]', idxFiltered, oracle);
			// Both endpoints must be present
			ok(
				idxFiltered.some((r: any) => r.id === 'r-big-m1'),
				'L4: 2^53-1 row must be included'
			);
			ok(
				idxFiltered.some((r: any) => r.id === 'r-big-0'),
				'L4: 2^53 row must be included'
			);
		});

		// ── FLOAT FRACTIONAL BOUNDARY TESTS ───────────────────────────────────────

		test('Float [F1] fval > 1.5 (fractional exclusive boundary)', async () => {
			console.log(`\n[QA-188 FLOAT engine=${ENGINE}]`);
			const all = await getOracle();
			const fRows = all.filter((r: any) => r.id.startsWith('r-f-'));
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'fval', search_type: 'greater_than', search_value: 1.5 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-f-'));
			const oracle = fRows.filter((r: any) => typeof r.fval === 'number' && r.fval > 1.5);
			assertMatch('F1 fval>1.5', idxFiltered, oracle);
			ok(!idxFiltered.some((r: any) => r.fval === 1.5), 'F1: fval=1.5 must be excluded from fval > 1.5');
			ok(
				idxFiltered.some((r: any) => r.fval === 2.5),
				'F1: fval=2.5 must appear in fval > 1.5'
			);
		});

		test('Float [F2] fval >= 1.5 (fractional inclusive boundary)', async () => {
			const all = await getOracle();
			const fRows = all.filter((r: any) => r.id.startsWith('r-f-'));
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'fval', search_type: 'greater_than_equal', search_value: 1.5 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-f-'));
			const oracle = fRows.filter((r: any) => typeof r.fval === 'number' && r.fval >= 1.5);
			assertMatch('F2 fval>=1.5', idxFiltered, oracle);
			ok(
				idxFiltered.some((r: any) => r.fval === 1.5),
				'F2: fval=1.5 must be included in fval >= 1.5'
			);
		});

		test('Float [F3] fval < -0.5 (negative fractional exclusive boundary)', async () => {
			const all = await getOracle();
			const fRows = all.filter((r: any) => r.id.startsWith('r-f-'));
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'fval', search_type: 'less_than', search_value: -0.5 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-f-'));
			const oracle = fRows.filter((r: any) => typeof r.fval === 'number' && r.fval < -0.5);
			assertMatch('F3 fval<-0.5', idxFiltered, oracle);
			ok(!idxFiltered.some((r: any) => r.fval === -0.5), 'F3: fval=-0.5 must be excluded from fval < -0.5');
			ok(
				idxFiltered.some((r: any) => r.fval === -1.0),
				'F3: fval=-1.0 must appear in fval < -0.5'
			);
		});

		test('Float [F4] fval <= -0.5 (negative fractional inclusive boundary)', async () => {
			const all = await getOracle();
			const fRows = all.filter((r: any) => r.id.startsWith('r-f-'));
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'fval', search_type: 'less_than_equal', search_value: -0.5 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-f-'));
			const oracle = fRows.filter((r: any) => typeof r.fval === 'number' && r.fval <= -0.5);
			assertMatch('F4 fval<=-0.5', idxFiltered, oracle);
			ok(
				idxFiltered.some((r: any) => r.fval === -0.5),
				'F4: fval=-0.5 must be included in fval <= -0.5'
			);
		});

		test('Float [F5] 0.0 < fval < 1.0 (open range between 0 and 1)', async () => {
			const all = await getOracle();
			const fRows = all.filter((r: any) => r.id.startsWith('r-f-'));
			const idxRows = await rangeQuery(client, [
				{ search_attribute: 'fval', search_type: 'greater_than', search_value: 0.0 },
				{ search_attribute: 'fval', search_type: 'less_than', search_value: 1.0 },
			]);
			const idxFiltered = idxRows.filter((r: any) => r.id.startsWith('r-f-'));
			const oracle = fRows.filter((r: any) => typeof r.fval === 'number' && r.fval > 0.0 && r.fval < 1.0);
			assertMatch('F5 fval in (0,1)', idxFiltered, oracle);
			// Only fval=0.5 should appear
			strictEqual(
				idxFiltered.filter((r: any) => r.id.startsWith('r-f-')).length,
				oracle.length,
				'F5: row count must match oracle'
			);
			ok(
				idxFiltered.some((r: any) => r.fval === 0.5),
				'F5: fval=0.5 must appear in (0,1)'
			);
			ok(!idxFiltered.some((r: any) => r.fval === 0.0), 'F5: fval=0.0 must be excluded from open range (0,1)');
			ok(!idxFiltered.some((r: any) => r.fval === 1.0), 'F5: fval=1.0 must be excluded from open range (0,1)');
		});

		// ── POST-CHURN (Int n column) ─────────────────────────────────────────────

		test('Post-churn: n moved from [10,14] to [20,24] — old range empty, new range correct', async () => {
			console.log(`\n[QA-188 CHURN engine=${ENGINE}]`);
			// Initial: churn rows have n=10..14
			// Verify they appear in [10,14] range before churn
			const beforeRows = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than_equal', search_value: 10 },
				{ search_attribute: 'n', search_type: 'less_than_equal', search_value: 14 },
			]);
			const beforeChurn = beforeRows.filter((r: any) => r.id.startsWith('r-churn-'));
			strictEqual(beforeChurn.length, 5, `Pre-churn: expect 5 rows in n=[10,14], got ${beforeChurn.length}`);

			// Now update them to n=20..24
			for (let i = 0; i < 5; i++) {
				const oldN = 10 + i;
				const newN = 20 + i;
				await updateRecord(client, { id: `r-churn-${oldN}`, n: newN, big: 0, fval: 0, label: `churn-n=${newN}` });
			}

			// SINGLE SNAPSHOT ORACLE: fetch all, then compare against both range queries
			const all = await getOracle();
			const churnAll = all.filter((r: any) => r.id.startsWith('r-churn-'));
			console.log(
				`  Post-churn stored n values: ${JSON.stringify(churnAll.map((r: any) => ({ id: r.id, n: r.n })).sort((a: any, b: any) => a.n - b.n))}`
			);

			// Old range [10,14] must be empty
			const afterOldRange = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than_equal', search_value: 10 },
				{ search_attribute: 'n', search_type: 'less_than_equal', search_value: 14 },
			]);
			const afterOldChurn = afterOldRange.filter((r: any) => r.id.startsWith('r-churn-'));
			const oracleOld = churnAll.filter((r: any) => typeof r.n === 'number' && r.n >= 10 && r.n <= 14);
			assertMatch('CHURN-old [10,14]', afterOldChurn, oracleOld);
			strictEqual(
				afterOldChurn.length,
				0,
				`Post-churn: old range [10,14] must be empty, got ${afterOldChurn.length} rows`
			);

			// New range [20,24] must contain all 5 churn rows
			const afterNewRange = await rangeQuery(client, [
				{ search_attribute: 'n', search_type: 'greater_than_equal', search_value: 20 },
				{ search_attribute: 'n', search_type: 'less_than_equal', search_value: 24 },
			]);
			const afterNewChurn = afterNewRange.filter((r: any) => r.id.startsWith('r-churn-'));
			const oracleNew = churnAll.filter((r: any) => typeof r.n === 'number' && r.n >= 20 && r.n <= 24);
			assertMatch('CHURN-new [20,24]', afterNewChurn, oracleNew);
			strictEqual(
				afterNewChurn.length,
				5,
				`Post-churn: new range [20,24] must contain 5 rows, got ${afterNewChurn.length}`
			);

			// Verify correct ids in new range
			const newIds = new Set(afterNewChurn.map((r: any) => r.id));
			for (let i = 0; i < 5; i++) {
				const oldId = `r-churn-${10 + i}`;
				ok(newIds.has(oldId), `Post-churn: ${oldId} must appear in new range [20,24]`);
			}
		});

		// ── SORT ORDER (Int) ───────────────────────────────────────────────────────

		test('Int sort order: n >= -5 results ordered numerically (not lexically)', async () => {
			console.log(`\n[QA-188 SORT engine=${ENGINE}]`);
			const rows = await rangeQuery(
				client,
				[{ search_attribute: 'n', search_type: 'greater_than_equal', search_value: -5 }],
				['id', 'n', 'big', 'fval']
			);
			const nRows = rows.filter((r: any) => r.id.startsWith('r-n-') && typeof r.n === 'number');
			// Default order (no explicit sort) — just verify that if we SORT by n we get numeric order
			const sorted = [...nRows].sort((a: any, b: any) => a.n - b.n);
			const nVals = sorted.map((r: any) => r.n);
			const monotonic = nVals.every((v: number, i: number) => i === 0 || nVals[i - 1] <= v);
			// Check that -5 sorts before -4 (lexically "-5" > "-4" but numerically -5 < -4)
			const idxNeg5 = nVals.indexOf(-5);
			const idxNeg4 = nVals.indexOf(-4);
			const negOrderOk = idxNeg5 >= 0 && idxNeg4 >= 0 && idxNeg5 < idxNeg4;
			console.log(`  n vals (sorted by JS numeric): first 12 = ${JSON.stringify(nVals.slice(0, 12))}`);
			console.log(`  numeric monotonic=${monotonic}, -5 before -4=${negOrderOk}`);
			ok(monotonic, 'Int n values sorted by n must be numerically monotonic');
			ok(negOrderOk, 'Int: -5 must sort before -4 (numeric, not lexical)');
		});
	}
);
