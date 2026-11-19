// harper#1894 (F-149) regression fixture. See schema.graphql for the bug description.
//
// Direct-store oracle: RawIndex / PrimaryIds read the raw secondary-index DBI and the raw primary
// store via .getRange() with NO join back through the primary record, so a dangling [null|value, id]
// index entry left behind by eviction is visible (the blind search_by_value oracle joins through the
// gone record and so can never see it).

function pad(n) {
	return String(n).padStart(6, '0');
}
function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`unknown table "${name}"`);
	return t;
}
function qget(query, key) {
	if (!query) return undefined;
	return query.get ? query.get(key) : query[key];
}

// POST /Load/ { table, count, bucket } — bulk insert rows. `bucket` may be the string "null" to
// exercise the legitimate indexNulls path (a present record whose indexed attribute is null).
export class Load extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const n = Number(b.count) || 0;
		const bucket = b.bucket === 'null' ? null : (b.bucket ?? 'B');
		const prefix = b.prefix || b.bucket || 'B';
		const ids = [];
		for (let i = 0; i < n; i++) {
			const id = `${prefix}-${pad(i)}`;
			ids.push(id);
			await t.put({ id, bucket, seq: i });
		}
		return { ok: true, count: n };
	}
}

// GET /RawIndex/?table=X&field=bucket -> every raw {key,value} pair in the secondary index, no join.
export class RawIndex extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const t = getTable(qget(query, 'table'));
		const index = t.indices[qget(query, 'field') || 'bucket'];
		const entries = [...index.getRange({ values: true, snapshot: false })].map(({ key, value }) => ({ key, value }));
		return { count: entries.length, entries };
	}
}

// GET /PrimaryIds/?table=X -> every raw id in the primary store, read directly (no expiresAt filter,
// no join) so a base-count oracle can't race the async on-read lazy-eviction path.
export class PrimaryIds extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const t = getTable(qget(query, 'table'));
		return { ids: [...t.primaryStore.getRange({ snapshot: false, values: false })].map((entry) => entry.key) };
	}
}
