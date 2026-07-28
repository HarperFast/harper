// QA-670 — F-175 phantom null-keyed index entry vs harper#1896 (F-149 fix).
//
// Direct-store oracle: IndexDump reads the raw secondary-index DBI via .getRange({ start: null })
// (D-242: an UNQUALIFIED getRange() on LMDB starts after `null` and silently skips null-keyed
// entries — an explicit `start: null` is required to see the F-175 phantom). Dump reads the raw
// primary store, no join, so it is the ground truth for "is this id still a real row".
//
// Endpoints:
//   POST /Load/          { table, ids: [...], bucket } — bulk insert.
//   POST /PlantNull/     { table, id }                  — put a single row with a genuinely
//                          null bucket (no fallback), to arm the null-keyed IndexDump scan itself.
//   POST /Delete/        { table, ids: [...] }          — explicit Table.delete() per id.
//   POST /UpdateInPlace/ { table, ids: [...], bucket }   — re-put same id with a new bucket value
//                          (record stays non-null; exercises the ordinary update branch of
//                          updateIndices(), never the removal branch).
//   GET  /Dump/?table=X               — raw primaryStore.getRange() scan (base ground truth).
//   GET  /IndexDump/?table=X&attr=Y   — raw index.getRange({ start: null }) scan (direct
//                        index-store read, D-242-safe, never joins through the primary record).

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
		const bucket = b.bucket ?? 'B';
		for (const id of ids) await t.put({ id, bucket });
		return { ok: true, table: b.table, count: ids.length };
	}
}

export class PlantNull extends Resource {
	// Directly writes a genuinely-null bucket on a LIVE row (no `?? 'B'` fallback like Load/
	// UpdateInPlace) — used only to arm the null-keyed IndexDump scan itself, independent of any
	// removal path. Proves the raw `index.getRange({ start: null })` oracle can see a null-keyed
	// entry when one deliberately, unambiguously exists.
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.put({ id: b.id, bucket: null });
		return { ok: true, table: b.table, id: b.id };
	}
}

export class Delete extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const ids = b.ids || [];
		for (const id of ids) await t.delete(id);
		return { ok: true, table: b.table, count: ids.length };
	}
}

export class UpdateInPlace extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const ids = b.ids || [];
		const bucket = b.bucket ?? 'UPDATED';
		for (const id of ids) await t.put({ id, bucket });
		return { ok: true, table: b.table, count: ids.length };
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
			out.push({ id: entry.key, bucket: entry.value.bucket });
		}
		return out;
	}
}

export class IndexDump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const attr = qget(query, 'attr') || 'bucket';
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
