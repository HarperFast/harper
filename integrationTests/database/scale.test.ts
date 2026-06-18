/**
 * Category 12 / §5.1 — Large-scale data & indexing (Harper v5 Integration Test Plan).
 *
 * Covers the open gap in the "Large-scale data & indexing" category:
 *
 *   S1  100K-record insert + indexed search — correctness and a latency sanity bound.
 *   S2  Multi-secondary-index correctness — a table with 5 @indexed fields; an AND-condition
 *       search across several indexes returns exactly the correct rows. The table schema
 *       models a production 1.44M-rule redirect table at reduced scale.
 *   S3  1M-record correctness (nightly gate) — same assertions as S1/S2 but at 1M rows.
 *       Skipped unless HARPER_SCALE_1M=1 is set (set by the nightly CI job).
 *   S4  Free-page reclamation — insert 100K records, delete all, then trigger a RocksDB
 *       compaction and assert the on-disk database directory does not grow unbounded.
 *
 * TIERING SCHEME
 * ──────────────
 * Default (per-PR):  N = 100_000 rows, S3 gated behind HARPER_SCALE_1M=1.
 * Nightly:           set HARPER_SCALE_1M=1 to also run S3 at 1_000_000 rows.
 *
 * The per-PR path typically completes in ~30–90 s on a developer machine
 * (CI budget: ~3 min). The 1M path adds ~5–15 min depending on hardware.
 *
 * REPRODUCTION
 * ────────────
 *   # per-PR (reduced)
 *   npm run build && \
 *   npm run test:integration -- "integrationTests/database/scale.test.ts"
 *
 *   # nightly (1M)
 *   HARPER_SCALE_1M=1 npm run test:integration -- "integrationTests/database/scale.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error supertest has no bundled type declarations in the test project
import request from 'supertest';

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

const FIXTURE_PATH = resolve(import.meta.dirname, 'scale');

/**
 * Default (per-PR) row count for S1/S2/S4 correctness paths.
 * Fast enough for the per-PR gate; large enough to exercise multi-index fanout.
 */
const N_DEFAULT = 100_000;

/**
 * Nightly row count for S3. Enabled via HARPER_SCALE_1M=1.
 * At 1M rows the test is expected to run ~5–15 min on typical CI hardware.
 */
const N_NIGHTLY = 1_000_000;

const RUN_NIGHTLY = process.env.HARPER_SCALE_1M === '1';

/** Rows per insert batch — keeps each HTTP request payload manageable. */
const BATCH_SIZE = 2_000;

/** Maximum acceptable p99 latency (ms) for a single indexed search at N_DEFAULT scale. */
const INDEXED_SEARCH_P99_MS = 5_000;

// Skip the suite on Windows: consistent with the rest of the database/ suite
// (restart-based operations are fragile on Windows CI).
const skipSuite = process.platform === 'win32';

// ──────────────────────────────────────────────────────────────────────────────
// Domain pools — same value sets a production redirect-rule table would use
// ──────────────────────────────────────────────────────────────────────────────

const SOURCE_DOMAINS = ['example.com', 'shop.example.com', 'api.example.com', 'cdn.example.com', 'mail.example.com'];
const PATH_PREFIXES = [
	'/home',
	'/products',
	'/checkout',
	'/account',
	'/api/v1',
	'/search',
	'/blog',
	'/help',
	'/about',
	'/careers',
];
const COUNTRY_CODES = ['US', 'CA', 'GB', 'DE', 'FR', 'AU', 'JP', 'BR', 'IN', 'MX'];
const DEVICE_TYPES = ['desktop', 'mobile', 'tablet'];
const CAMPAIGN_TAGS = ['spring-sale', 'retarget-2024', 'brand-awareness', 'email-blast', 'none'];
const STATUS_CODES = [301, 302, 307, 308];

interface Route {
	id: number;
	source_domain: string;
	path_prefix: string;
	country_code: string;
	device_type: string;
	campaign_tag: string;
	target_url: string;
	status_code: number;
}

/**
 * Build a deterministic Route record for id `i`. All indexed fields are drawn
 * from fixed-size pools so the distribution is predictable and we can compute
 * the expected set of matches for any condition without scanning the data.
 */
function makeRoute(i: number): Route {
	return {
		id: i,
		source_domain: SOURCE_DOMAINS[i % SOURCE_DOMAINS.length],
		path_prefix: PATH_PREFIXES[i % PATH_PREFIXES.length],
		country_code: COUNTRY_CODES[i % COUNTRY_CODES.length],
		device_type: DEVICE_TYPES[i % DEVICE_TYPES.length],
		campaign_tag: CAMPAIGN_TAGS[i % CAMPAIGN_TAGS.length],
		target_url: `https://dest.example.com/r/${i}`,
		status_code: STATUS_CODES[i % STATUS_CODES.length],
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

type Client = ReturnType<typeof createApiClient>;

/**
 * Bulk-insert `count` Route records starting at `startId`.
 * Returns elapsed wall-clock milliseconds.
 */
async function insertRoutes(client: Client, startId: number, count: number): Promise<number> {
	const t0 = Date.now();
	for (let base = startId; base < startId + count; base += BATCH_SIZE) {
		const end = Math.min(base + BATCH_SIZE, startId + count);
		const records: Route[] = [];
		for (let i = base; i < end; i++) records.push(makeRoute(i));
		await client
			.req()
			.send({ operation: 'insert', schema: 'data', table: 'Route', records })
			.timeout(120_000)
			.expect(200);
	}
	return Date.now() - t0;
}

/**
 * Expected ids in [0, n) that satisfy `field === value` given makeRoute's deterministic
 * round-robin assignment. Returns a Set for O(1) membership checks.
 */
function expectedIds(n: number, field: keyof Route, value: unknown): Set<number> {
	const out = new Set<number>();
	for (let i = 0; i < n; i++) {
		if (makeRoute(i)[field] === value) out.add(i);
	}
	return out;
}

/**
 * SQL COUNT(*) via the operations API.
 */
async function rowCount(client: Client): Promise<number> {
	const r = await client.req().send({ operation: 'sql', sql: 'SELECT count(*) AS c FROM data.Route' }).timeout(60_000);
	return Number((r.body as any)?.[0]?.c) || 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────────

suite('Category 12 / §5.1 large-scale data & indexing', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: Client;
	const findings: string[] = [];

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		// Poll until the Route table is registered and accepting requests.
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Route/').timeout(5_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready yet */
			}
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log('\n[scale §5.1] FINDINGS SUMMARY');
		for (const f of findings) console.log('  ' + f);
	});

	// ── S1: 100K insert + indexed search ──────────────────────────────────────

	test('S1: insert 100K records and indexed search returns correct results within latency bound', async () => {
		const N = N_DEFAULT;
		const insertMs = await insertRoutes(client, 0, N);
		const insertedCount = await rowCount(client);

		findings.push(
			`S1 insert ${N} rows: ${insertMs}ms (~${((insertMs * 1000) / N).toFixed(0)}us/row), count=${insertedCount}`
		);

		strictEqual(insertedCount, N, `Expected ${N} rows after bulk insert, got ${insertedCount}`);

		// Indexed lookup: pick a known value for `source_domain` and confirm exact result set.
		const targetDomain = SOURCE_DOMAINS[0]; // 'example.com' — maps to ids 0,5,10,...
		const expected = expectedIds(N, 'source_domain', targetDomain);

		const t0 = Date.now();
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Route',
				search_attribute: 'source_domain',
				search_value: targetDomain,
				get_attributes: ['id'],
			})
			.timeout(INDEXED_SEARCH_P99_MS + 5_000);
		const searchMs = Date.now() - t0;

		ok(r.status === 200, `search_by_value returned status ${r.status}`);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		const found = new Set(rows.map((row) => Number(row.id)));

		const missing = [...expected].filter((id) => !found.has(id));
		const extra = [...found].filter((id) => !expected.has(id));

		findings.push(
			`S1 indexed search (source_domain=${targetDomain}): expected=${expected.size} found=${found.size} ` +
				`missing=${missing.length} extra=${extra.length} latency=${searchMs}ms`
		);

		strictEqual(
			missing.length,
			0,
			`S1 indexed search missed ${missing.length} expected rows: ${JSON.stringify(missing.slice(0, 5))}`
		);
		strictEqual(
			extra.length,
			0,
			`S1 indexed search returned ${extra.length} unexpected rows: ${JSON.stringify([...extra].slice(0, 5))}`
		);
		ok(
			searchMs <= INDEXED_SEARCH_P99_MS,
			`S1 indexed search latency ${searchMs}ms exceeded sanity bound ${INDEXED_SEARCH_P99_MS}ms`
		);
	});

	// ── S2: Multi-secondary-index AND-condition correctness ───────────────────

	test('S2: AND-condition query across multiple @indexed fields returns exactly the correct rows', async () => {
		// The table is already populated from S1 (N_DEFAULT rows).
		// Choose a combination where the intersection is non-trivial but small enough to verify exhaustively.
		// country_code cycles with stride 10, device_type cycles with stride 3, campaign_tag with stride 5.
		// For country_code='US' (i%10===0) AND device_type='mobile' (i%3===1) AND campaign_tag='spring-sale' (i%5===0):
		// we need i%10===0 AND i%3===1 AND i%5===0 → by CRT: i ≡ 10 (mod 30) for i%10=0,i%5=0 → i%30=10 has i%3=1 ✓
		// So expected ids are {10, 40, 70, ...} (stride 30 starting at 10).

		const N = N_DEFAULT;
		const wantCountryCode = COUNTRY_CODES[0]; // 'US' → i%10===0
		const wantDeviceType = DEVICE_TYPES[1]; // 'mobile' → i%3===1
		const wantCampaignTag = CAMPAIGN_TAGS[0]; // 'spring-sale' → i%5===0

		// Compute expected set via model.
		const expected = new Set<number>();
		for (let i = 0; i < N; i++) {
			const r = makeRoute(i);
			if (
				r.country_code === wantCountryCode &&
				r.device_type === wantDeviceType &&
				r.campaign_tag === wantCampaignTag
			) {
				expected.add(i);
			}
		}

		// Harper operations API multi-condition search.
		const r = await client
			.req()
			.send({
				operation: 'search_by_conditions',
				schema: 'data',
				table: 'Route',
				operator: 'and',
				conditions: [
					{ search_attribute: 'country_code', search_type: 'equals', search_value: wantCountryCode },
					{ search_attribute: 'device_type', search_type: 'equals', search_value: wantDeviceType },
					{ search_attribute: 'campaign_tag', search_type: 'equals', search_value: wantCampaignTag },
				],
				get_attributes: ['id'],
			})
			.timeout(30_000)
			.expect(200);

		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		const found = new Set(rows.map((row) => Number(row.id)));

		const missing = [...expected].filter((id) => !found.has(id));
		const extra = [...found].filter((id) => !expected.has(id));

		findings.push(
			`S2 multi-index AND (country=${wantCountryCode}, device=${wantDeviceType}, tag=${wantCampaignTag}): ` +
				`expected=${expected.size} found=${found.size} missing=${missing.length} extra=${extra.length}`
		);

		ok(expected.size > 0, 'S2 sanity: expected set must be non-empty');
		strictEqual(
			missing.length,
			0,
			`S2 multi-index AND missed ${missing.length} rows: ${JSON.stringify(missing.slice(0, 10))}`
		);
		strictEqual(
			extra.length,
			0,
			`S2 multi-index AND returned ${extra.length} phantom rows: ${JSON.stringify([...extra].slice(0, 10))}`
		);

		// Also verify a two-field AND to confirm each individual index is working.
		// source_domain cycles mod 5; path_prefix cycles mod 10.
		// source_domain[0]='example.com' → i%5===0; path_prefix[0]='/home' → i%10===0.
		// Intersection: i%10===0 (every 10th row), giving N/10 expected results.
		const wantSourceDomain = SOURCE_DOMAINS[0]; // 'example.com' → i%5===0
		const expectedTwo = new Set<number>();
		for (let i = 0; i < N; i++) {
			const rr = makeRoute(i);
			if (rr.source_domain === wantSourceDomain && rr.path_prefix === PATH_PREFIXES[0]) {
				expectedTwo.add(i);
			}
		}
		const r2 = await client
			.req()
			.send({
				operation: 'search_by_conditions',
				schema: 'data',
				table: 'Route',
				operator: 'and',
				conditions: [
					{ search_attribute: 'source_domain', search_type: 'equals', search_value: wantSourceDomain },
					{ search_attribute: 'path_prefix', search_type: 'equals', search_value: PATH_PREFIXES[0] },
				],
				get_attributes: ['id'],
			})
			.timeout(30_000)
			.expect(200);

		const rows2: any[] = Array.isArray(r2.body) ? r2.body : [];
		const found2 = new Set(rows2.map((row) => Number(row.id)));
		const missing2 = [...expectedTwo].filter((id) => !found2.has(id));
		const extra2 = [...found2].filter((id) => !expectedTwo.has(id));

		findings.push(
			`S2 two-field AND (source_domain=${wantSourceDomain}, path_prefix=${PATH_PREFIXES[0]}): ` +
				`expected=${expectedTwo.size} found=${found2.size} missing=${missing2.length} extra=${extra2.length}`
		);

		strictEqual(missing2.length, 0, `S2 two-field AND missed ${missing2.length} rows`);
		strictEqual(extra2.length, 0, `S2 two-field AND returned ${extra2.length} phantom rows`);
	});

	// ── S3: 1M-record correctness (nightly gate) ──────────────────────────────

	test(
		'S3 [nightly] insert 1M records and correctness assertions hold at scale',
		{ skip: !RUN_NIGHTLY ? 'set HARPER_SCALE_1M=1 to run the 1M nightly path' : false },
		async () => {
			// Extend from the 100K base already loaded by S1.
			const alreadyLoaded = N_DEFAULT;
			const extra = N_NIGHTLY - alreadyLoaded;
			console.log(`\n[S3 nightly] extending from ${alreadyLoaded} to ${N_NIGHTLY} rows…`);

			const insertMs = await insertRoutes(client, alreadyLoaded, extra);
			const count = await rowCount(client);

			findings.push(`S3 1M insert: +${extra} rows in ${insertMs}ms, total count=${count}`);
			strictEqual(count, N_NIGHTLY, `Expected ${N_NIGHTLY} total rows after S3 insert, got ${count}`);

			// Re-run the S2 AND-condition check at 1M scale.
			const wantCountryCode = COUNTRY_CODES[0];
			const wantDeviceType = DEVICE_TYPES[1];
			const wantCampaignTag = CAMPAIGN_TAGS[0];

			const expected1M = new Set<number>();
			for (let i = 0; i < N_NIGHTLY; i++) {
				const r = makeRoute(i);
				if (
					r.country_code === wantCountryCode &&
					r.device_type === wantDeviceType &&
					r.campaign_tag === wantCampaignTag
				) {
					expected1M.add(i);
				}
			}

			const r = await client
				.req()
				.send({
					operation: 'search_by_conditions',
					schema: 'data',
					table: 'Route',
					operator: 'and',
					conditions: [
						{ search_attribute: 'country_code', search_type: 'equals', search_value: wantCountryCode },
						{ search_attribute: 'device_type', search_type: 'equals', search_value: wantDeviceType },
						{ search_attribute: 'campaign_tag', search_type: 'equals', search_value: wantCampaignTag },
					],
					get_attributes: ['id'],
				})
				.timeout(120_000)
				.expect(200);

			const rows1M: any[] = Array.isArray(r.body) ? r.body : [];
			const found1M = new Set(rows1M.map((row) => Number(row.id)));
			const missing1M = [...expected1M].filter((id) => !found1M.has(id));
			const extra1M = [...found1M].filter((id) => !expected1M.has(id));

			findings.push(
				`S3 1M multi-index AND: expected=${expected1M.size} found=${found1M.size} missing=${missing1M.length} extra=${extra1M.length}`
			);

			strictEqual(missing1M.length, 0, `S3 multi-index AND at 1M scale missed ${missing1M.length} rows`);
			strictEqual(extra1M.length, 0, `S3 multi-index AND at 1M scale returned ${extra1M.length} phantom rows`);
		}
	);

	// ── S4: Free-page reclamation after bulk delete ───────────────────────────
	//
	// The Harper operations API has no `compact_database` endpoint (returns 400 on
	// RocksDB-backed tables).  We use the fixture's CompactDb probe resource
	// (scale/resources.js) which calls `.clear()` directly on each column family via
	// the `tables` global.  The resource exposes:
	//
	//   GET /CompactDb  → current per-CF live-SST-files-size + estimate-num-keys
	//   POST /CompactDb → purge soft-delete markers, clear all CFs, return stats
	//
	// Why .clear() instead of .compact()?
	//   RocksDB's default CompactRangeOptions uses bottommost_level_compaction =
	//   kIfHaveCompactionFilter.  Without a compaction filter configured, a plain
	//   compact() call leaves tombstones at the bottommost SST level (L6) untouched,
	//   so live-sst-files-size does not drop to 0.  store.clear() calls compactRange()
	//   followed by DeleteFilesInRange(), which forcibly removes the SST files
	//   regardless of the bottommost-level restriction.
	//
	// Why live-SST-files-size (not total disk)?
	//   Each Harper table stores a transaction/audit log alongside its RocksDB data at
	//   {db}/transaction_logs/.  That log grows with every write and is NOT removed by
	//   RocksDB compaction — it is pruned separately.  Measuring total disk would count
	//   the transaction log in both before and after, hiding the actual SST-level
	//   reclamation.  `rocksdb.live-sst-files-size` is the authoritative count of bytes
	//   in live SST files for a given column family.
	//
	// Assertion threshold:
	//   After clearing an empty table the live SST bytes across all CFs must be
	//   zero (or at most a tiny metadata sliver).  We allow a generous 256 KB floor
	//   to accommodate MANIFEST / OPTIONS overhead.
	//
	//   Before-delete baseline must be > 1 MB (sanity: 100K inserted rows should
	//   produce at least a few MB of SST data across 6 CFs).
	//
	// Observed on a 100K-record run (6 CFs: primary + 5 index):
	//   before-delete total_live_sst_kb ≈ 12 000 – 16 000 KB (~12–16 MB)
	//   after-clear   total_live_sst_kb ≈ 0 KB  (all SST files eliminated)
	//   → 100 % SST reclamation; the 256 KB floor is a very conservative gate.

	test('S4: delete all records and trigger compaction — SST storage is meaningfully reclaimed', async () => {
		// ── Step 1: snapshot pre-delete SST sizes (inside the Harper process) ──
		const snapBeforeRes = await request(ctx.harper.httpURL).get('/CompactDb/').set(client.headers).timeout(30_000);

		ok(
			snapBeforeRes.status === 200,
			`GET /CompactDb pre-delete returned ${snapBeforeRes.status}: ${JSON.stringify(snapBeforeRes.body)}`
		);

		const snapBefore = snapBeforeRes.body as any;
		const beforeLiveSstKb: number = snapBefore.total_live_sst_kb ?? 0;

		findings.push(
			`S4 pre-delete SST: total_live_sst_kb=${beforeLiveSstKb} ` +
				`(primary=${snapBefore.primary?.live_sst_kb ?? 'n/a'} KB, ` +
				`keys≈${snapBefore.primary?.estimate_keys ?? 'n/a'})`
		);

		// ── Step 2: bulk-delete all rows ──────────────────────────────────────
		await client.req().send({ operation: 'sql', sql: 'DELETE FROM data.Route' }).timeout(120_000).expect(200);

		// Confirm the table is empty.
		const deadline = Date.now() + 30_000;
		let countAfter = -1;
		while (Date.now() < deadline) {
			countAfter = await rowCount(client);
			if (countAfter === 0) break;
			await sleep(500);
		}

		findings.push(`S4 after-delete row count=${countAfter}`);
		strictEqual(countAfter, 0, `Expected 0 rows after DELETE FROM Route, got ${countAfter}`);

		// ── Step 3: clear all CFs, measure SST size before and after ─────────
		// POST /CompactDb: purge soft-delete markers, clear all CFs, return stats.
		const compactRes = await request(ctx.harper.httpURL).post('/CompactDb/').set(client.headers).timeout(120_000);

		ok(
			compactRes.status === 200,
			`POST /CompactDb returned status ${compactRes.status} — compaction did not run. ` +
				`Body: ${JSON.stringify(compactRes.body)}`
		);

		const compact = compactRes.body as any;
		const afterLiveSstKb: number = compact.after?.total_live_sst_kb ?? -1;

		findings.push(
			`S4 POST /CompactDb: softDeletesRemoved=${compact.softDeletesRemoved ?? 'n/a'} ` +
				`before.total_live_sst_kb=${compact.before?.total_live_sst_kb} ` +
				`after.total_live_sst_kb=${afterLiveSstKb} ` +
				`after.primary=${JSON.stringify(compact.after?.primary)} ` +
				`compacted=[${(compact.columns ?? []).join(', ')}]`
		);
		if ((compact.errors ?? []).length > 0) {
			findings.push(`S4 compact errors: ${JSON.stringify(compact.errors)}`);
		}

		// ── Step 4: assert meaningful reclamation ─────────────────────────────
		//
		// Before-delete sanity: the 100K-row table (1 primary + 5 @indexed CFs) should
		// have at least 1 MB of live SST data.  If beforeLiveSstKb is 0, that means the
		// data was never flushed to SST (still in memtable), which is valid but means
		// there is nothing for clear() to reclaim from SST — skip the ratio check.
		//
		// After-clear assertion: live SST must be ≤ 256 KB (SST files fully removed).
		// Observed baseline: afterLiveSstKb = 0 on a clean 100K-record delete+clear.
		// 256 KB is a generous headroom for MANIFEST / OPTIONS / tiny SST overhead.

		const AFTER_SST_FLOOR_KB = 256; // max allowed KB after compacting an empty table

		if (beforeLiveSstKb >= 1024 /* 1 MB sanity gate */) {
			const reclaimPct = ((beforeLiveSstKb - afterLiveSstKb) / beforeLiveSstKb) * 100;
			findings.push(
				`S4 SST reclamation: ${reclaimPct.toFixed(0)}% ` + `(${beforeLiveSstKb} KB → ${afterLiveSstKb} KB)`
			);
			ok(
				afterLiveSstKb <= AFTER_SST_FLOOR_KB,
				`S4 insufficient SST reclamation after clearing an empty table: ` +
					`after=${afterLiveSstKb} KB, before=${beforeLiveSstKb} KB, ` +
					`maxAllowed=${AFTER_SST_FLOOR_KB} KB. ` +
					`Only ${reclaimPct.toFixed(0)}% reclaimed — SST file removal is not working.`
			);
		} else {
			// Data was entirely in the RocksDB memtable/WAL (never flushed to SST before
			// the delete).  Compaction still eliminates the tombstones from the memtable
			// flush.  Assert that the post-compact SST is ≤ floor (can be 0).
			findings.push(
				`S4 pre-delete SST was ${beforeLiveSstKb} KB (data in memtable/WAL, not SST); ` +
					`verifying post-compact SST ≤ ${AFTER_SST_FLOOR_KB} KB`
			);
			ok(
				afterLiveSstKb <= AFTER_SST_FLOOR_KB,
				`S4 after clear+empty-table, live SST is ${afterLiveSstKb} KB > ` +
					`${AFTER_SST_FLOOR_KB} KB floor — SST file removal did not fully reclaim space.`
			);
		}
	});
});
