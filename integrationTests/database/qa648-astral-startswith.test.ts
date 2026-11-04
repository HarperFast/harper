/**
 * Regression anchor for harper#1887 ("Return complete starts_with results for astral Unicode
 * values", merged 2026-07-22, fixing #1629): `starts_with` on an `@indexed` string silently
 * missed every row whose value continues with an astral-plane (U+10000+) character right after
 * the matched prefix.
 *
 * Mechanism (resources/search.ts, 'starts_with' case, before the fix): the exclusive upper bound
 * of the index range was synthesised as `value + U+FFFF`. Index keys are written by
 * ordered-binary, which merges a UTF-16 surrogate pair into the real astral codepoint and emits a
 * 4-byte sequence (lead byte 0xf0-0xf4), whereas U+FFFF encodes as 3 bytes (lead 0xef). Any row
 * whose value is `prefix + <astral char>...` therefore sorted ABOVE the synthesised bound and fell
 * outside the range before the (correct) `.startsWith()` filter ever saw it. The fix delegates
 * the prefix bound to the storage layer instead of hand-computing it.
 *
 * The discriminator: `name` is @indexed; `nameScan` is an UN-indexed mirror holding the exact
 * same string. A `starts_with` condition on `nameScan` as the SOLE condition has no index to
 * route through, so it takes the full-scan + JS-filter path (correct for surrogate pairs). Any
 * INDEX-vs-SCAN divergence proves the row is on disk and isolates the miss to the index range.
 * `RawIndex` (resources.js) reads the secondary index store directly, proving the astral rows
 * were WRITTEN to the index -- so a miss is a read-path bound bug, not a write-path one.
 *
 * Boundary matrix (all rows share literal prefix "PFX-"):
 *   - ascii / latin (BMP e-acute) / cjkbmp (BMP CJK): BMP-only controls -- expected to agree.
 *   - emoji-imm, clef-imm, extb-imm, emoji-second: astral char IMMEDIATELY after the prefix --
 *     the #1629 miss, three distinct astral chars plus a duplicate-boundary count check.
 *   - emoji-offset: astral char one BMP character AFTER the prefix boundary -- control isolating
 *     whether the miss requires exact adjacency.
 *   - other ("QFX-unrelated"): different prefix entirely -- negative control.
 * Queries:
 *   (a) prefix ends exactly BEFORE the astral char ("PFX-") -- the anchored case
 *   (c) prefix extends AFTER the astral char ("PFX-<U+1F600>") -- expected-correct control
 *   (d) equals-lookup on the exact astral value -- expected-correct control (no bound synthesis)
 *   (e) a plain `ge`+`lt` range spanning all PFX- rows -- isolates the defect to the
 *       `starts_with` end-bound arithmetic.
 * A prefix that SPLITS a surrogate pair ("PFX-" + lone high surrogate) is deliberately NOT
 * asserted here: it still diverges after #1887 (a separate residual) and is tracked as its own
 * candidate so this anchor stays green.
 *
 * Runs once with the default engine (RocksDB); rerun with HARPER_STORAGE_ENGINE=lmdb -- the key
 * encoding is shared, so both engines must agree.
 *
 * Fails-on-base: with #1887 absent, test (a) goes red (the four immediate-astral rows are
 * missing from the indexed result while the scan returns them); the controls stay green.
 *
 * Bun coverage (harper#2750): this anchor also pins ordered-binary 1.6.2. Under Bun, 1.6.1 built its
 * `readString` with `new Function`, whose body compiles in global scope, so the generated reader could
 * not resolve the module-level `finishUtf8` helper and threw `ReferenceError: finishUtf8 is not
 * defined` while DECODING any key byte >= 0x80 -- every non-ASCII value, not just astral ones. Harper
 * surfaced that as a truncated result set with HTTP 200 and nothing in hdb.log. Every non-ASCII row
 * below therefore exercises the Bun key decoder as well as the #1887 bound arithmetic.
 *
 * Originating QA scenario: QA-648 (promote candidate P-427).
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa648-astral-startswith');
const SCHEMA = 'data';
const TABLE = 'Catalog';
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const skipSuite = process.platform === 'win32';

// ── Astral-plane fixture values (escape-only, codepoints verified at load time below) ────
const EMOJI = '\u{1F600}'; // 😀 GRINNING FACE — surrogate pair 😀
const CLEF = '\u{1D11E}'; // 𝄞 MUSICAL SYMBOL G CLEF — surrogate pair 𝄞
const EXTB = '\u{20000}'; // CJK UNIFIED IDEOGRAPH-20000 (CJK ext-B) — surrogate pair 𠀀
const EMOJI_HIGH_SURROGATE = EMOJI.charAt(0); // lone high surrogate \ud83d — used to split the pair

function assertCodepoints(label: string, s: string, expected: number) {
	const cps = [...s].map((c) => c.codePointAt(0)!);
	deepStrictEqual(
		cps,
		[expected],
		`${label}: expected single codepoint U+${expected.toString(16)}, got ${cps.map((c) => 'U+' + c.toString(16)).join(' ')}`
	);
}
assertCodepoints('EMOJI', EMOJI, 0x1f600);
assertCodepoints('CLEF', CLEF, 0x1d11e);
assertCodepoints('EXTB', EXTB, 0x20000);
strictEqual(EMOJI_HIGH_SURROGATE.charCodeAt(0), 0xd83d, 'EMOJI_HIGH_SURROGATE must be the lone high surrogate 0xd83d');

interface Row {
	id: string;
	name: string;
}
const ROWS: Row[] = [
	{ id: 'ascii', name: 'PFX-alpha' }, // ASCII-only control
	{ id: 'latin', name: 'PFX-élan' }, // accented Latin (BMP) control
	{ id: 'cjkbmp', name: 'PFX-日本' }, // BMP CJK control (日本)
	{ id: 'emoji-imm', name: `PFX-${EMOJI}tail` }, // astral char IMMEDIATELY after prefix (key case)
	{ id: 'emoji-second', name: `PFX-${EMOJI}zzz` }, // 2nd row, same immediate-astral boundary
	{ id: 'clef-imm', name: `PFX-${CLEF}note` }, // astral char IMMEDIATELY after prefix, different char
	{ id: 'extb-imm', name: `PFX-${EXTB}ext` }, // astral CJK ext-B IMMEDIATELY after prefix
	{ id: 'emoji-offset', name: `PFX-x${EMOJI}tail` }, // astral char one BMP char AFTER the boundary
	{ id: 'other', name: 'QFX-unrelated' }, // negative control: different prefix entirely
];
const ALL_IDS_EXCEPT_OTHER = new Set(ROWS.filter((r) => r.id !== 'other').map((r) => r.id));
const IMMEDIATE_ASTRAL_IDS = new Set(['emoji-imm', 'emoji-second', 'clef-imm', 'extb-imm']);
const BMP_CONTROL_IDS = new Set(['ascii', 'latin', 'cjkbmp']);

type Client = ReturnType<typeof createApiClient>;

function idsOf(rows: Array<{ id: string }>): Set<string> {
	return new Set(rows.map((r) => r.id));
}

suite(
	`starts_with on an @indexed string with astral-plane values (#1887) [${ENGINE}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let httpURL: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {},
				env: ENGINE === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {},
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;

			// Readiness poll (eviction-secondary-index.test.ts pattern, ~line 91): the component is
			// pre-installed, so we poll the probe route directly rather than restartHttpWorkers()
			// (which races and flakes against a pre-installed fixture).
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const probe = await client.reqRest(`/${TABLE}/`).timeout(2000);
						if (probe.status !== 404) break;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
			}

			const records = ROWS.map((r) => ({ id: r.id, name: r.name, nameScan: r.name }));
			const r = await client.req().send({ operation: 'insert', schema: SCHEMA, table: TABLE, records }).timeout(30_000);
			strictEqual(r.status, 200, `insert failed status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 500)}`);
			const skipped = (r.body as any)?.skipped_hashes?.length ?? 0;
			strictEqual(skipped, 0, `insert: ${skipped} rows silently skipped`);
			console.log(`\n[astral-startswith ${ENGINE} setup] inserted ${ROWS.length} rows`);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		/** Run a search_by_conditions op and return the matched rows. */
		async function search(conditions: any[]): Promise<Array<{ id: string; name: string }>> {
			const r = await client
				.req()
				.send({
					operation: 'search_by_conditions',
					schema: SCHEMA,
					table: TABLE,
					operator: 'and',
					conditions,
					get_attributes: ['id', 'name', 'nameScan'],
				})
				.timeout(20_000);
			ok(
				r.status === 200,
				`search_by_conditions failed: status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 300)}`
			);
			return r.body as Array<{ id: string; name: string }>;
		}

		/** INDEXED starts_with: sole condition on the @indexed `name` attribute (real index range). */
		function indexStartsWith(prefix: string) {
			return search([{ search_attribute: 'name', search_type: 'starts_with', search_value: prefix }]);
		}

		/** SCAN starts_with: sole condition on the UN-indexed `nameScan` mirror (forced full scan). */
		function scanStartsWith(prefix: string) {
			return search([{ search_attribute: 'nameScan', search_type: 'starts_with', search_value: prefix }]);
		}

		async function rawIndexIds(): Promise<Set<string>> {
			const res = await fetch(`${httpURL}/RawIndex/`, { headers: { Authorization: client.headers.Authorization } });
			strictEqual(res.status, 200, `/RawIndex/ should return 200, got ${res.status}`);
			const entries = (await res.json()) as Array<{ key: string; id: string }>;
			return new Set(entries.map((e) => e.id));
		}

		// ── Sanity: the scan-path oracle itself must find every row for the shared prefix ────────
		test('sanity: scan path (non-indexed nameScan) finds all 8 "PFX-" rows, JS-correct', async () => {
			const scan = await scanStartsWith('PFX-');
			const ids = idsOf(scan);
			console.log(`[astral-startswith ${ENGINE}] scanStartsWith('PFX-') = ${JSON.stringify([...ids])}`);
			deepStrictEqual(ids, ALL_IDS_EXCEPT_OTHER, 'scan path must find every PFX- row including all astral variants');
		});

		// ── Direct index-store read: prove the astral rows are physically indexed ───────────────
		test('index store (direct read): every row, including astral ones, has an index entry', async () => {
			const ids = await rawIndexIds();
			console.log(`[astral-startswith ${ENGINE}] RawIndex ids = ${JSON.stringify([...ids])}`);
			for (const row of ROWS) {
				ok(ids.has(row.id), `expected raw index entry for "${row.id}" (value=${JSON.stringify(row.name)})`);
			}
		});

		// ── (a) prefix ends exactly BEFORE the astral char — THE hypothesized miss ──────────────
		test('(a) starts_with("PFX-"): index vs scan divergence at the astral boundary', async () => {
			const [idx, scan] = await Promise.all([indexStartsWith('PFX-'), scanStartsWith('PFX-')]);
			const idxIds = idsOf(idx);
			const scanIds = idsOf(scan);
			console.log(
				`[astral-startswith ${ENGINE}] (a) indexStartsWith('PFX-') = ${JSON.stringify([...idxIds])}\n` +
					`  scanStartsWith('PFX-')  = ${JSON.stringify([...scanIds])}\n` +
					`  missingFromIndex        = ${JSON.stringify([...scanIds].filter((id) => !idxIds.has(id)))}`
			);
			// Controls: BMP-only rows and the negative-prefix control must agree on both paths.
			for (const id of BMP_CONTROL_IDS) {
				strictEqual(idxIds.has(id), scanIds.has(id), `BMP control "${id}" must agree between index and scan`);
			}
			strictEqual(idxIds.has('other'), false, '"other" (different prefix) must never match');
			strictEqual(scanIds.has('other'), false, '"other" (different prefix) must never match');
			// The offset astral row (one BMP char after the boundary) is NOT immediately adjacent —
			// document whether adjacency specifically matters.
			console.log(
				`[astral-startswith ${ENGINE}] (a) emoji-offset: index=${idxIds.has('emoji-offset')} scan=${scanIds.has('emoji-offset')}`
			);
			// Headline assertion: rows with an astral char immediately after the prefix must agree
			// between index and scan. A divergence here IS the #1629 defect.
			for (const id of IMMEDIATE_ASTRAL_IDS) {
				// Pin the scan side to true as well, so agreement-on-nothing cannot satisfy (a) on its own.
				ok(scanIds.has(id), `scan oracle lost "${id}" — (a) cannot judge the index without it`);
				strictEqual(
					idxIds.has(id),
					scanIds.has(id),
					`#1887 REGRESSION: "${id}" (astral char immediately after "PFX-") — ` +
						`index ${idxIds.has(id) ? 'includes' : 'MISSES'} it, scan ${scanIds.has(id) ? 'includes' : 'misses'} it. ` +
						`indexStartsWith('PFX-')=${JSON.stringify([...idxIds])} scanStartsWith('PFX-')=${JSON.stringify([...scanIds])}`
				);
			}
		});

		// (b) -- the lone-high-surrogate prefix variant is a separate candidate (still diverges after
		// #1887); kept out of this anchor so it can be promoted independently of that fix.

		// ── (c) prefix extends AFTER the astral char — expected-correct control ────────────────
		test('(c) starts_with(prefix including the full astral char): index and scan agree (control)', async () => {
			const prefix = `PFX-${EMOJI}`;
			const [idx, scan] = await Promise.all([indexStartsWith(prefix), scanStartsWith(prefix)]);
			const idxIds = idsOf(idx);
			const scanIds = idsOf(scan);
			console.log(
				`[astral-startswith ${ENGINE}] (c) prefix=${JSON.stringify(prefix)} index=${JSON.stringify([...idxIds])} scan=${JSON.stringify([...scanIds])}`
			);
			deepStrictEqual(
				idxIds,
				new Set(['emoji-imm', 'emoji-second']),
				'index: prefix-including-full-astral-char should correctly match both emoji rows'
			);
			deepStrictEqual(
				scanIds,
				new Set(['emoji-imm', 'emoji-second']),
				'scan: prefix-including-full-astral-char should correctly match both emoji rows'
			);
		});

		// ── (d) equals-lookup on the exact astral value — expected-correct control ─────────────
		test('(d) equals lookup on the exact astral value: index and scan agree (control)', async () => {
			const value = `PFX-${EMOJI}tail`;
			const [idx, scan] = await Promise.all([
				search([{ search_attribute: 'name', search_type: 'equals', search_value: value }]),
				search([{ search_attribute: 'nameScan', search_type: 'equals', search_value: value }]),
			]);
			console.log(
				`[astral-startswith ${ENGINE}] (d) equals(${JSON.stringify(value)}) index=${JSON.stringify(idsOf(idx))} scan=${JSON.stringify(idsOf(scan))}`
			);
			deepStrictEqual(idsOf(idx), new Set(['emoji-imm']), 'index: exact-equals on an astral value must find its row');
			deepStrictEqual(idsOf(scan), new Set(['emoji-imm']), 'scan: exact-equals on an astral value must find its row');
		});

		// ── (e) plain range (no starts_with end-bound synthesis) spanning all PFX- rows ────────
		test('(e) range ge("PFX-") and lt("QFX-"): index and scan both include every astral row (control)', async () => {
			const conditions = [
				{ search_attribute: 'name', search_type: 'greater_than_equal', search_value: 'PFX-' },
				{ search_attribute: 'name', search_type: 'less_than', search_value: 'QFX-' },
			];
			const scanConditions = conditions.map((c) => ({ ...c, search_attribute: 'nameScan' }));
			const [idx, scan] = await Promise.all([search(conditions), search(scanConditions)]);
			const idxIds = idsOf(idx);
			const scanIds = idsOf(scan);
			console.log(
				`[astral-startswith ${ENGINE}] (e) range index=${JSON.stringify([...idxIds])} scan=${JSON.stringify([...scanIds])}`
			);
			deepStrictEqual(
				idxIds,
				ALL_IDS_EXCEPT_OTHER,
				'index: plain ge/lt range (no +U+FFFF synthesis) must include every PFX- row, astral included'
			);
			deepStrictEqual(
				scanIds,
				ALL_IDS_EXCEPT_OTHER,
				'scan: plain ge/lt range must include every PFX- row, astral included'
			);
		});
	}
);
