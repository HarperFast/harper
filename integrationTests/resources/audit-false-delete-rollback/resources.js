// F-147 / #1854 — aborted delete on an audit:false @indexed table must roll back.
//
// POST /DeleteAndAbort/ { id }
//   Deletes the row, then throws — forcing the ambient request transaction to abort.
//   If removeEntry() is properly transactional, both the base row and its secondary-index
//   entry must survive the abort.
//
// POST /DeleteAndCommit/ { id }
//   Deletes the row and returns normally (no throw) — the regression guard confirming the
//   fix didn't break an ordinary committed delete.
//
// Direct-store oracle (D-242 protocol, matching eviction-index-phantom-null-keys/resources.js):
// GET /IndexDump/?attr=bucket reads the raw secondary-index dbi via index.getRange({start:null})
// — an unqualified getRange() on LMDB starts *after* `null` and silently skips null-keyed
// entries, which is exactly the F-175 phantom shape. search_by_value cannot see this: it joins
// each hit back through the primary record and drops any hit whose record is gone, so it is
// blind by construction to the dangling/phantom entries this suite exists to catch.
//
// POST /PlantDangling/ { attr, value, key } writes DIRECTLY into the raw index dbi
// (index.put(value, key)) with no corresponding primary row — used only to prove the IndexDump
// oracle can see a dangling/phantom entry before trusting a "0 entries" result elsewhere.
// POST /RemoveIndexEntry/ { attr, value, key } cleans up such a planted entry (index.remove()).

export class IndexDump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const attr = (query?.get ? query.get('attr') : query?.attr) || 'bucket';
		const index = tables.Item.indices[attr];
		if (!index) throw new Error(`No index ${attr} on Item`);
		const out = [];
		for (const entry of index.getRange({ start: null })) {
			out.push({ indexedValue: entry.key, primaryKey: entry.value });
		}
		return out;
	}
}

export class PlantDangling extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const index = tables.Item.indices[b.attr || 'bucket'];
		if (!index) throw new Error(`No index ${b.attr || 'bucket'} on Item`);
		await index.put(b.value, b.key);
		return { ok: true, attr: b.attr || 'bucket', value: b.value, key: b.key };
	}
}

export class RemoveIndexEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const index = tables.Item.indices[b.attr || 'bucket'];
		if (!index) throw new Error(`No index ${b.attr || 'bucket'} on Item`);
		await index.remove(b.value, b.key);
		return { ok: true, attr: b.attr || 'bucket', value: b.value, key: b.key };
	}
}

export class DeleteAndAbort extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		await tables.Item.delete(b.id);
		throw new Error(`F-147 forced throw after Item(${b.id}) delete`);
	}
}

export class DeleteAndCommit extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		await tables.Item.delete(b.id);
		return { ok: true, id: b.id };
	}
}
