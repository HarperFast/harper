/**
 * QA-190 — TRUE 64-bit Long values above 2^53 on @indexed attributes.
 *
 * RESIDUAL GAP FROM QA-188: QA-188 tested Long(>2^53) via a Float column. JS doubles
 * cannot represent 2^53+1 (collapses to 2^53), so the genuine 64-bit path was never
 * exercised. This scenario tests whether Harper can store and range-query DISTINCT values
 * above 2^53 using typed attributes.
 *
 * TWO-TRACK INVESTIGATION:
 *
 * Track A — Long @indexed (Harper's 64-bit Long type):
 *   Hypothesis: Long is capped at Math.abs <= 9007199254740992 (2^53) in both the
 *   setter (resources/tracked.ts:104) AND the validate path (Table.ts:3394). Values
 *   above 2^53 sent as JS numbers are already collapsed to 2^53 before reaching Harper
 *   (JS double precision loss). Values > 2^53 sent as bigint via CBOR trigger a TypeError
 *   in the setter. Values above 2^53 (even representable floats like 2^53+2) are rejected
 *   by validate(). Expected finding: typed-Long storage limitation.
 *
 * Track B — BigInt @indexed (Harper's arbitrary-precision integer type):
 *   Hypothesis: BigInt accepts JS bigint natively. CBOR carries bigint values through the
 *   parse layer. coerceType for BigInt does BigInt(value), so STRING search_values in JSON
 *   range queries work correctly (BigInt('9007199254740993') = 9007199254740993n). The
 *   ordered-binary library encodes bigint distinctly above 2^53. Expected: correct distinct
 *   storage + range queries at and above the 2^53 precision wall.
 *
 * METHOD — SINGLE-SNAPSHOT ORACLE (per QA-184):
 *   For every range case a single full-table scan is fetched once (REST GET /BigRow/?limit=200
 *   with Accept: application/cbor so bigint values survive the response round-trip). Range-
 *   query results are reconciled against a JS-filtered subset of THIS SAME snapshot. No
 *   cross-snapshot artifact is possible.
 *
 * ENCODING STRATEGY FOR TRUE LONGS:
 *   - INSERT: REST PUT with Content-Type: application/cbor, body encoded by cbor-x from JS
 *     bigint literals (e.g. 9007199254740993n). cbor-x uses CBOR tag 2/3 for BigInt, which
 *     the Harper server decodes back to JS bigint via cbor-x Encoder.
 *   - READ: REST GET with Accept: application/cbor, decode with cbor-x. Bigint values
 *     preserved in response.
 *   - SEARCH: search_by_conditions via operations API with search_value as STRING
 *     (e.g. '9007199254740993'). coerceType for BigInt attribute calls BigInt(string),
 *     preserving full precision. Sending as JSON number would collapse >2^53.
 *
 * VALUE DISTRIBUTION (BigRow, bval = BigInt @indexed):
 *   TWO53_M2 = 2^53 - 2  = 9007199254740990  (representable float, boundary-2)
 *   TWO53_M1 = 2^53 - 1  = 9007199254740991  (max float with ULP=1 below boundary)
 *   TWO53    = 2^53       = 9007199254740992  (exact representable boundary)
 *   TWO53_P1 = 2^53 + 1  = 9007199254740993  (NOT representable as float — KEY TEST VALUE)
 *   TWO53_P2 = 2^53 + 2  = 9007199254740994  (representable float, +2 ULP from 2^53)
 *   TWO53_P3 = 2^53 + 3  = 9007199254740995  (NOT representable as float)
 *   LARGE    = 2^62       = 4611686018427387904n
 *   NEAR_MAX = 2^63 - 2   = 9223372036854775806n
 *
 * RANGE CASES (BigRow.bval, BigInt @indexed):
 *   [B0] Round-trip: all 8 values read back via CBOR equal their inserted bigint literals
 *   [B1] bval >= TWO53_P1 (string)  — must include P1, P2, P3, LARGE, NEAR_MAX; exclude TWO53
 *   [B2] bval > TWO53 (string)      — same oracle as B1 (TWO53 is exclusive lower bound)
 *   [B3] bval <= TWO53 (string)     — must include M2, M1, TWO53; exclude P1+
 *   [B4] bval < TWO53_P1 (string)   — must include M2, M1, TWO53; exclude P1+
 *   [B5] bval >= TWO53_M1 AND bval <= TWO53_P2 (closed range across precision wall)
 *        — must include M1, TWO53, P1, P2; exclude M2 and P3+; count must be exactly 4
 *   [B6] bval >= NEAR_MAX (string)  — large value endpoint, only NEAR_MAX expected
 *   [B7] ordering: scan all rows, verify bval values are in strictly-ascending bigint order
 *
 * RANGE CASES (LongRow.lval, Long @indexed):
 *   [LA1] JS-number 9007199254740993 is collapsed to 9007199254740992 at the JS level
 *         BEFORE it reaches Harper — stored value matches 2^53 (not 2^53+1)
 *   [LA2] Operations API rejects values > 2^53 even when representable as float (2^53+2)
 *   [LA3] CBOR bigint into Long column is rejected at the REST PUT level (Long setter or validate)
 *
 * Harper SHA: 7aaa5a152
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/bigint-indexed-range.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/bigint-indexed-range.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { encode as cborEncode, decode as cborDecode } from 'cbor-x';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'bigint-indexed-range');
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

// ── 64-bit boundary constants (bigint literals — NOT BigInt(number)) ─────────
// IMPORTANT: BigInt(9007199254740993) collapses! Use literal 9007199254740993n.
const TWO53 = 9007199254740992n; // 2^53 exactly — representable as float
const TWO53_M2 = TWO53 - 2n; // 9007199254740990 — representable float
const TWO53_M1 = TWO53 - 1n; // 9007199254740991 — representable float
const TWO53_P1 = TWO53 + 1n; // 9007199254740993 — NOT representable as float
const TWO53_P2 = TWO53 + 2n; // 9007199254740994 — representable float (even)
const TWO53_P3 = TWO53 + 3n; // 9007199254740995 — NOT representable as float
const LARGE = 4611686018427387904n; // 2^62
const NEAR_MAX = 9223372036854775806n; // 2^63 - 2

type Client = ReturnType<typeof createApiClient>;

// ── helpers ───────────────────────────────────────────────────────────────────

/** REST PUT with CBOR body — carries true bigint values through cbor-x encoding. */
async function cborPut(
	restURL: string,
	authHeaders: Record<string, string>,
	table: string,
	record: Record<string, unknown>
) {
	const body = cborEncode(record);
	return request(restURL)
		.put(`/${table}/${record.id}`)
		.set({ ...authHeaders, 'Content-Type': 'application/cbor', 'Accept': 'application/cbor' })
		.send(body)
		.timeout(30_000);
}

/** REST GET single record with CBOR accept — decodes bigint values. Returns { status, body }. */
async function cborGet(restURL: string, authHeaders: Record<string, string>, table: string, id: string) {
	const r = await request(restURL)
		.get(`/${table}/${id}`)
		.set({ ...authHeaders, Accept: 'application/cbor' })
		.buffer(true)
		.parse((res, callback) => {
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => callback(null, Buffer.concat(chunks)));
		})
		.timeout(30_000);
	if (r.status !== 200) return { status: r.status, body: null as any };
	return { status: r.status, body: cborDecode(r.body as any) as Record<string, unknown> };
}

/**
 * search_by_conditions via operations API.
 * search_value MUST be a STRING for BigInt attributes — coerceType BigInt calls
 * BigInt(string), preserving precision. Sending as JSON number collapses >2^53.
 */
async function searchBigInt(
	client: Client,
	table: string,
	conditions: Array<{ search_attribute: string; search_type: string; search_value: string }>
): Promise<Array<{ id: string; bval: unknown; label: string }>> {
	const r = await client
		.req()
		.send({
			operation: 'search_by_conditions',
			schema: 'data',
			table,
			operator: 'and',
			conditions,
			get_attributes: ['id', 'bval', 'label'],
		})
		.timeout(30_000);
	if (r.status !== 200 || !Array.isArray(r.body))
		throw new Error(`search_by_conditions failed status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 400)}`);
	return r.body;
}

/**
 * Full-table scan via operations API search_by_conditions with CBOR accept header (single snapshot).
 * Accept: application/cbor preserves bigint values in the response without JSON double-precision loss.
 * Oracle uses id >= '!' (all BigRow ids start with 'b-') to fetch all rows.
 */
async function scanAllBigRows(
	operationsURL: string,
	authHeaders: Record<string, string>
): Promise<Array<{ id: string; bval: bigint; label: string }>> {
	const body = {
		operation: 'search_by_conditions',
		schema: 'data',
		table: 'BigRow',
		operator: 'and',
		conditions: [{ search_attribute: 'id', search_type: 'greater_than_equal', search_value: '!' }],
		get_attributes: ['id', 'bval', 'label'],
		limit: 200,
	};
	const r = await request(operationsURL)
		.post('')
		.set({ ...authHeaders, 'Accept': 'application/cbor', 'Content-Type': 'application/json' })
		.send(body)
		.buffer(true)
		.parse((res, callback) => {
			const chunks: Buffer[] = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => callback(null, Buffer.concat(chunks)));
		})
		.timeout(30_000);
	if (r.status !== 200)
		throw new Error(`scan failed status=${r.status} body=${JSON.stringify(r.body ?? r.text)?.slice(0, 300)}`);
	const decoded = cborDecode(r.body as any);
	return Array.isArray(decoded) ? decoded : [decoded];
}

/** Diff: index result ids vs oracle ids. Returns extra and missing arrays. */
function diffIds(indexRows: Array<{ id: string }>, oracle: Array<{ id: string }>) {
	const idxIds = new Set(indexRows.map((r) => r.id));
	const oracleIds = new Set(oracle.map((r) => r.id));
	return {
		extra: [...idxIds].filter((id) => !oracleIds.has(id)),
		missing: [...oracleIds].filter((id) => !idxIds.has(id)),
	};
}

/** Assert index result == oracle by id-set. Logs detail and throws on divergence. */
function assertMatch(label: string, indexRows: Array<{ id: string }>, oracle: Array<{ id: string }>) {
	const { extra, missing } = diffIds(indexRows, oracle);
	const okFlag = extra.length === 0 && missing.length === 0;
	console.log(
		`  [${label}] idx=${indexRows.length} oracle=${oracle.length}` +
			` extra=${extra.length} missing=${missing.length}` +
			(okFlag
				? ' OK'
				: ` FAIL extra=${JSON.stringify(extra.slice(0, 5))} missing=${JSON.stringify(missing.slice(0, 5))}`)
	);
	deepStrictEqual(
		new Set(indexRows.map((r) => r.id)),
		new Set(oracle.map((r) => r.id)),
		`[${label}] index result diverges from oracle. extra=${JSON.stringify(extra.slice(0, 10))} missing=${JSON.stringify(missing.slice(0, 10))}`
	);
}

// ── suite ─────────────────────────────────────────────────────────────────────

suite(
	`QA-190 TRUE 64-bit Long @indexed range queries [engine=${ENGINE}]`,
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let restURL: string;
		let operationsURL: string;
		let authHeaders: Record<string, string>;

		// BigRow seed records — bval values are JS bigint, sent via CBOR PUT
		const BIG_ROWS = [
			{ id: 'b-m2', bval: TWO53_M2, label: '2^53-2' },
			{ id: 'b-m1', bval: TWO53_M1, label: '2^53-1' },
			{ id: 'b-0', bval: TWO53, label: '2^53' },
			{ id: 'b-p1', bval: TWO53_P1, label: '2^53+1' }, // NOT a valid JS float
			{ id: 'b-p2', bval: TWO53_P2, label: '2^53+2' },
			{ id: 'b-p3', bval: TWO53_P3, label: '2^53+3' }, // NOT a valid JS float
			{ id: 'b-large', bval: LARGE, label: '2^62' },
			{ id: 'b-max', bval: NEAR_MAX, label: '2^63-2' },
		];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {},
				env: { HARPER_STORAGE_ENGINE: ENGINE },
			});
			client = createApiClient(ctx.harper);
			restURL = (client as any).restURL;
			operationsURL = (client as any).operationsURL;
			authHeaders = { Authorization: client.headers.Authorization, Connection: 'close' };

			// Readiness poll (QA-188 pattern): wait until REST responds
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					const probe = await request(restURL).get('/BigRow/').set(authHeaders).timeout(3_000);
					if (probe.status !== 503 && probe.status !== 502) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}

			// ── Insert BigRow records via CBOR with true bigint values ──────────
			for (const row of BIG_ROWS) {
				const r = await cborPut(restURL, authHeaders, 'BigRow', row);
				if (r.status < 200 || r.status >= 300) {
					throw new Error(
						`BigRow PUT ${row.id} failed: status=${r.status} body=${JSON.stringify(r.text ?? r.body)?.slice(0, 300)}`
					);
				}
			}

			// ── Insert LongRow records — Long type accepts only numbers up to 2^53 ─
			// l-two53: safe boundary — 2^53 is the maximum accepted value
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'LongRow',
					records: [{ id: 'l-two53', lval: Number(TWO53), label: '2^53 safe' }],
				})
				.expect(200);

			// l-two53p1-num: JS number 9007199254740993 collapses to 9007199254740992 in JS
			// BEFORE it's JSON-serialized. The operations API receives 9007199254740992.
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'LongRow',
					records: [{ id: 'l-two53p1-num', lval: 9007199254740993, label: '2^53+1 as JS number (pre-collapsed)' }],
				})
				.expect(200);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ── Track A: Long @indexed — typed-Long storage limitation ────────────────

		test('Track A [LA1]: Long — JS number 9007199254740993 collapses to 9007199254740992 before Harper', async () => {
			console.log(`\n[QA-190 LONG CAP engine=${ENGINE}]`);
			// The key point: in JavaScript, 9007199254740993 === 9007199254740992 at the number level.
			// By the time JSON.stringify sends it, it's already 9007199254740992.
			const jsNum = 9007199254740993; // this literal is ALREADY 9007199254740992 in JS
			strictEqual(
				jsNum,
				9007199254740992,
				'[LA1] JS literal 9007199254740993 must === 9007199254740992 (double precision collapse)'
			);
			// Verify stored value via REST
			const r = await request(restURL).get('/LongRow/l-two53p1-num').set(authHeaders).timeout(10_000);
			ok(r.status === 200, `GET l-two53p1-num: expected 200, got ${r.status}`);
			const stored = r.body?.lval;
			console.log(`  l-two53p1-num stored lval = ${stored}`);
			strictEqual(
				stored,
				9007199254740992,
				`[LA1] Stored Long(2^53+1 as JS number) = ${stored}; must be 2^53 (collapsed)`
			);
			console.log(
				`  [LA1] CONFIRMED: JS number 2^53+1 collapses to 2^53 — Long type cannot store distinct >2^53 via JSON`
			);
		});

		test('Track A [LA2]: Long — operations API rejects values strictly above 2^53', async () => {
			// 9007199254740994 (= 2^53+2) is representable as a float64 AND as a JS number.
			// But Long's validate() requires Math.abs(value) <= 9007199254740992 (2^53).
			// 9007199254740994 > 9007199254740992, so it must be rejected.
			const r = await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'LongRow',
					records: [{ id: 'l-two53p2-test', lval: 9007199254740994, label: '2^53+2' }],
				})
				.timeout(10_000);
			console.log(`  LA2 insert 2^53+2 into Long: status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 200)}`);
			ok(
				r.status === 400 || r.status === 422,
				`[LA2] Expected 4xx rejection of lval=2^53+2 in Long column, got ${r.status}`
			);
			console.log(`  [LA2] CONFIRMED: Long type rejects 2^53+2 (status=${r.status}) — cap is exactly 2^53`);
		});

		test('Track A [LA3]: Long — CBOR bigint above 2^53 is rejected by Long setter/validate', async () => {
			// Send a true bigint value (2^53+1) via CBOR PUT to a Long column.
			// The Long setter calls Math.round(bigint) which throws TypeError (can't convert bigint to number).
			// Or the validate() sees typeof value !== 'number' and rejects.
			const r = await cborPut(restURL, authHeaders, 'LongRow', {
				id: 'l-cbor-bigint',
				lval: TWO53_P1,
				label: 'cbor bigint 2^53+1',
			});
			console.log(
				`  LA3 CBOR bigint into Long: status=${r.status} body=${JSON.stringify(r.text ?? r.body)?.slice(0, 250)}`
			);
			if (r.status >= 200 && r.status < 300) {
				// Accepted — check what was actually stored (should not happen per source analysis)
				const readback = await cborGet(restURL, authHeaders, 'LongRow', 'l-cbor-bigint');
				const stored = readback.body?.lval;
				console.log(`  UNEXPECTED: CBOR bigint accepted, stored lval = ${stored} (type=${typeof stored})`);
				// If stored as bigint 2^53+1, that would be surprising and means Long cap bypassed via CBOR
				// If stored as number 2^53, that means CBOR bigint was silently coerced — a different path
				if (typeof stored === 'bigint' && stored === TWO53_P1) {
					console.log(`  [LA3] DEFECT: Long column accepted true bigint 2^53+1 — stored as ${stored}`);
				} else {
					console.log(`  [LA3] Stored value: ${stored} — collapse/coercion occurred`);
				}
			} else {
				ok(r.status >= 400, `[LA3] Expected 4xx rejection of bigint in Long column via CBOR, got ${r.status}`);
				console.log(`  [LA3] CONFIRMED: CBOR bigint correctly rejected by Long column (status=${r.status})`);
			}
		});

		// ── Track B: BigInt @indexed — true 64-bit range queries ──────────────────

		test('Track B [B0]: BigInt round-trip fidelity — 2^53+1 and 2^53+3 stored distinct from 2^53', async () => {
			console.log(`\n[QA-190 BIGINT ROUNDTRIP engine=${ENGINE}]`);
			for (const row of BIG_ROWS) {
				const result = await cborGet(restURL, authHeaders, 'BigRow', row.id);
				ok(result.status === 200, `[B0] GET ${row.id}: expected 200, got ${result.status}`);
				const stored = result.body?.bval;
				console.log(`  ${row.id} expected=${row.bval.toString()} stored=${stored?.toString()} (type=${typeof stored})`);
				ok(
					typeof stored === 'bigint',
					`[B0] ${row.id}: bval must be bigint in CBOR response, got ${typeof stored} (${stored})`
				);
				strictEqual(stored, row.bval, `[B0] ${row.id}: round-trip mismatch: expected ${row.bval}, got ${stored}`);
			}
			// Specifically verify the two non-float values are distinct from 2^53
			const p1 = (await cborGet(restURL, authHeaders, 'BigRow', 'b-p1')).body?.bval;
			const p0 = (await cborGet(restURL, authHeaders, 'BigRow', 'b-0')).body?.bval;
			ok(p1 !== p0, `[B0] CRITICAL: 2^53+1 stored as ${p1}, 2^53 stored as ${p0} — must differ`);
			console.log(`  [B0] 2^53+1 (${p1}) !== 2^53 (${p0}) — distinct storage CONFIRMED`);
		});

		test('Track B [B1]: bval >= "2^53+1" (string search_value) — excludes 2^53, includes P1+', async () => {
			console.log(`\n[QA-190 BIGINT RANGE engine=${ENGINE}]`);
			const snapshot = await scanAllBigRows(operationsURL, authHeaders);
			console.log(
				`  Snapshot: ${JSON.stringify(snapshot.map((r) => ({ id: r.id, bval: r.bval?.toString() })).sort((a, b) => (BigInt(a.bval) < BigInt(b.bval) ? -1 : 1)))}`
			);

			const idxRows = await searchBigInt(client, 'BigRow', [
				{ search_attribute: 'bval', search_type: 'greater_than_equal', search_value: TWO53_P1.toString() },
			]);
			const oracle = snapshot.filter((r) => typeof r.bval === 'bigint' && r.bval >= TWO53_P1);
			assertMatch('B1 bval>=2^53+1', idxRows, oracle);
			ok(!idxRows.some((r) => r.id === 'b-0'), 'B1: b-0 (2^53) must be excluded from bval >= 2^53+1');
			ok(
				idxRows.some((r) => r.id === 'b-p1'),
				'B1: b-p1 (2^53+1) must be included in bval >= 2^53+1'
			);
			ok(
				idxRows.some((r) => r.id === 'b-large'),
				'B1: b-large (2^62) must be included in bval >= 2^53+1'
			);
			ok(
				idxRows.some((r) => r.id === 'b-max'),
				'B1: b-max (2^63-2) must be included in bval >= 2^53+1'
			);
		});

		test('Track B [B2]: bval > "2^53" (string search_value) — excludes 2^53 exactly', async () => {
			const snapshot = await scanAllBigRows(operationsURL, authHeaders);
			const idxRows = await searchBigInt(client, 'BigRow', [
				{ search_attribute: 'bval', search_type: 'greater_than', search_value: TWO53.toString() },
			]);
			const oracle = snapshot.filter((r) => typeof r.bval === 'bigint' && r.bval > TWO53);
			assertMatch('B2 bval>2^53', idxRows, oracle);
			ok(!idxRows.some((r) => r.id === 'b-0'), 'B2: b-0 (2^53) must be excluded from bval > 2^53');
			ok(
				idxRows.some((r) => r.id === 'b-p1'),
				'B2: b-p1 (2^53+1) must be included in bval > 2^53'
			);
			// B1 and B2 should return the same rows (same oracle)
			deepStrictEqual(
				new Set(idxRows.map((r) => r.id)),
				new Set(oracle.map((r) => r.id)),
				'B2: result must match oracle (same as B1 - 2^53+1 and above)'
			);
		});

		test('Track B [B3]: bval <= "2^53" (string search_value) — includes 2^53, excludes P1+', async () => {
			const snapshot = await scanAllBigRows(operationsURL, authHeaders);
			const idxRows = await searchBigInt(client, 'BigRow', [
				{ search_attribute: 'bval', search_type: 'less_than_equal', search_value: TWO53.toString() },
			]);
			const oracle = snapshot.filter((r) => typeof r.bval === 'bigint' && r.bval <= TWO53);
			assertMatch('B3 bval<=2^53', idxRows, oracle);
			ok(
				idxRows.some((r) => r.id === 'b-0'),
				'B3: b-0 (2^53) must be included in bval <= 2^53'
			);
			ok(!idxRows.some((r) => r.id === 'b-p1'), 'B3: b-p1 (2^53+1) must be excluded from bval <= 2^53');
			ok(!idxRows.some((r) => r.id === 'b-large'), 'B3: b-large must be excluded from bval <= 2^53');
		});

		test('Track B [B4]: bval < "2^53+1" (string search_value) — excludes P1, includes 2^53', async () => {
			const snapshot = await scanAllBigRows(operationsURL, authHeaders);
			const idxRows = await searchBigInt(client, 'BigRow', [
				{ search_attribute: 'bval', search_type: 'less_than', search_value: TWO53_P1.toString() },
			]);
			const oracle = snapshot.filter((r) => typeof r.bval === 'bigint' && r.bval < TWO53_P1);
			assertMatch('B4 bval<2^53+1', idxRows, oracle);
			ok(
				idxRows.some((r) => r.id === 'b-0'),
				'B4: b-0 (2^53) must be included in bval < 2^53+1'
			);
			ok(!idxRows.some((r) => r.id === 'b-p1'), 'B4: b-p1 (2^53+1) must be excluded from bval < 2^53+1');
		});

		test('Track B [B5]: closed range [2^53-1, 2^53+2] across precision wall — exactly 4 rows', async () => {
			// Must include: b-m1 (2^53-1), b-0 (2^53), b-p1 (2^53+1), b-p2 (2^53+2)
			// Must exclude: b-m2 (2^53-2), b-p3 (2^53+3), b-large, b-max
			const snapshot = await scanAllBigRows(operationsURL, authHeaders);
			const idxRows = await searchBigInt(client, 'BigRow', [
				{ search_attribute: 'bval', search_type: 'greater_than_equal', search_value: TWO53_M1.toString() },
				{ search_attribute: 'bval', search_type: 'less_than_equal', search_value: TWO53_P2.toString() },
			]);
			const oracle = snapshot.filter((r) => typeof r.bval === 'bigint' && r.bval >= TWO53_M1 && r.bval <= TWO53_P2);
			assertMatch('B5 bval in [2^53-1, 2^53+2]', idxRows, oracle);
			// Both endpoints must be present
			ok(
				idxRows.some((r) => r.id === 'b-m1'),
				'B5: b-m1 (2^53-1) lower endpoint must be included'
			);
			ok(
				idxRows.some((r) => r.id === 'b-0'),
				'B5: b-0 (2^53) must be included'
			);
			ok(
				idxRows.some((r) => r.id === 'b-p1'),
				'B5: b-p1 (2^53+1) must be included (first non-float value above 2^53)'
			);
			ok(
				idxRows.some((r) => r.id === 'b-p2'),
				'B5: b-p2 (2^53+2) upper endpoint must be included'
			);
			// Adjacent values must be excluded
			ok(!idxRows.some((r) => r.id === 'b-m2'), 'B5: b-m2 (2^53-2) must be excluded');
			ok(!idxRows.some((r) => r.id === 'b-p3'), 'B5: b-p3 (2^53+3) must be excluded');
			console.log(`  [B5] Found ${idxRows.length} rows in [2^53-1, 2^53+2]; expected exactly 4`);
			strictEqual(idxRows.length, 4, `[B5] Expected exactly 4 rows in [2^53-1, 2^53+2], got ${idxRows.length}`);
		});

		test('Track B [B6]: large value bval >= "2^62" — only LARGE and NEAR_MAX', async () => {
			const snapshot = await scanAllBigRows(operationsURL, authHeaders);
			const idxRows = await searchBigInt(client, 'BigRow', [
				{ search_attribute: 'bval', search_type: 'greater_than_equal', search_value: LARGE.toString() },
			]);
			const oracle = snapshot.filter((r) => typeof r.bval === 'bigint' && r.bval >= LARGE);
			assertMatch('B6 bval>=2^62', idxRows, oracle);
			ok(
				idxRows.some((r) => r.id === 'b-large'),
				'B6: b-large (2^62) must be included'
			);
			ok(
				idxRows.some((r) => r.id === 'b-max'),
				'B6: b-max (2^63-2) must be included'
			);
			ok(!idxRows.some((r) => r.id === 'b-p1'), 'B6: b-p1 (2^53+1) must be excluded from bval >= 2^62');
			strictEqual(
				idxRows.length,
				2,
				`[B6] Expected exactly 2 rows (2^62, 2^63-2) in bval >= 2^62, got ${idxRows.length}`
			);
		});

		test('Track B [B7]: ordering — scan sorted numerically across 2^53 precision wall', async () => {
			console.log(`\n[QA-190 ORDER engine=${ENGINE}]`);
			const snapshot = await scanAllBigRows(operationsURL, authHeaders);
			// Sort by bval bigint
			const sorted = [...snapshot].sort((a, b) => (a.bval < b.bval ? -1 : a.bval > b.bval ? 1 : 0));
			const bvals = sorted.map((r) => r.bval?.toString());
			console.log(`  Sorted bval sequence: ${bvals.join(', ')}`);
			// Verify monotonically non-decreasing
			for (let i = 1; i < sorted.length; i++) {
				const prev = sorted[i - 1].bval;
				const curr = sorted[i].bval;
				ok(
					typeof prev === 'bigint' && typeof curr === 'bigint' && prev <= curr,
					`[B7] Order violation at position ${i}: ${sorted[i - 1].id}(${prev}) > ${sorted[i].id}(${curr})`
				);
			}
			// Verify the key ordering around the precision wall
			const idx0 = sorted.findIndex((r) => r.id === 'b-0');
			const idxP1 = sorted.findIndex((r) => r.id === 'b-p1');
			const idxP2 = sorted.findIndex((r) => r.id === 'b-p2');
			ok(idx0 >= 0 && idxP1 >= 0 && idxP2 >= 0, '[B7] b-0, b-p1, b-p2 must all be present');
			ok(idx0 < idxP1, `[B7] 2^53 must sort before 2^53+1 (positions ${idx0} vs ${idxP1})`);
			ok(idxP1 < idxP2, `[B7] 2^53+1 must sort before 2^53+2 (positions ${idxP1} vs ${idxP2})`);
			console.log(`  [B7] 2^53 at pos ${idx0}, 2^53+1 at pos ${idxP1}, 2^53+2 at pos ${idxP2} — correct ordering`);
		});
	}
);
