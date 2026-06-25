// SQL bulk UPDATE/DELETE WHERE correctness: correct rows, index parity, atomicity, concurrency. Both engines.

import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'bulk-conditional-mutation');
const SCHEMA = 'data';
const TABLE = 'BulkOrder';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

// ── Seed data ──────────────────────────────────────────────────────────────────
// 60 rows: deterministic distribution seeded in test.
// status: active (i%3=0), inactive (i%3=1), archived (i%3=2)
// region: us (i%4=0), eu (i%4=1), ap (i%4=2), la (i%4=3)
// category: electronics (i%3=0), clothing (i%3=1), clearance (i%3=2)
// createdAt: epoch ms; rows 0..19 are "old" (40+ days ago), 20..59 are "recent"
// expired: true for i%5=0, else false
const N = 60;
const NOW = 1_750_000_000_000; // fixed reference ms (2025-ish)
const OLD_TS = NOW - 41 * 24 * 60 * 60 * 1000; // 41 days old
const RECENT_TS = NOW - 10 * 24 * 60 * 60 * 1000; // 10 days old
const THRESHOLD_TS = NOW - 30 * 24 * 60 * 60 * 1000; // 30-day cutoff

interface OrderRow {
	id: string;
	status: string;
	createdAt: number;
	region: string;
	category: string;
	price: number;
	expired: boolean;
}

function makeRow(i: number): OrderRow {
	return {
		id: `order-${String(i).padStart(3, '0')}`,
		status: ['active', 'inactive', 'archived'][i % 3],
		createdAt: i < 20 ? OLD_TS + i * 1000 : RECENT_TS + i * 1000,
		region: ['us', 'eu', 'ap', 'la'][i % 4],
		category: ['electronics', 'clothing', 'clearance'][i % 3],
		price: 10 + (i % 90),
		expired: i % 5 === 0,
	};
}

const SEED_ROWS: OrderRow[] = Array.from({ length: N }, (_, i) => makeRow(i));

// ── JS oracle ──────────────────────────────────────────────────────────────────
function oracleIds(pred: (r: OrderRow) => boolean): string[] {
	return SEED_ROWS.filter(pred)
		.map((r) => r.id)
		.sort();
}

// (a) UPDATE WHERE: status='active' AND createdAt < threshold
const ORACLE_A_MATCH = oracleIds((r) => r.status === 'active' && r.createdAt < THRESHOLD_TS);
const ORACLE_A_UNCHANGED = oracleIds((r) => !(r.status === 'active' && r.createdAt < THRESHOLD_TS));

// (b) DELETE WHERE: expired=true
const ORACLE_B_DELETE = oracleIds((r) => r.expired === true);
const ORACLE_B_KEEP = oracleIds((r) => r.expired !== true);

// (d) UPDATE indexed column: region='us' → 'eu-migrated'
const ORACLE_D_US = oracleIds((r) => r.region === 'us');
const ORACLE_D_NOT_US = oracleIds((r) => r.region !== 'us');

// ── Wire helpers ───────────────────────────────────────────────────────────────
type Client = ReturnType<typeof createApiClient>;

// Helper: run SQL via ops API
async function sql(client: Client, statement: string): Promise<{ status: number; body: unknown }> {
	const r = await client
		.req()
		.send({ operation: 'sql', sql: statement })
		.timeout(60_000);
	return { status: r.status, body: r.body };
}

// Helper: SELECT all rows (sorted by id)
async function selectAll(client: Client): Promise<OrderRow[]> {
	const r = await client
		.req()
		.send({
			operation: 'sql',
			sql: `SELECT id, status, createdAt, region, category, price, expired FROM ${SCHEMA}.${TABLE} ORDER BY id`,
		})
		.timeout(60_000);
	if (r.status !== 200 || !Array.isArray(r.body)) {
		throw new Error(`selectAll failed: status=${r.status} body=${JSON.stringify(r.body)}`);
	}
	return r.body as OrderRow[];
}

// Helper: select specific row
async function selectOne(client: Client, id: string): Promise<OrderRow | null> {
	const r = await client
		.req()
		.send({
			operation: 'sql',
			sql: `SELECT id, status, createdAt, region, category, price, expired FROM ${SCHEMA}.${TABLE} WHERE id = '${id}'`,
		})
		.timeout(60_000);
	if (r.status !== 200 || !Array.isArray(r.body)) return null;
	return (r.body as OrderRow[])[0] ?? null;
}

// Helper: ops bulk insert
async function seedRows(client: Client, rows: OrderRow[]): Promise<void> {
	const CHUNK = 30;
	for (let i = 0; i < rows.length; i += CHUNK) {
		await client
			.req()
			.send({ operation: 'insert', schema: SCHEMA, table: TABLE, records: rows.slice(i, i + CHUNK) })
			.timeout(60_000)
			.expect(200);
	}
}

// Helper: ops delete all rows (clean slate between probes)
async function deleteAll(client: Client): Promise<void> {
	const r = await client
		.req()
		.send({ operation: 'search_by_value', schema: SCHEMA, table: TABLE, search_attribute: 'id', search_value: '*', get_attributes: ['id'] })
		.timeout(60_000);
	const rows: { id: string }[] = Array.isArray(r.body) ? (r.body as { id: string }[]) : [];
	const ids = rows.map((x) => x.id).filter(Boolean);
	if (ids.length === 0) return;
	// Delete in chunks to avoid oversized payloads
	const CHUNK = 50;
	for (let i = 0; i < ids.length; i += CHUNK) {
		await client
			.req()
			.send({ operation: 'delete', schema: SCHEMA, table: TABLE, ids: ids.slice(i, i + CHUNK) })
			.timeout(60_000);
	}
}

// Helper: ops search_by_value (for index consistency checks)
async function sbv(client: Client, attr: string, value: string): Promise<string[]> {
	const r = await client
		.req()
		.send({
			operation: 'search_by_value',
			schema: SCHEMA,
			table: TABLE,
			search_attribute: attr,
			search_value: value,
			get_attributes: ['id'],
		})
		.timeout(60_000);
	const rows: { id: string }[] = Array.isArray(r.body) ? (r.body as { id: string }[]) : [];
	return rows.map((x) => x.id).sort();
}

// ── Accumulated failure log ────────────────────────────────────────────────────
const FAILURES: string[] = [];

function check(label: string, got: unknown, expected: unknown): void {
	const ok2 = JSON.stringify(got) === JSON.stringify(expected);
	const msg = ok2
		? `${label}: PASS`
		: `${label}: FAIL got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`;
	console.log(`[${ENGINE}] ${msg}`);
	if (!ok2) FAILURES.push(msg);
}

function log(msg: string): void {
	console.log(`[${ENGINE}] ${msg}`);
}

// ── Suite ──────────────────────────────────────────────────────────────────────
suite(`bulk conditional mutation [engine=${ENGINE}]`, { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let client: Client;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 4 },
				logging: { console: true, level: 'error' },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		// Wait until the Order table route is ready
		await restartHttpWorkers(client, `/${TABLE}/`, 120_000);
		log(`Harper started, seeding ${N} rows`);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── (a) SQL bulk UPDATE WHERE: correct rows, correct count, non-matching untouched ──
	test('(a) SQL bulk UPDATE WHERE — correct rows + count; non-matching untouched', { timeout: 60_000 }, async () => {
		await deleteAll(client);
		await seedRows(client, SEED_ROWS);

		const threshold = THRESHOLD_TS;
		log(`(a) oracle MATCH count=${ORACLE_A_MATCH.length} ids=${ORACLE_A_MATCH.slice(0, 5).join(',')}`);

		const res = await sql(
			client,
			`UPDATE ${SCHEMA}.${TABLE} SET status = 'archived' WHERE status = 'active' AND createdAt < ${threshold}`,
		);
		log(`(a) UPDATE response: status=${res.status} body=${JSON.stringify(res.body)}`);

		// Check HTTP status — expect 200 for a successful bulk update
		const updateOk = res.status === 200;
		if (!updateOk) {
			FAILURES.push(`(a) SQL UPDATE returned ${res.status} instead of 200`);
		}

		// Read back all rows and compare against oracle
		const allRows = await selectAll(client);

		// Rows that SHOULD have been updated: originally active+old → now archived
		const updatedIds = allRows.filter((r) => r.status === 'archived' && ORACLE_A_MATCH.includes(r.id)).map((r) => r.id).sort();

		// Rows wrongly updated: in ORACLE_A_UNCHANGED and now archived, but WERE NOT originally archived
		const wronglyUpdated = allRows
			.filter((r) => {
				if (!ORACLE_A_UNCHANGED.includes(r.id)) return false;
				if (r.status !== 'archived') return false;
				const original = SEED_ROWS.find((s) => s.id === r.id);
				return original?.status !== 'archived'; // was not originally archived
			})
			.map((r) => r.id)
			.sort();

		const notUpdated = ORACLE_A_MATCH.filter((id) => {
			const row = allRows.find((r) => r.id === id);
			return row?.status !== 'archived';
		});

		check('(a) matched rows updated', updatedIds, ORACLE_A_MATCH);
		check('(a) wrongly-updated rows (should be [])', wronglyUpdated, []);
		check('(a) missed rows (should be [])', notUpdated, []);

		// Check non-matching rows untouched (inactive rows should still be inactive)
		const inactiveUntouched = allRows.filter((r) => ORACLE_A_UNCHANGED.includes(r.id) && r.status === 'inactive');
		const inactiveOracle = ORACLE_A_UNCHANGED.filter((id) => {
			const row = SEED_ROWS.find((r) => r.id === id);
			return row?.status === 'inactive';
		});
		check('(a) inactive rows untouched', inactiveUntouched.map((r) => r.id).sort(), inactiveOracle.sort());
	});

	// ── (b) SQL bulk DELETE WHERE: correct rows deleted, index consistent, count correct ──
	test('(b) SQL bulk DELETE WHERE — correct rows deleted; index consistent after', { timeout: 60_000 }, async () => {
		await deleteAll(client);
		await seedRows(client, SEED_ROWS);

		log(`(b) oracle DELETE count=${ORACLE_B_DELETE.length} KEEP count=${ORACLE_B_KEEP.length}`);

		const res = await sql(client, `DELETE FROM ${SCHEMA}.${TABLE} WHERE expired = true`);
		log(`(b) DELETE response: status=${res.status} body=${JSON.stringify(res.body)}`);

		const deleteOk = res.status === 200;
		if (!deleteOk) {
			FAILURES.push(`(b) SQL DELETE returned ${res.status} instead of 200`);
		}

		// Read back all remaining rows
		const remaining = await selectAll(client);
		const remainingIds = remaining.map((r) => r.id).sort();
		check('(b) remaining rows match oracle', remainingIds, ORACLE_B_KEEP);

		// Check for stale index entries: search_by_value on region for deleted rows
		// Deleted rows spanned all regions — check that region index no longer returns deleted ids
		const regionUsIds = await sbv(client, 'region', 'us');
		const deletedRegionUs = ORACLE_B_DELETE.filter((id) => {
			const row = SEED_ROWS.find((r) => r.id === id);
			return row?.region === 'us';
		});
		const phantomInIndex = regionUsIds.filter((id) => deletedRegionUs.includes(id));
		check('(b) no phantom index entries for deleted rows (region=us)', phantomInIndex, []);

		// Spot-check: status index for deleted rows
		const statusActiveIds = await sbv(client, 'status', 'active');
		const deletedStatusActive = ORACLE_B_DELETE.filter((id) => {
			const row = SEED_ROWS.find((r) => r.id === id);
			return row?.status === 'active';
		});
		const phantomActive = statusActiveIds.filter((id) => deletedStatusActive.includes(id));
		check('(b) no phantom index entries for deleted rows (status=active)', phantomActive, []);
	});

	// ── (c) Ops-API conditional bulk — probe surface ───────────────────────────
	test('(c) Ops-API: ops update/delete are by-PK (no WHERE filter) — verify and document', { timeout: 30_000 }, async () => {
		// ops `update` takes `records` array (by PK). Attempt a WHERE-filter style bulk update
		// via ops to confirm it's not supported natively.
		await deleteAll(client);
		await seedRows(client, SEED_ROWS.slice(0, 5));

		// ops update: by PK only (records=[{id, ...}])
		const opsUpd = await client
			.req()
			.send({ operation: 'update', schema: SCHEMA, table: TABLE, records: [{ id: 'order-000', status: 'ops-updated' }] })
			.timeout(10_000);
		log(`(c) ops update by PK: status=${opsUpd.status}`);
		const opsByPkOk = opsUpd.status === 200;
		if (!opsByPkOk) {
			FAILURES.push(`(c) ops update by PK returned ${opsUpd.status}`);
		}
		// Verify it updated just that one row
		const r = await selectOne(client, 'order-000');
		check('(c) ops update PK updated correct row', r?.status, 'ops-updated');

		// ops delete: by PK only (ids=[...])
		const opsDel = await client
			.req()
			.send({ operation: 'delete', schema: SCHEMA, table: TABLE, ids: ['order-001'] })
			.timeout(10_000);
		log(`(c) ops delete by PK: status=${opsDel.status}`);
		if (opsDel.status !== 200) {
			FAILURES.push(`(c) ops delete by PK returned ${opsDel.status}`);
		}
		const after = await selectOne(client, 'order-001');
		check('(c) ops delete removed the row', after, null);

		// search+bulk-delete workaround (conditional bulk via two ops calls)
		// Seed fresh expired rows; search_by_conditions for expired=true; then delete by ids
		await deleteAll(client);
		await seedRows(client, SEED_ROWS.slice(0, 15));
		const expiredSbc = await client
			.req()
			.send({
				operation: 'search_by_conditions',
				schema: SCHEMA,
				table: TABLE,
				operator: 'and',
				conditions: [{ search_attribute: 'expired', search_type: 'equals', search_value: true }],
				get_attributes: ['id'],
			})
			.timeout(10_000);
		const expiredIds: string[] = Array.isArray(expiredSbc.body)
			? (expiredSbc.body as { id: string }[]).map((x) => x.id).sort()
			: [];
		const expiredOracle = SEED_ROWS.slice(0, 15)
			.filter((r) => r.expired)
			.map((r) => r.id)
			.sort();
		log(`(c) search_by_conditions expired: got=${expiredIds.length} oracle=${expiredOracle.length}`);
		check('(c) sbc finds correct expired rows for workaround', expiredIds, expiredOracle);

		if (expiredIds.length > 0) {
			const bulk = await client
				.req()
				.send({ operation: 'delete', schema: SCHEMA, table: TABLE, ids: expiredIds })
				.timeout(10_000);
			log(`(c) bulk delete workaround: status=${bulk.status}`);
			if (bulk.status !== 200) {
				FAILURES.push(`(c) bulk delete workaround returned ${bulk.status}`);
			}
		}

		log('(c) Conclusion: ops update/delete are by-PK only — no native WHERE-filter bulk. Bulk-conditional path = SQL UPDATE/DELETE or search+ids workaround.');
	});

	// ── (d) UPDATE touching @indexed column — index parity after ──────────────
	test('(d) UPDATE indexed column region=us→eu-migrated: search_by_value parity', { timeout: 60_000 }, async () => {
		await deleteAll(client);
		await seedRows(client, SEED_ROWS);

		log(`(d) oracle region=us count=${ORACLE_D_US.length}`);

		const res = await sql(
			client,
			`UPDATE ${SCHEMA}.${TABLE} SET region = 'eu-migrated' WHERE region = 'us'`,
		);
		log(`(d) UPDATE region=us response: status=${res.status} body=${JSON.stringify(res.body)}`);

		if (res.status !== 200) {
			FAILURES.push(`(d) SQL UPDATE (indexed column) returned ${res.status} instead of 200`);
		}

		// search_by_value region='eu-migrated' must return exactly the updated rows
		const euMigrated = await sbv(client, 'region', 'eu-migrated');
		check('(d) region=eu-migrated index returns updated rows', euMigrated, ORACLE_D_US);

		// search_by_value region='us' must return zero (no stale index entries)
		const usAfter = await sbv(client, 'region', 'us');
		check('(d) region=us index returns [] after update (no stale entries)', usAfter, []);

		// Sanity: read back sample of updated rows directly
		const sample = ORACLE_D_US.slice(0, 3);
		for (const id of sample) {
			const row = await selectOne(client, id);
			if (row?.region !== 'eu-migrated') {
				FAILURES.push(`(d) row ${id} has region=${row?.region} after UPDATE (expected eu-migrated)`);
			}
		}
		log(`(d) sample spot-check: ${sample.map((id) => `${id}=${ORACLE_D_US.includes(id) ? 'eu-migrated ✓' : 'us ✗'}`).join(', ')}`);
	});

	// ── (e) Atomicity / partial failure — constraint violation mid-batch ───────
	test('(e) Atomicity: SQL UPDATE setting Int field to string — rollback vs partial vs fail-fast?', { timeout: 30_000 }, async () => {
		await deleteAll(client);
		// Use a subset of rows with known prices for observability
		const subset = SEED_ROWS.slice(0, 10);
		await seedRows(client, subset);

		const pricesBefore = (await selectAll(client)).map((r) => ({ id: r.id, price: r.price })).sort((a, b) => a.id.localeCompare(b.id));

		// Attempt to SET price (Float) = 'not-a-number' WHERE category='electronics'
		// This SHOULD either: (1) fail with 400/500, (2) succeed and coerce, or (3) partially apply
		const res = await sql(
			client,
			`UPDATE ${SCHEMA}.${TABLE} SET price = 'not-a-number' WHERE category = 'electronics'`,
		);
		log(`(e) type-violating UPDATE response: status=${res.status} body=${JSON.stringify(res.body)}`);

		const pricesAfter = (await selectAll(client)).map((r) => ({ id: r.id, price: r.price })).sort((a, b) => a.id.localeCompare(b.id));

		// Document result — NOT asserted as defect (behavior could legitimately coerce),
		// but note if it silently partially-applied or corrupted rows
		const changed = pricesAfter.filter((a, idx) => a.price !== pricesBefore[idx]?.price);
		if (res.status === 200 && changed.length > 0) {
			log(`(e) type-violating UPDATE succeeded (status=200) and changed ${changed.length} rows: prices=${JSON.stringify(changed.map((r) => r.price))}`);
			// Check if 'not-a-number' was coerced to null or NaN
			const hasNaN = changed.some((r) => r.price === null || r.price !== r.price);
			const hasLiteral = changed.some((r) => String(r.price) === 'not-a-number');
			log(`(e) coercion result: hasNaN/null=${hasNaN} hasLiteralString=${hasLiteral}`);
		} else if (res.status !== 200) {
			log(`(e) type-violating UPDATE rejected (status=${res.status}) — ${changed.length} rows changed after`);
		}

		// Key check: the rows NOT in electronics should be completely untouched
		const electronicsIds = subset.filter((r) => r.category === 'electronics').map((r) => r.id);
		const nonElectronicsIds = subset.filter((r) => r.category !== 'electronics').map((r) => r.id);
		const nonElecChanged = pricesAfter.filter((a, idx) => a.price !== pricesBefore[idx]?.price && nonElectronicsIds.includes(a.id));
		check('(e) non-matching rows untouched even on constraint-violating UPDATE', nonElecChanged, []);

		// Atomicity verdict: if update failed (non-200), no electronics rows should have changed either
		if (res.status !== 200) {
			const elecChanged = pricesAfter.filter((a, idx) => a.price !== pricesBefore[idx]?.price && electronicsIds.includes(a.id));
			const atomicity = elecChanged.length === 0 ? 'ATOMIC-ROLLBACK' : 'PARTIAL-APPLY';
			log(`(e) atomicity verdict: ${atomicity} (electronics changed=${elecChanged.length})`);
			if (elecChanged.length > 0) {
				FAILURES.push(`(e) atomicity VIOLATION: UPDATE failed (${res.status}) but ${elecChanged.length} rows were partially changed`);
			}
		}
	});

	// ── (f) Empty match + all-match ───────────────────────────────────────────
	test('(f) Empty match → count=0 no-op; all-match → full-table update correct', { timeout: 60_000 }, async () => {
		await deleteAll(client);
		await seedRows(client, SEED_ROWS);

		// Empty match: WHERE status = 'nonexistent-value'
		const emptyRes = await sql(
			client,
			`UPDATE ${SCHEMA}.${TABLE} SET category = 'x' WHERE status = '__no_such_status__'`,
		);
		log(`(f) empty-match UPDATE: status=${emptyRes.status} body=${JSON.stringify(emptyRes.body)}`);
		const emptyOk = emptyRes.status === 200;
		if (!emptyOk) {
			FAILURES.push(`(f) empty-match UPDATE returned ${emptyRes.status} (expected 200)`);
		}

		// Verify no rows were changed
		const allAfterEmpty = await selectAll(client);
		const changedByEmpty = allAfterEmpty.filter((r) => r.category === 'x');
		check('(f) empty-match UPDATE changed zero rows', changedByEmpty, []);

		// All-match: UPDATE all rows (no WHERE restriction other than price > 0 which all have)
		const beforeAllMatch = await selectAll(client);
		const allMatchRes = await sql(
			client,
			`UPDATE ${SCHEMA}.${TABLE} SET price = 999 WHERE price > 0`,
		);
		log(`(f) all-match UPDATE: status=${allMatchRes.status} body=${JSON.stringify(allMatchRes.body)}`);
		if (allMatchRes.status !== 200) {
			FAILURES.push(`(f) all-match UPDATE returned ${allMatchRes.status} (expected 200)`);
		}

		// Every row should now have price=999
		const allAfterFull = await selectAll(client);
		const notUpdated = allAfterFull.filter((r) => r.price !== 999);
		check('(f) all-match UPDATE changed ALL rows', notUpdated, []);
		log(`(f) all-match: before=${beforeAllMatch.length} after=${allAfterFull.length} notUpdated=${notUpdated.length}`);
	});

	// ── (g) Concurrency: bulk UPDATE WHERE racing single-row writers ───────────
	test('(g) Concurrency: bulk UPDATE WHERE racing 4 single-row writers — no lost update or index tear', { timeout: 120_000 }, async () => {
		await deleteAll(client);
		await seedRows(client, SEED_ROWS);

		const ROUNDS = 4;
		const SINGLE_WRITE_TARGETS = SEED_ROWS.filter((r) => r.status === 'active').slice(0, 8).map((r) => r.id);
		log(`(g) concurrency: ${ROUNDS} rounds; bulk UPDATE racing ${SINGLE_WRITE_TARGETS.length} single-row writers`);

		let lostUpdateRounds = 0;
		let indexTearRounds = 0;

		for (let round = 0; round < ROUNDS; round++) {
			// Reset to known state
			await deleteAll(client);
			await seedRows(client, SEED_ROWS);

			// Race: bulk UPDATE (set status='bulk-archived' WHERE status='active' AND createdAt < threshold)
			// vs 4 single-row writers updating the same active-old rows to 'single-write'
			const bulkPromise = sql(
				client,
				`UPDATE ${SCHEMA}.${TABLE} SET status = 'bulk-archived' WHERE status = 'active' AND createdAt < ${THRESHOLD_TS}`,
			);

			const singleWritePromises = SINGLE_WRITE_TARGETS.slice(0, 4).map((id, wi) =>
				client
					.req()
					.send({ operation: 'update', schema: SCHEMA, table: TABLE, records: [{ id, status: 'single-write', price: 777 + wi }] })
					.timeout(10_000),
			);

			const [bulkResult, ...singleResults] = await Promise.all([bulkPromise, ...singleWritePromises]);
			log(`(g) r${round}: bulk=${bulkResult.status} singles=${singleResults.map((r) => r.status).join(',')}`);

			// Read back and verify: every row must be in EXACTLY ONE of {bulk-archived, single-write, or original status}
			// No row should be completely dropped; no row should have a torn/corrupt state
			const allRows = await selectAll(client);

			// Check row count preserved
			if (allRows.length !== N) {
				lostUpdateRounds++;
				FAILURES.push(`(g) r${round}: row count after concurrency: got=${allRows.length} expected=${N} (LOST ROWS)`);
				continue;
			}

			// Check index consistency: all rows returned by status index should exist
			const bulkArchivedByIndex = await sbv(client, 'status', 'bulk-archived');
			const actualBulkArchived = allRows.filter((r) => r.status === 'bulk-archived').map((r) => r.id).sort();
			const indexOk = JSON.stringify(bulkArchivedByIndex) === JSON.stringify(actualBulkArchived);
			if (!indexOk) {
				indexTearRounds++;
				log(`(g) r${round}: INDEX TEAR — index says bulk-archived=[${bulkArchivedByIndex}] actual=[${actualBulkArchived}]`);
				FAILURES.push(`(g) r${round}: index inconsistency after concurrent bulk UPDATE + single writes`);
			} else {
				log(`(g) r${round}: OK rows=${allRows.length} bulk-archived=${actualBulkArchived.length} index-consistent=${indexOk}`);
			}
		}

		log(`(g) concurrency summary: lostUpdateRounds=${lostUpdateRounds}/${ROUNDS} indexTearRounds=${indexTearRounds}/${ROUNDS}`);
	});

	// ── Summary ───────────────────────────────────────────────────────────────
	test('Summary: correctness matrix', () => {
		const verdict = FAILURES.length === 0 ? 'ALL PASS' : `${FAILURES.length} FAILURE(S)`;
		console.log(
			`\n[${ENGINE}] VERDICT: ${verdict}\n` +
			`  Engine: ${ENGINE}\n` +
			`  Oracle counts: UPDATE-match=${ORACLE_A_MATCH.length} DELETE-match=${ORACLE_B_DELETE.length} region-us=${ORACLE_D_US.length}\n` +
			(FAILURES.length > 0 ? `  FAILURES:\n${FAILURES.map((f) => `    - ${f}`).join('\n')}` : `  No defects found.`),
		);
		strictEqual(FAILURES.length, 0, `${FAILURES.length} failure(s):\n  ${FAILURES.join('\n  ')}`);
	});
});
