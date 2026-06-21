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
 *   S4  Free-page reclamation — SKIPPED pending HarperFast/harper#1384.
 *       The original premise (LMDB free-page reclamation) does not translate cleanly to
 *       RocksDB: freed space is reused by the engine rather than returned to the OS.
 *       A meaningful test needs an engine-aware design; see #1384 for the investigation.
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

	// ── S4: Free-page reclamation after bulk delete (SKIPPED — see #1384) ───────
	//
	// Skipped: the original LMDB free-page reclamation premise does not translate
	// cleanly to RocksDB.  RocksDB reuses freed space internally rather than
	// returning it to the OS, so the on-disk-size assertion is not meaningful
	// without an engine-aware test design.  Investigation and rework tracked in
	// HarperFast/harper#1384.

	test(
		'S4: free-page reclamation after bulk delete',
		{
			skip: 'premise does not translate cleanly to RocksDB (freed space is reused, not returned); needs engine-aware rework — see HarperFast/harper#1384',
		},
		() => {}
	);
});
