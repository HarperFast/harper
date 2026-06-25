/**
 * Multi-condition indexed query correctness.
 *
 * Pins that AND/OR/range/mixed-indexed/CONTAINS/3-way/empty multi-condition queries
 * return exactly the oracle's result set via both the ops `search_by_conditions` API
 * and SQL WHERE, on both RocksDB and LMDB engines.
 *
 * Table: Product { id, status @indexed, region @indexed, price @indexed,
 *                  category @indexed, notes (non-indexed) }
 * 80 rows with deterministic field distribution:
 *   status:   active/inactive/pending (i%3)
 *   region:   us/eu/ap/la (i%4)
 *   price:    5 + (i % 91)  → range 5..95
 *   category: shoes/shirts/hats/bags/belts (i%5)
 *   notes:    "note for item <i>", contains "foo" when i%7=0
 *
 * Cases:
 *   (a) AND-equality  : status='active' AND region='us'
 *   (b) AND+RANGE     : category='shoes' AND price BETWEEN 10 AND 50
 *   (c) OR            : category='shoes' OR category='hats'
 *   (d) MIXED         : status='active' (indexed) AND notes CONTAINS 'foo' (non-indexed)
 *   (e) THREE-WAY AND : status='active' AND region='us' AND category='shoes'
 *   (f) EMPTY         : status='active' AND region='us' AND category='nonexistent' → []
 */

import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'multi-condition-query');
const SCHEMA = 'data';
const TABLE = 'Product';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';
const N = 80;

// ── Seed data ──────────────────────────────────────────────────────────────────
const STATUSES = ['active', 'inactive', 'pending'];
const REGIONS = ['us', 'eu', 'ap', 'la'];
const CATEGORIES = ['shoes', 'shirts', 'hats', 'bags', 'belts'];

interface Row {
	id: number;
	status: string;
	region: string;
	price: number;
	category: string;
	notes: string;
}

function makeRow(i: number): Row {
	return {
		id: i,
		status: STATUSES[i % 3],
		region: REGIONS[i % 4],
		price: 5 + (i % 91),
		category: CATEGORIES[i % 5],
		notes: `note for item ${i}${i % 7 === 0 ? ' foo' : ''}`,
	};
}

const ROWS: Row[] = Array.from({ length: N }, (_, i) => makeRow(i));

// ── JS oracle ──────────────────────────────────────────────────────────────────
function oracle(pred: (r: Row) => boolean): number[] {
	return ROWS.filter(pred)
		.map((r) => r.id)
		.sort((a, b) => a - b);
}

const ORACLE = {
	a: oracle((r) => r.status === 'active' && r.region === 'us'),
	b: oracle((r) => r.category === 'shoes' && r.price >= 10 && r.price <= 50),
	c: oracle((r) => r.category === 'shoes' || r.category === 'hats'),
	d: oracle((r) => r.status === 'active' && r.notes.includes('foo')),
	e: oracle((r) => r.status === 'active' && r.region === 'us' && r.category === 'shoes'),
	f: oracle((_r) => false), // nonexistent category → always empty
};

// ── Wire helpers ───────────────────────────────────────────────────────────────
type Client = ReturnType<typeof createApiClient>;

function cond(attr: keyof Row, type: string, value: unknown) {
	return { search_attribute: attr, search_type: type, search_value: value };
}

async function sbc(
	client: Client,
	operator: 'and' | 'or',
	conditions: unknown[],
): Promise<{ ids: number[]; status: number; ms: number }> {
	const t0 = Date.now();
	const r = await client
		.req()
		.send({ operation: 'search_by_conditions', schema: SCHEMA, table: TABLE, operator, conditions, get_attributes: ['id'] })
		.timeout(60_000);
	const ms = Date.now() - t0;
	const rows: { id: number }[] = Array.isArray(r.body) ? r.body : [];
	const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
	return { ids, status: r.status, ms };
}

async function sql(client: Client, where: string): Promise<{ ids: number[]; status: number }> {
	const r = await client
		.req()
		.send({ operation: 'sql', sql: `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${where}` })
		.timeout(60_000);
	const rows: { id: number }[] = Array.isArray(r.body) ? r.body : [];
	const ids = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
	return { ids, status: r.status };
}

function diff(label: string, got: number[], expected: number[]): { ok: boolean; msg: string } {
	const missing = expected.filter((x) => !got.includes(x));
	const extra = got.filter((x) => !expected.includes(x));
	const isOk = missing.length === 0 && extra.length === 0;
	const msg =
		isOk
			? `${label}: oracle=${expected.length} got=${got.length} OK`
			: `${label}: oracle=${expected.length} got=${got.length} MISMATCH missing=[${missing.slice(0, 10)}] extra=[${extra.slice(0, 10)}]`;
	console.log(`[multi-condition-query ${ENGINE}] ${msg}`);
	return { ok: isOk, msg };
}

const FAILURES: string[] = [];

function check(label: string, got: number[], expected: number[]): void {
	const { ok, msg } = diff(label, got, expected);
	if (!ok) FAILURES.push(msg);
}

function checkSqlParity(label: string, opsIds: number[], sqlIds: number[], sqlStatus: number): void {
	if (sqlStatus !== 200) {
		console.log(`[multi-condition-query ${ENGINE}] SQL-parity ${label}: SQL returned ${sqlStatus} (skip parity)`);
		return;
	}
	const missing = sqlIds.filter((x) => !opsIds.includes(x));
	const extra = opsIds.filter((x) => !sqlIds.includes(x));
	const isOk = missing.length === 0 && extra.length === 0;
	const msg = isOk
		? `SQL-parity ${label}: ops=${opsIds.length} sql=${sqlIds.length} OK`
		: `SQL-parity ${label}: DIVERGENCE ops=${opsIds.length} sql=${sqlIds.length} ops_extra=[${extra.slice(0, 5)}] sql_extra=[${missing.slice(0, 5)}]`;
	console.log(`[multi-condition-query ${ENGINE}] ${msg}`);
	if (!isOk) FAILURES.push(msg);
}

// ── Suite ──────────────────────────────────────────────────────────────────────
suite(`multi-condition indexed query [engine=${ENGINE}]`, { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let client: Client;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		await restartHttpWorkers(client, `/${TABLE}/`, 120_000);

		const CHUNK = 40;
		for (let i = 0; i < ROWS.length; i += CHUNK) {
			const chunk = ROWS.slice(i, i + CHUNK);
			await client
				.req()
				.send({ operation: 'insert', schema: SCHEMA, table: TABLE, records: chunk })
				.timeout(60_000)
				.expect(200);
		}
		console.log(`[multi-condition-query ${ENGINE}] seeded ${N} rows`);
		console.log(`[multi-condition-query ${ENGINE}] oracle counts: a=${ORACLE.a.length} b=${ORACLE.b.length} c=${ORACLE.c.length} d=${ORACLE.d.length} e=${ORACLE.e.length} f=${ORACLE.f.length}`);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── (a) AND of two indexed equality conditions ─────────────────────────────
	test('(a) AND-equality: status=active AND region=us — ops vs oracle; SQL parity', async () => {
		const ops = await sbc(client, 'and', [
			cond('status', 'equals', 'active'),
			cond('region', 'equals', 'us'),
		]);
		strictEqual(ops.status, 200, `sbc returned ${ops.status}`);
		check('(a) ops AND-equality', ops.ids, ORACLE.a);

		const sqlR = await sql(client, `status = 'active' AND region = 'us'`);
		check('(a) sql AND-equality', sqlR.ids, ORACLE.a);
		checkSqlParity('(a) AND-equality', ops.ids, sqlR.ids, sqlR.status);

		console.log(`[multi-condition-query ${ENGINE}] (a) timing: ops=${ops.ms}ms (${N}-row table, 2 indexed attrs)`);
		strictEqual(FAILURES.length, 0, FAILURES.join(' || '));
	});

	// ── (b) AND of indexed equality + indexed RANGE ────────────────────────────
	test('(b) AND+RANGE: category=shoes AND price BETWEEN 10 AND 50 — ops vs oracle; SQL parity', async () => {
		const ops = await sbc(client, 'and', [
			cond('category', 'equals', 'shoes'),
			cond('price', 'between', [10, 50]),
		]);
		strictEqual(ops.status, 200, `sbc returned ${ops.status}`);
		check('(b) ops AND+RANGE (between)', ops.ids, ORACLE.b);

		const sqlR = await sql(client, `category = 'shoes' AND price BETWEEN 10 AND 50`);
		check('(b) sql AND+RANGE', sqlR.ids, ORACLE.b);
		checkSqlParity('(b) AND+RANGE', ops.ids, sqlR.ids, sqlR.status);

		// Confirm `between` and `gte+lte` are equivalent
		const opsEquiv = await sbc(client, 'and', [
			cond('category', 'equals', 'shoes'),
			cond('price', 'greater_than_equal', 10),
			cond('price', 'less_than_equal', 50),
		]);
		check('(b) ops AND+RANGE (gte+lte equiv)', opsEquiv.ids, ORACLE.b);
		const betweenVsEquiv = JSON.stringify(ops.ids) === JSON.stringify(opsEquiv.ids);
		console.log(`[multi-condition-query ${ENGINE}] (b) between vs gte+lte equiv: ${betweenVsEquiv ? 'MATCH' : 'MISMATCH (between != gte+lte!)'}`);
		if (!betweenVsEquiv && ops.ids.length !== opsEquiv.ids.length) {
			FAILURES.push(`(b) between vs gte+lte equiv: between=${ops.ids.length} equiv=${opsEquiv.ids.length}`);
		}

		strictEqual(FAILURES.length, 0, FAILURES.join(' || '));
	});

	// ── (c) OR of two indexed equality conditions ──────────────────────────────
	test('(c) OR: category=shoes OR category=hats — ops vs oracle; SQL parity; dup check', async () => {
		const ops = await sbc(client, 'or', [
			cond('category', 'equals', 'shoes'),
			cond('category', 'equals', 'hats'),
		]);
		strictEqual(ops.status, 200, `sbc returned ${ops.status}`);
		check('(c) ops OR', ops.ids, ORACLE.c);

		// Fetch raw to check for duplicates before sort/dedup
		const raw = await client
			.req()
			.send({ operation: 'search_by_conditions', schema: SCHEMA, table: TABLE, operator: 'or',
				conditions: [cond('category', 'equals', 'shoes'), cond('category', 'equals', 'hats')],
				get_attributes: ['id'] })
			.timeout(60_000);
		const rawIds: number[] = Array.isArray(raw.body) ? raw.body.map((r: { id: number }) => Number(r.id)) : [];
		const uniqueCount = new Set(rawIds).size;
		const dupCount = rawIds.length - uniqueCount;
		console.log(`[multi-condition-query ${ENGINE}] (c) OR raw=${rawIds.length} unique=${uniqueCount} dups=${dupCount}`);
		if (dupCount > 0) FAILURES.push(`(c) OR returned ${dupCount} duplicate row(s)`);

		const sqlR = await sql(client, `category = 'shoes' OR category = 'hats'`);
		check('(c) sql OR', sqlR.ids, ORACLE.c);
		checkSqlParity('(c) OR', ops.ids, sqlR.ids, sqlR.status);

		strictEqual(FAILURES.length, 0, FAILURES.join(' || '));
	});

	// ── (d) Mixed indexed + non-indexed CONTAINS ──────────────────────────────
	test('(d) MIXED: status=active (indexed) AND notes CONTAINS foo (non-indexed)', async () => {
		const ops = await sbc(client, 'and', [
			cond('status', 'equals', 'active'),
			cond('notes', 'contains', 'foo'),
		]);
		strictEqual(ops.status, 200, `sbc returned ${ops.status}`);
		check('(d) ops MIXED indexed+CONTAINS', ops.ids, ORACLE.d);

		// Condition order must not affect result
		const opsRev = await sbc(client, 'and', [
			cond('notes', 'contains', 'foo'),
			cond('status', 'equals', 'active'),
		]);
		check('(d) ops MIXED (reversed order)', opsRev.ids, ORACLE.d);
		const orderInvariant = JSON.stringify(ops.ids) === JSON.stringify(opsRev.ids);
		console.log(`[multi-condition-query ${ENGINE}] (d) condition-order invariant: ${orderInvariant ? 'OK' : 'ORDER-SENSITIVE (defect candidate)'}`);
		if (!orderInvariant) FAILURES.push('(d) MIXED: condition order changes results');

		const sqlR = await sql(client, `status = 'active' AND notes LIKE '%foo%'`);
		check('(d) sql MIXED', sqlR.ids, ORACLE.d);
		checkSqlParity('(d) MIXED', ops.ids, sqlR.ids, sqlR.status);

		strictEqual(FAILURES.length, 0, FAILURES.join(' || '));
	});

	// ── (e) Three-way AND ─────────────────────────────────────────────────────
	test('(e) THREE-WAY AND: status=active AND region=us AND category=shoes', async () => {
		const ops = await sbc(client, 'and', [
			cond('status', 'equals', 'active'),
			cond('region', 'equals', 'us'),
			cond('category', 'equals', 'shoes'),
		]);
		strictEqual(ops.status, 200, `sbc returned ${ops.status}`);
		check('(e) ops 3-way AND', ops.ids, ORACLE.e);

		const sqlR = await sql(client, `status = 'active' AND region = 'us' AND category = 'shoes'`);
		check('(e) sql 3-way AND', sqlR.ids, ORACLE.e);
		checkSqlParity('(e) 3-way AND', ops.ids, sqlR.ids, sqlR.status);

		strictEqual(FAILURES.length, 0, FAILURES.join(' || '));
	});

	// ── (f) Empty result — all conditions indexed, no matching rows ───────────
	test('(f) EMPTY: status=active AND region=us AND category=nonexistent → []', async () => {
		const ops = await sbc(client, 'and', [
			cond('status', 'equals', 'active'),
			cond('region', 'equals', 'us'),
			cond('category', 'equals', 'nonexistent'),
		]);
		strictEqual(ops.status, 200, `sbc should return 200 even for empty result set (got ${ops.status})`);
		check('(f) ops EMPTY', ops.ids, ORACLE.f);
		strictEqual(ops.ids.length, 0, `(f) EMPTY must return exactly 0 rows, got ${ops.ids.length}`);

		const sqlR = await sql(client, `status = 'active' AND region = 'us' AND category = 'nonexistent'`);
		if (sqlR.status === 200) {
			check('(f) sql EMPTY', sqlR.ids, ORACLE.f);
			strictEqual(sqlR.ids.length, 0, `(f) SQL EMPTY must return 0 rows, got ${sqlR.ids.length}`);
		}

		strictEqual(FAILURES.length, 0, FAILURES.join(' || '));
	});

	// ── Summary ───────────────────────────────────────────────────────────────
	test('Summary: correctness matrix', () => {
		if (FAILURES.length === 0) {
			console.log(
				`\n[multi-condition-query ${ENGINE}] VERDICT: ALL PASS\n` +
				`  Engine: ${ENGINE}\n` +
				`  (a) AND-equality (2 indexed): CORRECT (ops + SQL match oracle)\n` +
				`  (b) AND+RANGE between (indexed eq + indexed between): CORRECT (ops + SQL + gte/lte equiv)\n` +
				`  (c) OR two indexed eq (same attr): CORRECT (no dups, ops + SQL)\n` +
				`  (d) MIXED indexed AND non-indexed CONTAINS: CORRECT (order-invariant)\n` +
				`  (e) THREE-WAY AND (3 indexed): CORRECT\n` +
				`  (f) EMPTY result (all indexed, no match): [] (no error)`
			);
		} else {
			console.log(`\n[multi-condition-query ${ENGINE}] VERDICT: ${FAILURES.length} FAILURE(S)`);
			for (const f of FAILURES) console.log(`  - ${f}`);
		}
		strictEqual(FAILURES.length, 0, `${FAILURES.length} failure(s):\n  ${FAILURES.join('\n  ')}`);
	});
});
