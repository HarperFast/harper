// QA-661 (source:pr:1896) probe fixture.
//
// Oracle rule (per the probe brief): search_by_value joins through the primary record and SKIPs
// when it's absent, so it can NEVER reveal a dangling index entry. Every endpoint here reads the
// raw store/index directly (no join) so orphan and lost-lookup index entries are both visible.

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

// POST /Load/ { table, count, prefix, bucket, nullEvery, withTags }
// bulk insert. nullEvery: every Nth row gets bucket=null (indexNulls path). withTags: also sets a
// 0-3 element `tags` array (array-valued indexed attribute; some rows land with an empty array).
export class Load extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const n = Number(b.count) || 0;
		const prefix = b.prefix || 'B';
		const nullEvery = Number(b.nullEvery) || 0;
		for (let i = 0; i < n; i++) {
			const id = `${prefix}-${pad(i)}`;
			const bucket = nullEvery && i % nullEvery === 0 ? null : b.bucket;
			const rec = { id, bucket, seq: i };
			if (b.withTags) {
				const count = i % 4; // 0..3 tags per row, including some empty arrays
				rec.tags = Array.from({ length: count }, (_, k) => `${b.bucket}-tag${k}`);
			}
			await t.put(rec);
		}
		return { ok: true, count: n };
	}
}

// POST /Heartbeat/ { table, ids, bucket, tags } — repeated full-replace PUT on a fixed set of ids.
// Every write without an explicit expiresAt recomputes expiresAt = now + table expirationMs
// (Table.ts ~L2532), so this refreshes the TTL each call: these rows stay alive throughout the
// sweep window while unrelated ids expire and get evicted concurrently on other worker threads.
// This exercises "update an indexed attribute while eviction races on neighboring rows" — old
// index entry must go, new one must land, with no cross-contamination from the concurrent sweep.
export class Heartbeat extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		for (const id of b.ids) {
			const rec = { id, bucket: b.bucket, seq: 0 };
			if (b.tags) rec.tags = b.tags;
			await t.put(rec);
		}
		return { ok: true };
	}
}

// POST /DeleteIds/ { table, ids } — explicit delete() path (vs TTL-sweep eviction).
export class DeleteIds extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		for (const id of b.ids) await t.delete(id);
		return { ok: true };
	}
}

// POST /EvictIds/ { table, ids } — explicit evict() path (the caching-table removal path;
// distinct from both delete() and the TTL sweep, but shares the same updateIndices(id, rec, null)
// call that F-149 fixed).
export class EvictIds extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		let evicted = 0;
		for (const id of b.ids) {
			const entry = t.primaryStore.getEntry(id);
			if (entry) {
				await t.evict(id, entry.value, entry.version);
				evicted++;
			}
		}
		return { ok: true, evicted };
	}
}

// GET /RawIndex/?table=X&field=bucket -> every raw {key,value} pair in the secondary index DBI,
// no join through the primary record.
export class RawIndex extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const t = getTable(qget(query, 'table'));
		const index = t.indices[qget(query, 'field') || 'bucket'];
		// Two LMDB-specific raw-getRange gotchas neither of which are Table.ts/index bugs:
		//  1. LMDB secondary-index stores are dupSort (multiple ids per key) and reject
		//     snapshot:false ("Can not disable snapshot on a dupSort data store") - RocksDB doesn't
		//     need it disabled to see committed writes made just before this read, so just omit it.
		//  2. lmdb-js's default getRange() start is Buffer.from([5]) ("excludes symbols/metadata"
		//     per lmdb-js/open.js), which in ordered-binary key encoding sorts AFTER `null` - so an
		//     unqualified full-range scan silently skips null-keyed (indexNulls) entries on LMDB.
		//     Pass start:null explicitly to include them (RocksDB is unaffected either way).
		const entries = [...index.getRange({ values: true, start: null })].map(({ key, value }) => ({
			key,
			value,
		}));
		return { count: entries.length, entries };
	}
}

// GET /PrimaryDump/?table=X -> every raw {id, ...record} in the primary store, read directly (no
// expiresAt filter, no join), so we can compute "what the index SHOULD contain" independently of
// the index itself.
export class PrimaryDump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const t = getTable(qget(query, 'table'));
		const rows = [...t.primaryStore.getRange({ snapshot: false })].map(({ key, value }) => ({
			id: key,
			...value,
		}));
		return { rows };
	}
}
