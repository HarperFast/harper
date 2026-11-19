// QA-323 — Pure append-only insert workload: LMDB vs RocksDB unique-PK durability.
//
// /AppendUnique/   — insert one row with a UUID generated server-side; returns { id } so
//                    the caller can track exactly what was committed.
// /AppendCollide/  — insert one row with a FIXED id from a small collision pool (control:
//                    exercises last-write-wins, expected shortfall, not a defect).
// /Count/          — return { count } of all Ledger rows (full scan).
// /Reset/          — delete all Ledger rows via search + delete (clears between variants).

import { randomUUID } from 'node:crypto';

// Collision pool size for the colliding-PK control variant.
const COLLIDE_POOL = 5;

export class AppendUnique extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const seq = Number(b.seq) || 0;
		const payload = String(b.payload || '');
		// UUID generated server-side — guaranteed unique per call regardless of concurrency.
		const id = randomUUID();
		await tables.Ledger.put({ id, seq, payload });
		return { id, seq };
	}
}

export class AppendCollide extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const seq = Number(b.seq) || 0;
		const payload = String(b.payload || '');
		// id drawn from a tiny fixed pool — concurrent inserts WILL collide (last-write-wins control).
		const id = `collide-slot-${seq % COLLIDE_POOL}`;
		await tables.Ledger.put({ id, seq, payload });
		return { id, seq };
	}
}

export class Count extends Resource {
	static loadAsInstance = false;
	async get(_query) {
		let count = 0;
		const ids = [];
		for await (const row of tables.Ledger.search()) {
			count++;
			if (ids.length < 10) ids.push(row.id);
		}
		return { count, sample: ids };
	}
}

export class Reset extends Resource {
	static loadAsInstance = false;
	async post(_query, _body) {
		let deleted = 0;
		const toDelete = [];
		for await (const row of tables.Ledger.search()) {
			toDelete.push(row.id);
		}
		for (const id of toDelete) {
			await tables.Ledger.delete(id);
			deleted++;
		}
		return { deleted };
	}
}
