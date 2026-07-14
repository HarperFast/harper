// QA-314 — over-time write-txn atomicity tie-breaker.
//
// The key question: when the long-transaction monitor fires MID-REQUEST and
// force-commits (pre-#1411) or aborts+poisons (#1411+) the transaction, what
// does the CLIENT see, and is atomicity preserved?
//
// Scenarios tested:
//
// BASELINE (control) — write N+1 rows within threshold, return 200.
//   Oracle: ALL N+1 rows survive, 200 returned. Validates harness + normal path.
//
// OVERTIME — write N rows, HOLD past threshold (monitor fires), write 1 MARKER row.
//   This is the exact pattern from QA-309 A2 / the original observation.
//   Oracle (tie-breaker):
//     DEFECT    = 2xx   + partial rows (marker only, N rows missing)     ← silent partial drop
//     CLEAN (a) = 5xx   + 0 rows                                         ← abort + error
//     CLEAN (b) = 5xx   + N+1 rows (all survived via force-commit)        ← force-commit + error
//     CLEAN (c) = 2xx   + N+1 rows                                       ← full-commit success
//
// Endpoints:
//   POST /Baseline/    { tag, count, holdMs:0 } → quick write N+1 rows
//   POST /Overtime/    { tag, count, holdMs }   → write N rows, hold>threshold, write marker
//   GET  /DumpAtomic/                           → all rows [{ id, tag, seq }]
//   GET  /ReadyProbe/                           → { ok: true } readiness check

function pad(n) {
	return String(n).padStart(6, '0');
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// POST /Baseline/ { tag, count }
// Control: write count rows quickly (no sleep), return 200.
export class Baseline extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const n = Number(b.count) || 5;
		const tag = b.tag || 'baseline';
		const t0 = Date.now();
		for (let i = 0; i < n; i++) {
			await tables.Atomic.put({ id: `${tag}-${pad(i)}`, tag, seq: i, payload: 'base'.repeat(8) });
		}
		// marker row
		await tables.Atomic.put({ id: `${tag}-marker`, tag, seq: 9999, payload: 'marker' });
		return { ok: true, count: n + 1, tag, elapsedMs: Date.now() - t0 };
	}
}

// POST /Overtime/ { tag, count, holdMs }
// Writes count rows, holds the open txn past maxTransactionOpenTime, then writes marker.
// To ensure the txn is tracked by the monitor: hold an open search iterator over a seed row.
export class Overtime extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const n = Number(b.count) || 5;
		const tag = b.tag || 'overtime';
		const holdMs = b.holdMs != null ? Number(b.holdMs) : 4000;
		const t0 = Date.now();

		// Seed row ensures iterator has something to open (seeded by test before calling Overtime).
		const iter = tables.Atomic.search({ conditions: [{ attribute: 'tag', value: '__seed__' }] })[
			Symbol.asyncIterator
		]();
		await iter.next(); // registers txn with long-transaction monitor

		try {
			// Phase 1: write N rows quickly.
			for (let i = 0; i < n; i++) {
				await tables.Atomic.put({ id: `${tag}-${pad(i)}`, tag, seq: i, payload: 'overtime'.repeat(8) });
			}

			// Phase 2: hold open past threshold — monitor fires here.
			await sleep(holdMs);

			// Phase 3: write marker AFTER the monitor has fired.
			await tables.Atomic.put({ id: `${tag}-marker`, tag, seq: 9999, payload: 'marker' });
		} finally {
			await iter.return?.();
		}

		return { ok: true, count: n + 1, tag, elapsedMs: Date.now() - t0 };
	}
}

// GET /DumpAtomic/ → [{ id, tag, seq }]
export class DumpAtomic extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Atomic.search({})) out.push({ id: r.id, tag: r.tag, seq: r.seq });
		return out;
	}
}

// GET /ReadyProbe/ → { ok: true }
export class ReadyProbe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}
