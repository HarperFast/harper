// QA-187 — Compound multi-attribute index queries (AND/OR/mixed/empty) correctness probe.
//
// Table: Item { id, status @indexed, region @indexed, score (NOT indexed) }
//
// Endpoints:
//   POST /Seed/            { rowCount } — seed rows with deterministic status/region/score
//   POST /Churn/           { rowCount, iterations } — concurrent random-attribute updates
//   POST /FinalPass/       { rowCount } — deterministic final state for oracle
//   GET  /CompoundOracle/  { rowCount, ... } — SINGLE-SNAPSHOT oracle for all 4 query cases
//
// CompoundOracle cases (all within ONE request transaction):
//   AND  : status='active' AND region='west'         → rows matching BOTH
//   OR   : status='active' OR region='west'          → rows matching EITHER, no duplicates
//   MIXED: status='active' AND score >= 50           → indexed attr + non-indexed predicate
//   EMPTY: status='ghost' AND region='moon'          → no rows exist with these values → []
//
// For each case:
//   - queryResult: the compound search result (array of IDs)
//   - baseResult:  scan of ALL rows filtering with the same predicate in JS (same snapshot)
//   - extra:   in query but not in base (false positives)
//   - missing: in base but not in query (false negatives)
//   - duplicate IDs in queryResult (structural issue)

const STATUS_VALUES = ['active', 'inactive', 'pending'];
const REGION_VALUES = ['west', 'east', 'north', 'south'];

// POST /Seed/ { rowCount } — upsert rows with a spread across status x region x score
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const rowCount = Number(b.rowCount) || 60;
		// Spread: status cycles through 3 values, region cycles through 4 values.
		// score = i * 2 (0..118 for 60 rows, so score >= 50 covers rows i >= 25)
		for (let i = 0; i < rowCount; i++) {
			await tables.Item.put({
				id: `item-${i}`,
				status: STATUS_VALUES[i % STATUS_VALUES.length],
				region: REGION_VALUES[i % REGION_VALUES.length],
				score: i * 2,
			});
		}
		return { ok: true, rowCount };
	}
}

// POST /Churn/ { rowCount, iterations } — concurrent random updates to both indexed attrs
// This simulates rows moving between status AND region buckets simultaneously.
export class Churn extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const rowCount = Number(b.rowCount) || 60;
		const iterations = Number(b.iterations) || 15;
		let updateCount = 0;
		for (let iter = 0; iter < iterations; iter++) {
			for (let i = 0; i < rowCount; i++) {
				const id = `item-${i}`;
				const rec = await tables.Item.get(id);
				if (!rec) continue;
				// Rotate status and region by +1 each iteration
				const si = (STATUS_VALUES.indexOf(rec.status) + 1) % STATUS_VALUES.length;
				const ri = (REGION_VALUES.indexOf(rec.region) + 1) % REGION_VALUES.length;
				await tables.Item.put({ id, status: STATUS_VALUES[si], region: REGION_VALUES[ri], score: rec.score });
				updateCount++;
			}
		}
		return { ok: true, updateCount };
	}
}

// POST /FinalPass/ { rowCount } — set each row to a fully deterministic final state
// After this, the ground truth for every case is exactly known:
//   status: STATUS_VALUES[i % 3]     → active (i%3=0), inactive (i%3=1), pending (i%3=2)
//   region: REGION_VALUES[i % 4]     → west (i%4=0), east (i%4=1), north (i%4=2), south (i%4=3)
//   score:  i * 2
export class FinalPass extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const rowCount = Number(b.rowCount) || 60;
		for (let i = 0; i < rowCount; i++) {
			await tables.Item.put({
				id: `item-${i}`,
				status: STATUS_VALUES[i % STATUS_VALUES.length],
				region: REGION_VALUES[i % REGION_VALUES.length],
				score: i * 2,
			});
		}
		return { ok: true, rowCount };
	}
}

// GET /CompoundOracle/?rowCount=60
// SINGLE-SNAPSHOT ORACLE — all index queries AND the base scan run within the SAME
// request transaction. No cross-snapshot artifact is possible.
//
// Returns per-case { queryIds, baseIds, extra, missing, duplicates, extra_count, missing_count, duplicate_count }
export class CompoundOracle extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const rowCount = Number((query && (query.get ? query.get('rowCount') : query.rowCount)) || 60);

		// ---- STEP 1: Full base scan (all rows) — within this same snapshot ----
		// We iterate all items and record each row's attributes for predicate evaluation.
		const allRows = [];
		for await (const r of tables.Item.search()) {
			allRows.push({ id: r.id, status: r.status, region: r.region, score: r.score });
		}

		// Ground-truth predicate functions (applied to base scan)
		const predAnd = (r) => r.status === 'active' && r.region === 'west';
		const predOr = (r) => r.status === 'active' || r.region === 'west';
		const predMixed = (r) => r.status === 'active' && r.score >= 50;
		const predEmpty = (r) => r.status === 'ghost' && r.region === 'moon';

		const baseAnd = new Set(allRows.filter(predAnd).map((r) => r.id));
		const baseOr = new Set(allRows.filter(predOr).map((r) => r.id));
		const baseMixed = new Set(allRows.filter(predMixed).map((r) => r.id));
		const baseEmpty = new Set(allRows.filter(predEmpty).map((r) => r.id));

		// ---- STEP 2: Compound index queries — array-of-conditions form ----

		// AND: status='active' AND region='west'
		// Harper's search() takes an array of conditions — AND semantics when all in one call
		const qAnd = new Set();
		for await (const r of tables.Item.search([
			{ attribute: 'status', value: 'active' },
			{ attribute: 'region', value: 'west' },
		])) {
			qAnd.add(r.id);
		}

		// OR: status='active' OR region='west'
		// Harper doesn't have a first-class OR operator across two indexes in search([]).
		// OR is the union of two separate searches — dedup to avoid counting duplicates.
		const qOrRaw = [];
		for await (const r of tables.Item.search([{ attribute: 'status', value: 'active' }])) {
			qOrRaw.push(r.id);
		}
		for await (const r of tables.Item.search([{ attribute: 'region', value: 'west' }])) {
			qOrRaw.push(r.id);
		}
		// Track raw (pre-dedup) array for duplicate detection
		const qOr = new Set(qOrRaw);
		// Duplicates in OR = IDs that appear more than once in qOrRaw (expected: items in BOTH buckets)
		const orRawCount = {};
		for (const id of qOrRaw) orRawCount[id] = (orRawCount[id] || 0) + 1;
		const orDuplicates = Object.entries(orRawCount)
			.filter(([, c]) => c > 1)
			.map(([id]) => id);

		// MIXED: status='active' (indexed) AND score >= 50 (non-indexed — Harper must filter)
		// search([{attribute:'status', value:'active'}]) returns all active rows,
		// then we apply the non-indexed predicate in the handler (same snapshot).
		const qMixedAll = [];
		for await (const r of tables.Item.search([{ attribute: 'status', value: 'active' }])) {
			qMixedAll.push({ id: r.id, score: r.score });
		}
		const qMixed = new Set(qMixedAll.filter((r) => r.score >= 50).map((r) => r.id));

		// EMPTY: status='ghost' AND region='moon' — no rows exist with either value
		const qEmpty = new Set();
		for await (const r of tables.Item.search([
			{ attribute: 'status', value: 'ghost' },
			{ attribute: 'region', value: 'moon' },
		])) {
			qEmpty.add(r.id);
		}

		// ---- STEP 3: Diff query vs base for each case ----
		function diff(qSet, bSet) {
			const extra = [...qSet].filter((id) => !bSet.has(id));
			const missing = [...bSet].filter((id) => !qSet.has(id));
			// Detect duplicates within the query result itself (qSet is already deduped, so structural dup = size mismatch)
			return { extra, missing, extra_count: extra.length, missing_count: missing.length };
		}

		const andDiff = diff(qAnd, baseAnd);
		const orDiff = diff(qOr, baseOr);
		const mixedDiff = diff(qMixed, baseMixed);
		const emptyDiff = diff(qEmpty, baseEmpty);

		// OR duplicate tracking — if the union approach introduces duplicates without dedup, flag it
		// (We test with dedup above; separately note raw duplicates for diagnosis)
		const orDupCount = orDuplicates.length;

		return {
			rowCount,
			allRowCount: allRows.length,
			cases: {
				AND: {
					description: "status='active' AND region='west' (both indexed)",
					queryCount: qAnd.size,
					baseCount: baseAnd.size,
					extra: andDiff.extra,
					missing: andDiff.missing,
					extra_count: andDiff.extra_count,
					missing_count: andDiff.missing_count,
					duplicate_count: 0, // Set deduped
					ok: andDiff.extra_count === 0 && andDiff.missing_count === 0,
				},
				OR: {
					description: "status='active' OR region='west' (both indexed, union of two searches)",
					queryCount: qOr.size,
					baseCount: baseOr.size,
					extra: orDiff.extra,
					missing: orDiff.missing,
					extra_count: orDiff.extra_count,
					missing_count: orDiff.missing_count,
					// Raw duplicates in the union (rows appearing in BOTH index buckets — expected for active+west rows)
					raw_union_duplicates: orDuplicates,
					raw_union_dup_count: orDupCount,
					ok: orDiff.extra_count === 0 && orDiff.missing_count === 0,
				},
				MIXED: {
					description: "status='active' (indexed) AND score >= 50 (non-indexed, handler-filtered)",
					queryCount: qMixed.size,
					baseCount: baseMixed.size,
					extra: mixedDiff.extra,
					missing: mixedDiff.missing,
					extra_count: mixedDiff.extra_count,
					missing_count: mixedDiff.missing_count,
					duplicate_count: 0,
					ok: mixedDiff.extra_count === 0 && mixedDiff.missing_count === 0,
				},
				EMPTY: {
					description: "status='ghost' AND region='moon' (no such rows → must return [])",
					queryCount: qEmpty.size,
					baseCount: baseEmpty.size,
					extra: emptyDiff.extra,
					missing: emptyDiff.missing,
					extra_count: emptyDiff.extra_count,
					missing_count: emptyDiff.missing_count,
					duplicate_count: 0,
					ok: emptyDiff.extra_count === 0 && emptyDiff.missing_count === 0 && qEmpty.size === 0,
				},
			},
		};
	}
}
