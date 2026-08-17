/**
 * QA-714 — regression anchor for harper#1572 / PR #1911 ("fix(query): stop query planning
 * from mutating the caller's conditions"), plus a probe of the adjacent corners the shipped
 * unit test (unitTests/resources/conditionsArrayMutation.test.js) likely doesn't cover:
 * NESTED `operator:'and'|'or'` sub-condition arrays, pagination sweeps, three distinct sort
 * planner paths (secondary-indexed-matching-a-top-level-condition / secondary-indexed-nested-
 * only / primary-key / non-indexed-postOrdering), array-form targets & array-form condition
 * entries, and TRUE concurrent reuse of one shared conditions object.
 *
 * Core question: a caller-owned query object (its `conditions` array AND any nested
 * `operator:'and'|'or'` sub-arrays) must come back from a query byte-identical to what the
 * caller passed in (including recursive server-side value types), and remain safely reusable
 * for a 2nd/3rd/concurrent query.
 *
 * App under test (integrationTests/database/condition-mutation-integrity/): a product-catalog
 * service (`resources.js`) that builds ONE `conditions` array once at module scope --
 * `[{category='electronics'}, {or: [{price<500}, {createdAt>2024-01-01}]}]` -- and reuses it
 * across a paginated sweep, a count, a live-refresh loop, and a burst of concurrent queries.
 * Since Harper runs as a separate process from this test, and JS object identity can't cross
 * the HTTP boundary, the oracle is: capture a PRISTINE snapshot of the held object from the
 * server BEFORE any query runs, then after every query re-fetch the object's current JSON
 * state and assert.deepStrictEqual it against the pristine copy. Section Q0c proves this
 * oracle is not blind (it can detect an actual mutation) before we trust its silence.
 *
 * threads.count:1 is pinned in the Harper config so the held module-level arrays are
 * genuinely the SAME JS reference across every request in the suite -- multi-threaded Harper
 * gives each worker its own module instance, which would make cross-request aliasing (and the
 * concurrency probe in particular) untestable.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/condition-mutation-integrity.test.ts"
 * Harper SHA: b8c843a24 (main, includes PR #1911)
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual, throws } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	DEFAULT_ADMIN_USERNAME,
	DEFAULT_ADMIN_PASSWORD,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'condition-mutation-integrity');
const SCHEMA = 'data';
const AUTH = 'Basic ' + Buffer.from(`${DEFAULT_ADMIN_USERNAME}:${DEFAULT_ADMIN_PASSWORD}`).toString('base64');
const PRODUCT_COUNT = 90;
const CATEGORIES = ['electronics', 'home', 'garden'];

// ---------- Independent ground truth (mirrors resources.js Seed exactly) -------------------
function seedRow(i: number) {
	return {
		id: `p-${String(i).padStart(4, '0')}`,
		category: CATEGORIES[i % CATEGORIES.length],
		price: 100 + ((i * 37) % 900),
		createdAt: new Date(Date.UTC(2023, 0, 1) + i * 20 * 24 * 3600 * 1000),
		rank: PRODUCT_COUNT - i,
	};
}
// electronics AND (price<500 OR createdAt>2024-01-01)
const CUTOVER = new Date('2024-01-01T00:00:00.000Z').getTime();
function expectedIds(): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i < PRODUCT_COUNT; i++) {
		const r = seedRow(i);
		if (r.category === 'electronics' && (r.price < 500 || r.createdAt.getTime() > CUTOVER)) out.add(r.id);
	}
	return out;
}
const EXPECTED_IDS = expectedIds();
// electronics-only (for the array-form probe: [['category','electronics']])
const EXPECTED_ELECTRONICS_IDS = new Set(
	Array.from({ length: PRODUCT_COUNT }, (_, i) => seedRow(i))
		.filter((r) => r.category === 'electronics')
		.map((r) => r.id)
);

suite('QA-714 conditions array mutation regression anchor (harper#1572 / PR #1911)', (ctx: ContextWithHarper) => {
	let httpURL: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 1 },
				logging: { console: true, level: 'error' },
			},
			env: {},
		});
		httpURL = (ctx.harper as any).httpURL;

		// Poll the probe route directly until it stops returning 404 (component is
		// pre-installed; no restartHttpWorkers() -- that races and flakes on CI here).
		const deadline = Date.now() + 120_000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${httpURL}/Product/`, { headers: { Authorization: AUTH } });
				if (res.status !== 404) {
					ready = true;
					break;
				}
			} catch {
				/* not ready yet */
			}
			await sleep(250);
		}
		ok(ready, 'Product route did not become ready within 120 seconds');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ---------- HTTP helpers ------------------------------------------------------------
	async function getJSON(path: string): Promise<any> {
		const res = await fetch(`${httpURL}${path}`, { headers: { Authorization: AUTH } });
		strictEqual(res.status, 200, `GET ${path} should return 200`);
		return res.json();
	}
	async function postJSON(path: string, body: unknown): Promise<any> {
		const res = await fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': AUTH },
			body: JSON.stringify(body),
		});
		strictEqual(res.status, 200, `POST ${path} should return 200`);
		return res.json();
	}
	function snapshot(which: 'live' | 'concurrent' | 'arrayForm'): Promise<any> {
		return getJSON(`/Snapshot/?which=${which}`);
	}
	function idsSorted(ids: string[]): string[] {
		return [...ids].sort();
	}

	let pristineLive: any;
	let pristineConcurrent: any;
	let pristineArrayForm: any;

	// ==========================================================================================
	// Q0 — setup, oracle self-check, seed
	// ==========================================================================================
	test('Q0a reset + capture pristine snapshots of all three held objects', async () => {
		const r = await postJSON('/Reset/', {});
		ok(r.ok, 'Reset should succeed');
		pristineLive = await snapshot('live');
		pristineConcurrent = await snapshot('concurrent');
		pristineArrayForm = await snapshot('arrayForm');

		// Shape sanity: top-level array of 2, entry[1] is the nested `or` group of 2.
		strictEqual(pristineLive.conditions.length, 2, 'pristine live conditions should have 2 top-level entries');
		strictEqual(pristineLive.conditions[1].operator, 'or', 'entry[1] should be the nested or-group');
		strictEqual(pristineLive.conditions[1].conditions.length, 2, 'nested or-group should have 2 sub-conditions');
		strictEqual(pristineArrayForm.conditions.length, 1, 'pristine array-form conditions should have 1 tuple entry');
		deepStrictEqual(
			pristineArrayForm.conditions[0],
			['category', 'electronics'],
			'array-form tuple should be [attr, value]'
		);
		strictEqual(
			pristineLive.types[1].conditions[1].value,
			'string',
			'createdAt condition must begin as a server-side string'
		);
	});

	test('Q0b ORACLE SELF-CHECK: deepStrictEqual must actually fire on a real mutation', () => {
		// Prove the assertion we rely on everywhere below is not vacuously true. Take a
		// structuredClone of pristine, inflict the EXACT two classes of mutation the original
		// bug produced (a leaked top-level sort pseudo-condition, and a coerced/annotated
		// value inside the NESTED or-group), and confirm deepStrictEqual throws on each.
		const leakedPseudoCondition = structuredClone(pristineLive);
		leakedPseudoCondition.conditions.push({ attribute: 'category', comparator: 'sort', descending: true });
		throws(
			() => deepStrictEqual(leakedPseudoCondition, pristineLive),
			/Expected values to be strictly deep-equal/,
			'oracle failed to detect a leaked top-level sort pseudo-condition'
		);

		const mutatedNested = structuredClone(pristineLive);
		mutatedNested.conditions[1].conditions[0].estimated_count = 42; // simulates a leaked cache annotation
		throws(
			() => deepStrictEqual(mutatedNested, pristineLive),
			/Expected values to be strictly deep-equal/,
			'oracle failed to detect a mutation inside the NESTED or-group'
		);

		const mutatedNestedValue = structuredClone(pristineLive);
		mutatedNestedValue.conditions[1].conditions[1].value = '1999-01-01T00:00:00.000Z'; // simulates in-place coercion
		throws(
			() => deepStrictEqual(mutatedNestedValue, pristineLive),
			/Expected values to be strictly deep-equal/,
			'oracle failed to detect a coerced value inside the NESTED or-group'
		);

		const mutatedNestedType = structuredClone(pristineLive);
		mutatedNestedType.types[1].conditions[1].value = 'Date';
		throws(
			() => deepStrictEqual(mutatedNestedType, pristineLive),
			/Expected values to be strictly deep-equal/,
			'oracle failed to detect a server-side string-to-Date coercion'
		);

		// And confirm it does NOT fire on a genuinely identical (but distinct-object) copy.
		deepStrictEqual(structuredClone(pristineLive), pristineLive, 'oracle false-positived on an untouched clone');
	});

	test('Q0c seed 90 deterministic product rows', async () => {
		const r = await postJSON('/Seed/', { count: PRODUCT_COUNT });
		ok(r.ok, 'Seed should succeed');
		strictEqual(r.count, PRODUCT_COUNT);
		console.log(`[QA-714 Q0c] seeded ${PRODUCT_COUNT} rows; expected compound-match count=${EXPECTED_IDS.size}`);
	});

	// ==========================================================================================
	// Q1 — sequential reuse (3x), sort by an attribute that MATCHES an EXISTING top-level
	// condition (category): planner aligns in place via `orderAlignedCondition.descending = ...`
	// on the matched TOP-level entry. This is the single most direct path to the original bug.
	// ==========================================================================================
	test('Q1 reuse liveConditions 3x with sort=category (top-level-aligned path)', async () => {
		for (let i = 1; i <= 3; i++) {
			const r = await getJSON('/RunOnce/?sortAttr=category&desc=true');
			deepStrictEqual(idsSorted(r.ids), idsSorted([...EXPECTED_IDS]), `run ${i}: wrong result set`);
			deepStrictEqual(r.conditionsAfter, pristineLive, `run ${i}: liveConditions mutated (top-level-aligned sort)`);
		}
	});

	// ==========================================================================================
	// Q2 — paginated sweep + reuse: page through results with limit/offset while sorted, using
	// the SAME shared object for every page (the realistic "sweep" workload from the brief).
	// ==========================================================================================
	test('Q2 paginated sweep (limit/offset) reusing liveConditions across pages', async () => {
		const pageSize = 4;
		const seen = new Set<string>();
		for (let offset = 0; offset < EXPECTED_IDS.size + pageSize; offset += pageSize) {
			const r = await getJSON(`/RunOnce/?sortAttr=category&limit=${pageSize}&offset=${offset}`);
			for (const id of r.ids) {
				ok(!seen.has(id), `page at offset=${offset} re-returned id ${id} (torn/duplicated page)`);
				seen.add(id);
			}
			deepStrictEqual(r.conditionsAfter, pristineLive, `offset=${offset}: liveConditions mutated mid-sweep`);
			if (r.ids.length === 0) break;
		}
		deepStrictEqual(seen, EXPECTED_IDS, 'paginated sweep did not cover exactly the expected id set');
	});

	// ==========================================================================================
	// Q3 — NESTED-ONLY indexed sort attributes (price, createdAt): both live ONLY inside the
	// nested `or` group, not at the top level, so `conditions.find` at the top level can't align
	// them -> planner pushes a NEW top-level `{comparator:'sort'}` pseudo-condition instead. This
	// is the highest-value probe: does the pseudo-condition (or any other annotation) leak onto
	// the caller's TOP-level array, and does the untouched NESTED array stay byte-identical?
	// ==========================================================================================
	test('Q3 sort by price (indexed, nested-only) x2 -- top array must not grow, nested must not change', async () => {
		for (let i = 1; i <= 2; i++) {
			const r = await getJSON('/RunOnce/?sortAttr=price');
			deepStrictEqual(idsSorted(r.ids), idsSorted([...EXPECTED_IDS]), `run ${i}: wrong result set`);
			strictEqual(
				r.conditionsAfter.conditions.length,
				2,
				`run ${i}: top-level conditions array grew (leaked pseudo-condition)`
			);
			deepStrictEqual(r.conditionsAfter, pristineLive, `run ${i}: liveConditions mutated (nested-only indexed sort)`);
		}
	});

	test('Q3b sort by createdAt (Date-typed, indexed, nested-only) x2 -- coercion must not leak', async () => {
		for (let i = 1; i <= 2; i++) {
			const r = await getJSON('/RunOnce/?sortAttr=createdAt&desc=true');
			deepStrictEqual(idsSorted(r.ids), idsSorted([...EXPECTED_IDS]), `run ${i}: wrong result set`);
			strictEqual(
				r.conditionsAfter.conditions.length,
				2,
				`run ${i}: top-level conditions array grew (leaked pseudo-condition)`
			);
			// The nested Date condition's value must still be the ORIGINAL ISO string, not
			// coerced to a Date in place (harper#1572's exact failure mode, relocated to a
			// nested sub-array where the shipped unit test never looked).
			strictEqual(
				r.conditionsAfter.conditions[1].conditions[1].value,
				'2024-01-01T00:00:00.000Z',
				`run ${i}: nested Date condition value was coerced in place`
			);
			deepStrictEqual(r.conditionsAfter, pristineLive, `run ${i}: liveConditions mutated (nested Date sort+coercion)`);
		}
	});

	// ==========================================================================================
	// Q4 — primary-key sort path (attribute.isPrimaryKey branch) and non-indexed postOrdering
	// path (rank) -- two more distinct planner branches, reusing the same array.
	// ==========================================================================================
	test('Q4a sort by id (primary key path) x2', async () => {
		for (let i = 1; i <= 2; i++) {
			const r = await getJSON('/RunOnce/?sortAttr=id');
			deepStrictEqual(idsSorted(r.ids), idsSorted([...EXPECTED_IDS]), `run ${i}: wrong result set`);
			deepStrictEqual(r.conditionsAfter, pristineLive, `run ${i}: liveConditions mutated (primary-key sort)`);
		}
	});

	test('Q4b sort by rank (non-indexed, postOrdering path) x2 -- correctness + no mutation', async () => {
		for (let i = 1; i <= 2; i++) {
			const r = await getJSON('/RunOnce/?sortAttr=rank');
			deepStrictEqual(idsSorted(r.ids), idsSorted([...EXPECTED_IDS]), `run ${i}: wrong result set`);
			// rank = PRODUCT_COUNT - i, so ascending rank = descending seed-index; just confirm monotonic.
			const ranks = r.ids.map((id: string) => PRODUCT_COUNT - Number(id.slice(2)));
			const sortedRanks = [...ranks].sort((a, b) => a - b);
			deepStrictEqual(ranks, sortedRanks, `run ${i}: rank sort order incorrect`);
			deepStrictEqual(
				r.conditionsAfter,
				pristineLive,
				`run ${i}: liveConditions mutated (non-indexed postOrdering sort)`
			);
		}
	});

	// ==========================================================================================
	// Q5 — select projection combined with sort, reusing the same array again.
	// ==========================================================================================
	test('Q5 select+sort reuse does not mutate liveConditions', async () => {
		const r = await getJSON('/RunOnce/?sortAttr=category&select=id,price');
		deepStrictEqual(idsSorted(r.ids), idsSorted([...EXPECTED_IDS]), 'wrong result set with select');
		deepStrictEqual(r.conditionsAfter, pristineLive, 'liveConditions mutated (select+sort)');
	});

	// ==========================================================================================
	// Q6 — count query (the "count" leg of the sweep+count+refresh workload) + one more bare
	// reuse, confirming the FULL gauntlet above left the object pristine for a plain caller.
	// ==========================================================================================
	test('Q6 count query + final bare reuse of liveConditions', async () => {
		const c = await getJSON('/Count/');
		strictEqual(c.count, EXPECTED_IDS.size, 'count query wrong total');
		deepStrictEqual(c.conditionsAfter, pristineLive, 'liveConditions mutated by count query');

		const r = await getJSON('/RunOnce/');
		deepStrictEqual(idsSorted(r.ids), idsSorted([...EXPECTED_IDS]), 'final bare reuse wrong result set');
		deepStrictEqual(r.conditionsAfter, pristineLive, 'liveConditions mutated by final bare reuse');
	});

	// ==========================================================================================
	// Q7 — array-form TARGET (search(array) instead of search({conditions:array})) built from an
	// array-form CONDITION ENTRY (`[attribute, value]` tuple) -- the OTHER clone branch in
	// cloneConditions (Object.assign(condition.slice(), condition)).
	// ==========================================================================================
	test('Q7 array-form target + array-form condition entry, reused 3x (bare, bare, sorted)', async () => {
		for (const qs of ['', '', '?sortAttr=category']) {
			const r = await getJSON(`/RunArrayForm/${qs}`);
			deepStrictEqual(
				idsSorted(r.ids),
				idsSorted([...EXPECTED_ELECTRONICS_IDS]),
				`arrayForm '${qs}': wrong result set`
			);
			deepStrictEqual(r.conditionsAfter, pristineArrayForm, `arrayForm '${qs}': arrayFormConditions mutated`);
			strictEqual(r.conditionsAfter.conditions.length, 1, `arrayForm '${qs}': tuple array grew`);
			ok(Array.isArray(r.conditionsAfter.conditions[0]), `arrayForm '${qs}': tuple entry lost its array-ness`);
		}
	});

	// ==========================================================================================
	// Q8 — TRUE concurrency: N parallel queries (Promise.all, single worker thread) sharing ONE
	// conditions object. Any cross-talk would show up as divergent id sets/order across runs, a
	// thrown coercion error, or a post-burst mutation of concurrentConditions.
	// ==========================================================================================
	test('Q8 N=12 concurrent queries sharing concurrentConditions (sorted desc)', async () => {
		const r = await getJSON('/RunConcurrent/?n=12&sortAttr=category&desc=true');
		strictEqual(r.runs.length, 12);
		const first = r.runs[0];
		for (let i = 1; i < r.runs.length; i++) {
			deepStrictEqual(r.runs[i], first, `concurrent run ${i} diverged from run 0 (cross-talk)`);
		}
		deepStrictEqual(idsSorted(first), idsSorted([...EXPECTED_IDS]), 'concurrent runs returned wrong result set');
		deepStrictEqual(r.conditionsAfter, pristineConcurrent, 'concurrentConditions mutated by the concurrent burst');
	});

	test('Q8b concurrentConditions still reusable unsorted after the concurrent burst', async () => {
		const r = await getJSON('/RunConcurrent/?n=3');
		deepStrictEqual(idsSorted(r.runs[0]), idsSorted([...EXPECTED_IDS]), 'post-burst unsorted reuse wrong result set');
		deepStrictEqual(r.conditionsAfter, pristineConcurrent, 'concurrentConditions mutated after post-burst reuse');
	});

	// ==========================================================================================
	// Q9 — surface coverage: REST query params and the ops API (search_by_conditions). These
	// build a FRESH condition object graph per HTTP request (JSON parse) so they cannot exhibit
	// the caller-reuse defect themselves -- this is a sanity/no-crash check on other entry
	// points, not an additional mutation oracle.
	// ==========================================================================================
	test('Q9a REST query params: sort+limit over the automatic API', async () => {
		const res = await fetch(`${httpURL}/Product/?category=electronics&sort(+price)&limit(5)`, {
			headers: { Authorization: AUTH },
		});
		strictEqual(res.status, 200, `REST sort+limit should return 200, got ${res.status}`);
		const rows = (await res.json()) as any[];
		ok(Array.isArray(rows), 'REST sort+limit should return an array');
		strictEqual(rows.length, 5, 'REST sort+limit should return exactly five rows');
		ok(
			rows.every((r) => r.category === 'electronics'),
			'REST sort+limit returned a non-electronics row'
		);
	});

	test('Q9b ops API search_by_conditions with nested or-group, run twice', async () => {
		for (let i = 1; i <= 2; i++) {
			const res = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				schema: SCHEMA,
				table: 'Product',
				operator: 'and',
				conditions: [
					{ search_attribute: 'category', search_type: 'equals', search_value: 'electronics' },
					{
						operator: 'or',
						conditions: [
							{ search_attribute: 'price', search_type: 'less_than', search_value: 500 },
							{ search_attribute: 'createdAt', search_type: 'greater_than', search_value: '2024-01-01T00:00:00.000Z' },
						],
					},
				],
				get_attributes: ['id'],
			});
			const rows: any[] = Array.isArray(res) ? res : [];
			deepStrictEqual(
				idsSorted(rows.map((r) => r.id)),
				idsSorted([...EXPECTED_IDS]),
				`ops search_by_conditions run ${i} wrong result set`
			);
		}
	});

	// ==========================================================================================
	// Q10 — final overall re-verification across all three held objects, single clear verdict.
	// ==========================================================================================
	test('Q10 final verdict: all three held objects still byte-identical to pristine', async () => {
		const finalLive = await snapshot('live');
		const finalConcurrent = await snapshot('concurrent');
		const finalArrayForm = await snapshot('arrayForm');
		const liveOk = JSON.stringify(finalLive) === JSON.stringify(pristineLive);
		const concurrentOk = JSON.stringify(finalConcurrent) === JSON.stringify(pristineConcurrent);
		const arrayFormOk = JSON.stringify(finalArrayForm) === JSON.stringify(pristineArrayForm);
		console.log(
			`\n[QA-714 Q10] liveConditions pristine=${liveOk} concurrentConditions pristine=${concurrentOk} ` +
				`arrayFormConditions pristine=${arrayFormOk}\n` +
				`  >>> ${
					liveOk && concurrentOk && arrayFormOk
						? 'FIX HOLDS -- caller conditions (incl. nested or-group) survive reuse, pagination, and concurrency (green regression anchor)'
						: 'DEFECT -- a held conditions object was mutated by query planning; see per-section assertions above for exactly which one'
				}`
		);
		deepStrictEqual(finalLive, pristineLive, 'FINAL: liveConditions not pristine');
		deepStrictEqual(finalConcurrent, pristineConcurrent, 'FINAL: concurrentConditions not pristine');
		deepStrictEqual(finalArrayForm, pristineArrayForm, 'FINAL: arrayFormConditions not pristine');
	});
});
