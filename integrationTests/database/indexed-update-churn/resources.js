// QA-186 — Secondary-index consistency under concurrent in-place UPDATE churn.
//
// The core question: after heavy concurrent updates to an @indexed attribute,
// does search([{attribute:'status', value:X}]) always return EXACTLY the rows
// currently at value X?
//
// Endpoints:
//   POST /Seed/        { rowCount } — seed rowCount rows with round-robin status
//   POST /Churn/       { rowCount, iterations } — rotate status sequentially
//   GET  /Reconcile/   { rowCount } — SINGLE-SNAPSHOT ORACLE
//
// The reconcile oracle (GET /Reconcile/?rowCount=50) is the decisive endpoint:
// within ONE request handler (= one request transaction), for each status value in
// ['pending','active','done'], it:
//   1. Calls tables.StatusRecord.search([{attribute:'status', value:X}]) — indexed scan
//   2. For each hit, calls tables.StatusRecord.get(id) — PK lookup (SAME snapshot)
//   3. Checks for STALE: index returned id but actual status !== X
//   4. Checks for DOUBLE: id appears in more than one status bucket's index results
//   5. Checks for MISSING: iterates all rowCount IDs and verifies each appears in index
// Returns: { stale, double, missing, stale_count, double_count, missing_count }

const STATUS_VALUES = ['pending', 'active', 'done'];

// POST /Seed/ { rowCount } — upsert rowCount rows with round-robin status
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const rowCount = Number(b.rowCount) || 50;
		for (let i = 0; i < rowCount; i++) {
			const status = STATUS_VALUES[i % STATUS_VALUES.length];
			await tables.StatusRecord.put({ id: `row-${i}`, status, label: `label-${i}` });
		}
		return { ok: true, rowCount };
	}
}

// POST /Churn/ { rowCount, iterations } — rotate status through cycle sequentially
export class Churn extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const rowCount = Number(b.rowCount) || 50;
		const iterations = Number(b.iterations) || 20;
		let updateCount = 0;
		for (let iter = 0; iter < iterations; iter++) {
			for (let i = 0; i < rowCount; i++) {
				const id = `row-${i}`;
				const rec = await tables.StatusRecord.get(id);
				if (!rec) continue;
				const currentIdx = STATUS_VALUES.indexOf(rec.status);
				const nextIdx = (currentIdx >= 0 ? currentIdx + 1 : 0) % STATUS_VALUES.length;
				await tables.StatusRecord.put({ id, status: STATUS_VALUES[nextIdx], label: rec.label });
				updateCount++;
			}
		}
		return { ok: true, updateCount };
	}
}

// POST /FinalPass/ { rowCount } — set each row to deterministic status (row-N → N%3)
export class FinalPass extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const rowCount = Number(b.rowCount) || 50;
		for (let i = 0; i < rowCount; i++) {
			const status = STATUS_VALUES[i % STATUS_VALUES.length];
			await tables.StatusRecord.put({ id: `row-${i}`, status, label: `label-${i}-final` });
		}
		return { ok: true, rowCount };
	}
}

// GET /Reconcile/?rowCount=50 — SINGLE-SNAPSHOT ORACLE (decisive)
//
// Runs entirely within ONE request handler (= one read transaction snapshot):
//   1. For each status value, indexed scan via tables.StatusRecord.search([{attribute:'status', value:X}])
//   2. For each indexed ID, PK-get to check actual status (SAME snapshot)
//   3. STALE: indexed under X but actual status !== X
//   4. DOUBLE: appears in index results for more than one status value
//   5. MISSING: has actual status X but does NOT appear in index results for X
//
// All reads happen within the same request transaction — no cross-snapshot artifact possible.
export class Reconcile extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const rowCount = Number((query && (query.get ? query.get('rowCount') : query.rowCount)) || 50);

		// Step 1: collect index results for each status value within this snapshot
		const indexByStatus = { pending: new Set(), active: new Set(), done: new Set() };
		for (const sv of STATUS_VALUES) {
			for await (const r of tables.StatusRecord.search([{ attribute: 'status', value: sv }])) {
				indexByStatus[sv].add(r.id);
			}
		}

		// Step 2: collect per-ID indexed-status list (for DOUBLE detection)
		const idToIndexedStatuses = {};
		for (const sv of STATUS_VALUES) {
			for (const id of indexByStatus[sv]) {
				if (!idToIndexedStatuses[id]) idToIndexedStatuses[id] = [];
				idToIndexedStatuses[id].push(sv);
			}
		}

		// Step 3: for each indexed ID, PK-get to check actual status (same snapshot)
		const stale = [];
		const double = [];
		const actualStatusById = {};

		for (const sv of STATUS_VALUES) {
			for (const id of indexByStatus[sv]) {
				if (!(id in actualStatusById)) {
					const rec = await tables.StatusRecord.get(id);
					actualStatusById[id] = rec ? rec.status : null;
				}
				const actual = actualStatusById[id];
				if (actual !== sv) {
					stale.push({ id, indexedAs: sv, actualStatus: actual });
				}
			}
		}

		// Step 4: find DOUBLEs — ids appearing in more than one index bucket
		for (const [id, statuses] of Object.entries(idToIndexedStatuses)) {
			if (statuses.length > 1) {
				double.push({ id, indexedUnder: statuses });
			}
		}

		// Step 5: MISSING check — for each of the rowCount rows, verify it appears
		// in the index for its current actual status
		const missing = [];
		for (let i = 0; i < rowCount; i++) {
			const id = `row-${i}`;
			let actual = actualStatusById[id];
			if (actual === undefined) {
				const rec = await tables.StatusRecord.get(id);
				actual = rec ? rec.status : null;
				actualStatusById[id] = actual;
			}
			if (actual !== null && actual !== undefined) {
				if (!indexByStatus[actual] || !indexByStatus[actual].has(id)) {
					missing.push({ id, actualStatus: actual, appearsInIndex: false });
				}
			}
		}

		return {
			stale,
			double,
			missing,
			stale_count: stale.length,
			double_count: double.length,
			missing_count: missing.length,
		};
	}
}
