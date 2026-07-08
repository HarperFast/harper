// QA-184 — Single-snapshot vs two-read oracle tiebreaker.
//
// Two oracle endpoints for detecting phantom index entries (index hit, base 404):
//
//   POST /BulkLoad/        { bucket, count }  — seed `count` rows tagged with `bucket`.
//   POST /BulkDelete/      { bucket, count }  — delete rows one-by-one (each its own txn).
//   POST /BulkDeleteTxn/   { bucket, count }  — delete all rows in one request txn.
//   GET  /Dump/                               — full base-table scan (index-independent).
//
//   GET  /TwoReadCheck/?bucket=<b>  — TWO-READ ORACLE (reproduces QA-183 cross-snapshot path):
//       1. searchByBucket via ops API is called from the TEST side (outside Harper).
//          This endpoint is called once per index hit to verify base existence.
//          It does a PK lookup via tables.Widget.get(id) — SEPARATE HTTP call from the
//          index query, so each is a FRESH read transaction.
//
//       Wait — we CAN'T reproduce the cross-snapshot split from a SINGLE resource endpoint.
//       The two-read oracle requires the test to call search_by_value (ops API = one txn) and
//       then call a SEPARATE endpoint for each PK-GET (another txn). So the two-read oracle
//       is implemented on the TEST side (in the .test.ts).
//
//   GET  /SnapCheck/?bucket=<b>  — SINGLE-SNAPSHOT ORACLE (the decisive one):
//       Within ONE request handler (= one request transaction):
//       1. tables.Widget.search({ bucket }) — uses secondary index (same read snapshot)
//       2. For each hit: tables.Widget.get(id) — PK lookup (SAME read snapshot as the search)
//       3. Returns { bucket, indexCount, phantomCount, phantoms: [id, ...] }
//
//       If the single-snapshot oracle shows 0 phantoms while the two-read oracle shows N,
//       QA-183's persistent signal was a CROSS-SNAPSHOT ORACLE ARTIFACT.
//       If both show phantoms, there is a REAL read-path staleness defect.
//
//   GET  /PkCheck/?id=<id>  — single PK existence check (used by the two-read oracle in
//       the test side to verify a specific id in a fresh read transaction).

function pad(n) {
	return String(n).padStart(6, '0');
}

// POST /BulkLoad/ { bucket, count } — insert `count` rows tagged with `bucket`.
export class BulkLoad extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const bucket = b.bucket || 'B';
		const n = Number(b.count) || 0;
		for (let i = 0; i < n; i++) {
			await tables.Widget.put({ id: `${bucket}-${pad(i)}`, bucket, seq: i, payload: 'x'.repeat(64) });
		}
		return { ok: true, bucket, count: n };
	}
}

// POST /BulkDelete/ { bucket, count } — one-by-one delete (each its own txn).
export class BulkDelete extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const bucket = b.bucket || 'B';
		const n = Number(b.count) || 0;
		let deleted = 0;
		for (let i = 0; i < n; i++) {
			const id = `${bucket}-${pad(i)}`;
			try {
				await tables.Widget.delete(id);
				deleted++;
			} catch {
				/* already gone */
			}
		}
		return { ok: true, deleted };
	}
}

// POST /BulkDeleteTxn/ { bucket, count } — all deletes in ONE request transaction.
export class BulkDeleteTxn extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const bucket = b.bucket || 'B';
		const n = Number(b.count) || 0;
		const ops = [];
		for (let i = 0; i < n; i++) {
			ops.push(tables.Widget.delete(`${bucket}-${pad(i)}`));
		}
		await Promise.all(ops);
		return { ok: true, bucket, count: n };
	}
}

// GET /Dump/ — full base-table scan (index-independent).
export class Dump extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Widget.search({})) out.push({ id: r.id, bucket: r.bucket, seq: r.seq });
		return out;
	}
}

// GET /PkCheck/?id=<id> — single PK existence check in a fresh read transaction.
// Used by the two-read oracle: each call is a SEPARATE HTTP request = SEPARATE read txn.
export class PkCheck extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = (query && (query.get ? query.get('id') : query.id)) || '';
		if (!id) return { exists: false, id: '', bucket: null };
		const rec = await tables.Widget.get(id);
		return { exists: !!rec, id, bucket: rec ? rec.bucket : null };
	}
}

// GET /SnapCheck/?bucket=<b> — SINGLE-SNAPSHOT ORACLE (the decisive endpoint).
//
// Runs entirely within ONE request transaction:
//   1. tables.Widget.search({ bucket }) — secondary-index scan (indexed read, same snapshot)
//   2. For each hit: tables.Widget.get(id) — PK lookup (SAME snapshot as the search above)
//   3. A phantom is an id returned by the index scan whose PK lookup returns null/undefined.
//
// If phantoms appear here, they are REAL (cannot be an oracle cross-snapshot artifact because
// both reads share the same read snapshot).
// If phantoms appear ONLY in the two-read oracle (separate HTTP calls), QA-183 was an artifact.
export class SnapCheck extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const bucket = (query && (query.get ? query.get('bucket') : query.bucket)) || 'B';
		const phantoms = [];
		let indexCount = 0;
		// Step 1: indexed scan for this bucket (secondary index, read snapshot T).
		// Use conditions array syntax — the plain-object shorthand { bucket } is NOT
		// equivalent to a conditions filter; it would be treated as a no-condition full scan.
		for await (const r of tables.Widget.search([{ attribute: 'bucket', value: bucket }])) {
			indexCount++;
			// Step 2: PK lookup on the SAME read snapshot T
			const base = await tables.Widget.get(r.id);
			if (!base || base.bucket !== bucket) {
				phantoms.push(r.id);
			}
		}
		return { bucket, indexCount, phantomCount: phantoms.length, phantoms };
	}
}
