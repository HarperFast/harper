// Regression anchor for harper#1906 — Table.clear() vs secondary-index consistency.
//
// Direct-store oracle (D-242 protocol): IndexDump reads the raw secondary-index dbi via
// index.getRange({ start: null }) — an UNQUALIFIED getRange() on LMDB starts *after* `null`
// and silently skips null-keyed entries, which is exactly the F-175 phantom shape. Dump reads
// the raw primary store with no join, so it's ground truth for "is this id still a real row".
//
// Endpoints:
//   POST /Load/          { table, ids:[...], tagA, tagB? }  — bulk insert. tagB omitted -> the
//                          record has no tagB property at all (absent, not just null).
//   POST /ClearTable/     { table }                          — calls Table.clear() directly.
//   POST /PlantDangling/  { table, attr, value, key }         — writes DIRECTLY into the raw
//                          index dbi (index.put(value, key)) with NO corresponding primary row.
//                          Used only to prove the IndexDump oracle can see a dangling entry
//                          before trusting a "0 dangling" result elsewhere.
//   GET  /Dump/?table=X                — raw primaryStore scan (base ground truth).
//   GET  /IndexDump/?table=X&attr=Y    — raw index.getRange({start:null}) scan.

function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`unknown table "${name}"`);
	return t;
}
function qget(query, key) {
	if (!query) return undefined;
	return query.get ? query.get(key) : query[key];
}

export class Load extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const ids = b.ids || [];
		for (const id of ids) {
			const rec = { id, tagA: b.tagA ?? 'A' };
			if (Object.prototype.hasOwnProperty.call(b, 'tagB')) rec.tagB = b.tagB;
			await t.put(rec);
		}
		return { ok: true, table: b.table, count: ids.length };
	}
}

export class ClearTable extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.clear();
		return { ok: true, table: b.table };
	}
}

// Writes straight into the raw index dbi, bypassing put()/the record layer entirely, so there
// is deliberately NO primary row behind this entry. Proves the oracle isn't blind.
export class PlantDangling extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const index = t.indices[b.attr];
		if (!index) throw new Error(`No index ${b.attr} on ${b.table}`);
		await index.put(b.value, b.key);
		return { ok: true, table: b.table, attr: b.attr, value: b.value, key: b.key };
	}
}

export class Dump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const t = getTable(tableName);
		const out = [];
		for (const entry of t.primaryStore.getRange({ start: false, snapshot: false, versions: true })) {
			if (entry.value == null) continue; // tombstone
			if (typeof entry.key === 'symbol') continue; // internal metadata entry, not a row
			out.push({ id: entry.key, tagA: entry.value.tagA, tagB: entry.value.tagB });
		}
		return out;
	}
}

export class IndexDump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const attr = qget(query, 'attr') || 'tagA';
		const t = getTable(tableName);
		const index = t.indices[attr];
		if (!index) throw new Error(`No index ${attr} on ${tableName}`);
		const out = [];
		for (const entry of index.getRange({ start: null })) {
			out.push({ indexedValue: entry.key, primaryKey: entry.value });
		}
		return out;
	}
}
