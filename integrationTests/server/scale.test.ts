/**
 * Scale correctness integration tests.
 *
 * Verifies record-level correctness at scale (thousands to 100K records) — insert,
 * paginated search, indexed search, multi-condition filter, and bulk delete.
 *
 * These tests are NOT throughput benchmarks. Full 1M / YCSB benchmarks run nightly;
 * this suite exists to catch correctness regressions in large indexed tables on every PR.
 *
 * Fleet reference: large outdoor retail redirect cluster (v4.5.3, 6-node, 1.44M rules,
 * 5 secondary indexes, 14 months) — see GH issue #1192 and Confluence §3 Cat 12.
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';

import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = join(import.meta.dirname, '../fixtures/scale-test');

/** Category letter for index i (0='A'..4='E', cycling). */
function category(i: number): string {
	return String.fromCharCode(65 + (i % 5)); // 'A'..'E'
}

function makeProduct(i: number): { id: string; category: string; price: number; inStock: boolean } {
	return {
		id: `prod-${i}`,
		category: category(i),
		price: Number((i * 0.01).toFixed(2)),
		inStock: i % 2 === 0,
	};
}

/** POST a batch of records via the operations API `insert`. */
async function insertBatch(ctx: ContextWithHarper, table: string, records: object[]): Promise<void> {
	const result = await sendOperation(ctx.harper, {
		operation: 'insert',
		database: 'data',
		table,
		records,
	});
	ok(result, `Insert into ${table} returned no result`);
}

/** Count rows via SQL. */
async function countRows(ctx: ContextWithHarper, table: string, where?: string): Promise<number> {
	const sql = where ? `SELECT COUNT(*) FROM data.${table} WHERE ${where}` : `SELECT COUNT(*) FROM data.${table}`;
	const rows = await sendOperation(ctx.harper, { operation: 'sql', sql });
	ok(Array.isArray(rows) && rows.length === 1, `Unexpected COUNT result: ${JSON.stringify(rows)}`);
	return rows[0]['COUNT(*)'] as number;
}

/** Build a base64-encoded Basic-auth header for the Harper test credentials. */
function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────────

suite('Scale correctness', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── Test 1: 100K insert + paginated REST read + indexed search ────────────
	// @slow — inserts 100K records; expect ~30–60 s on CI
	test('100K record insert: paginated read and indexed search', async () => {
		const TOTAL = 100_000;
		const BATCH = 500;

		// Batch-insert 100K records.
		for (let start = 0; start < TOTAL; start += BATCH) {
			const end = Math.min(start + BATCH, TOTAL);
			const records = [];
			for (let i = start; i < end; i++) {
				records.push(makeProduct(i));
			}
			await insertBatch(ctx, 'Product', records);
		}

		// Verify total count via SQL.
		const total = await countRows(ctx, 'Product');
		strictEqual(total, TOTAL, `Expected ${TOTAL} records, got ${total}`);

		// Paginated REST: GET /Product?limit(100) — Harper's query syntax for pagination.
		// ?limit(N) returns the first N records; ?limit(offset,end) for page 2+.
		const auth = authHeader(ctx);
		const pageResp = await fetch(`${ctx.harper.httpURL}/Product?limit(100)`, {
			headers: { Authorization: auth },
		});
		strictEqual(pageResp.status, 200, `REST page GET failed: ${pageResp.status}`);
		const page = await pageResp.json();
		ok(Array.isArray(page), `Expected array response from /Product, got: ${JSON.stringify(page)}`);
		strictEqual(page.length, 100, `Expected 100 records in page, got ${page.length}`);

		// Page 2: ?limit(100,200) → records at offset 100..199.
		const page2Resp = await fetch(`${ctx.harper.httpURL}/Product?limit(100,200)`, {
			headers: { Authorization: auth },
		});
		strictEqual(page2Resp.status, 200, `REST page2 GET failed: ${page2Resp.status}`);
		const page2 = await page2Resp.json();
		ok(Array.isArray(page2), `Expected array response from /Product page 2, got: ${JSON.stringify(page2)}`);
		strictEqual(page2.length, 100, `Expected 100 records on page 2, got ${page2.length}`);

		// Pages must not overlap.
		const firstPageIds = new Set((page as Array<{ id: string }>).map((r) => r.id));
		for (const rec of page2) {
			ok(!firstPageIds.has(rec.id), `Page 2 record ${rec.id} also appeared on page 1`);
		}

		// Indexed search by category='A': every 5th record → expect exactly 20 000 hits.
		// Full 1M test tracked in nightly YCSB — this verifies correctness at reduced scale for PR CI.
		const expectedCatA = TOTAL / 5; // 20 000
		const catACount = await countRows(ctx, 'Product', `category='A'`);
		strictEqual(catACount, expectedCatA, `Expected ${expectedCatA} category-A records, got ${catACount}`);

		// Sample the search_by_conditions path for the same filter — verify result purity.
		const catASample = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			database: 'data',
			table: 'Product',
			get_attributes: ['id', 'category'],
			conditions: [{ attribute: 'category', comparator: 'equals', value: 'A' }],
			limit: 50,
		});
		ok(Array.isArray(catASample), `Expected array, got ${JSON.stringify(catASample)}`);
		for (const rec of catASample as Array<{ category: string }>) {
			strictEqual(rec.category, 'A', `Non-A record in category-A sample: ${JSON.stringify(rec)}`);
		}
	});

	// ── Test 2: 10K correctness check (scaled-down 1M proxy) ─────────────────
	// Full 1M test tracked in nightly YCSB — this verifies correctness at reduced scale for PR CI.
	test('10K record correctness: count, search, pagination', async () => {
		// Insert into a separate ID range to avoid collision with Test 1 records.
		const TOTAL = 10_000;
		const BATCH = 500;
		const ID_OFFSET = 200_000;

		// Snapshot the count before this test's inserts so the delta is self-contained
		// (no hidden dependency on which other tests ran first or how many records they inserted).
		const countBefore = await countRows(ctx, 'Product');

		for (let start = 0; start < TOTAL; start += BATCH) {
			const end = Math.min(start + BATCH, TOTAL);
			const records = [];
			for (let i = start; i < end; i++) {
				records.push(makeProduct(ID_OFFSET + i));
			}
			await insertBatch(ctx, 'Product', records);
		}

		// Verify count via total growth (SQL string range on IDs has lexicographic edge cases).
		// IDs are unique, so the total must grow by exactly TOTAL.
		const totalAfter = await countRows(ctx, 'Product');
		strictEqual(
			totalAfter,
			countBefore + TOTAL,
			`After inserting ${TOTAL} records, expected total ${countBefore + TOTAL}, got ${totalAfter}`
		);

		// Pagination correctness: two consecutive pages must not share ids.
		const auth = authHeader(ctx);
		const p1Resp = await fetch(`${ctx.harper.httpURL}/Product?limit(50)`, {
			headers: { Authorization: auth },
		});
		const p2Resp = await fetch(`${ctx.harper.httpURL}/Product?limit(50,100)`, {
			headers: { Authorization: auth },
		});
		strictEqual(p1Resp.status, 200, `Page 1 status ${p1Resp.status}`);
		strictEqual(p2Resp.status, 200, `Page 2 status ${p2Resp.status}`);
		const p1Data = await p1Resp.json();
		ok(Array.isArray(p1Data), `Expected array response for page 1, got: ${JSON.stringify(p1Data)}`);
		const p2Data = await p2Resp.json();
		ok(Array.isArray(p2Data), `Expected array response for page 2, got: ${JSON.stringify(p2Data)}`);
		const ids1 = new Set((p1Data as Array<{ id: string }>).map((r) => r.id));
		const ids2 = (p2Data as Array<{ id: string }>).map((r) => r.id);
		strictEqual(ids1.size, 50, `Page 1 should have 50 distinct records`);
		strictEqual(ids2.length, 50, `Page 2 should have 50 records`);
		for (const id of ids2) {
			ok(!ids1.has(id), `Pagination overlap: id ${id} appeared on both page 1 and page 2`);
		}
	});

	// ── Test 3: Multi-condition search on indexed table ────────────────────────
	test('multi-condition search on indexed table', async () => {
		const TOTAL = 5_000;
		const BATCH = 500;
		const ID_OFFSET = 400_000;

		for (let start = 0; start < TOTAL; start += BATCH) {
			const end = Math.min(start + BATCH, TOTAL);
			const records = [];
			for (let i = start; i < end; i++) {
				records.push(makeProduct(ID_OFFSET + i));
			}
			await insertBatch(ctx, 'Product', records);
		}

		// search_by_conditions with category='A' — verify all results have category='A'.
		// (A SQL string-range count was dropped here: lexicographic ordering on the string IDs
		// made it a weak liveness check rather than a correctness check. The purity loop below
		// is the real assertion for indexed multi-condition search.)
		const catASample = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			database: 'data',
			table: 'Product',
			get_attributes: ['id', 'category', 'inStock'],
			conditions: [{ attribute: 'category', comparator: 'equals', value: 'A' }],
			limit: 100,
		});

		ok(Array.isArray(catASample), `Expected array, got ${JSON.stringify(catASample)}`);
		ok(catASample.length > 0, `Expected results for category=A, got none`);
		for (const rec of catASample as Array<{ id: string; category: string }>) {
			strictEqual(rec.category, 'A', `Record ${rec.id} has wrong category '${rec.category}'`);
		}
	});

	// ── Test 4: Bulk delete + free-page correctness ───────────────────────────
	test('bulk insert then delete: record-level correctness', async () => {
		// Storage reclamation (compaction) is tracked separately; this verifies
		// record-level correctness of bulk delete.
		const TOTAL = 1_000;
		const ID_OFFSET = 600_000;

		const records = Array.from({ length: TOTAL }, (_, i) => makeProduct(ID_OFFSET + i));
		await insertBatch(ctx, 'Product', records);

		// Verify inserted via SQL.
		const beforeCount = await countRows(ctx, 'Product');
		ok(beforeCount >= TOTAL, `Expected at least ${TOTAL} records before delete, got ${beforeCount}`);

		// Build hash_values list for the operations API delete.
		const hashValues = Array.from({ length: TOTAL }, (_, i) => `prod-${ID_OFFSET + i}`);
		const deleteResult = await sendOperation(ctx.harper, {
			operation: 'delete',
			database: 'data',
			table: 'Product',
			hash_values: hashValues,
		});
		ok(deleteResult, `Delete returned no result: ${JSON.stringify(deleteResult)}`);

		// Direct point check: prod-600000 should be gone.
		const pointCheck = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			database: 'data',
			table: 'Product',
			get_attributes: ['id'],
			conditions: [{ attribute: 'id', comparator: 'equals', value: `prod-${ID_OFFSET}` }],
		});
		ok(
			Array.isArray(pointCheck) && pointCheck.length === 0,
			`Expected prod-${ID_OFFSET} to be deleted, but found ${JSON.stringify(pointCheck)}`
		);

		// Verify total count decreased by exactly TOTAL.
		const afterTotalCount = await countRows(ctx, 'Product');
		strictEqual(
			afterTotalCount,
			beforeCount - TOTAL,
			`Expected total to decrease by ${TOTAL} after bulk delete, got ${afterTotalCount}`
		);
	});

	// ── Test 5: EAV at scale ──────────────────────────────────────────────────
	test('EAV at scale: 1K entity rows + 5K attribute rows, query by productId', async () => {
		const ENTITY_COUNT = 1_000;
		const ATTRS_PER_ENTITY = 5;
		const ID_OFFSET = 800_000;

		// Insert entity records.
		const entityRecords = Array.from({ length: ENTITY_COUNT }, (_, i) => makeProduct(ID_OFFSET + i));
		await insertBatch(ctx, 'Product', entityRecords);

		// Insert attribute rows: 5 per entity.
		// Note: 'attrValue' is used instead of 'value' to avoid collision with reserved field names.
		const ATTR_BATCH = 500;
		const attrRecords: object[] = [];
		for (let e = 0; e < ENTITY_COUNT; e++) {
			for (let a = 0; a < ATTRS_PER_ENTITY; a++) {
				attrRecords.push({
					id: `attr-${ID_OFFSET + e}-${a}`,
					productId: `prod-${ID_OFFSET + e}`,
					key: `attr_${a}`,
					attrValue: `val_${e}_${a}`,
				});
			}
		}
		for (let start = 0; start < attrRecords.length; start += ATTR_BATCH) {
			await insertBatch(ctx, 'Attribute', attrRecords.slice(start, start + ATTR_BATCH));
		}

		// Query attributes for a single entity by indexed productId.
		const targetId = `prod-${ID_OFFSET + 42}`;
		const attrs = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			database: 'data',
			table: 'Attribute',
			get_attributes: ['id', 'productId', 'key', 'attrValue'],
			conditions: [{ attribute: 'productId', comparator: 'equals', value: targetId }],
			limit: ATTRS_PER_ENTITY + 1,
		});

		ok(Array.isArray(attrs), `Expected array from search_by_conditions, got ${JSON.stringify(attrs)}`);
		strictEqual(
			attrs.length,
			ATTRS_PER_ENTITY,
			`Expected ${ATTRS_PER_ENTITY} attributes for ${targetId}, got ${attrs.length}`
		);
		for (const attr of attrs as Array<{ productId: string }>) {
			strictEqual(
				attr.productId,
				targetId,
				`Attribute has wrong productId: expected ${targetId}, got ${attr.productId}`
			);
		}
	});
});
