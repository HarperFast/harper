// Fixture for phantom-index-permanence.test.ts.
//
// A "phantom" here is a secondary-index entry whose primary record does not exist. Both write
// paths that used to produce one are fixed (harper#1854, harper#1989), so the divergence is
// created synthetically: InjectPhantom writes the composite index key directly through the
// table's own index store, bypassing Table.delete()/updateIndices() entirely.
//
// The oracle is that same server-owned index store read back through getRange() —
// RocksIndexStore.getRange() is a raw composite-key scan with no join through the primary
// record, so unlike search_by_value it can see an entry whose primary is absent.
//
// Table and attribute names are fixed rather than taken from the request: these endpoints can
// write raw index keys, and a generic one reused elsewhere could corrupt an unrelated store.

const INDEXED_ATTRIBUTE = 'category';

function getTable(name) {
	if (name === 'Host') return tables.Host;
	if (name === 'Companion') return tables.Companion;
	throw new Error(`phantom-index-permanence: unknown table "${name}" (expected Host or Companion)`);
}

function getIndex(table, tableName) {
	const index = table.indices?.[INDEXED_ATTRIBUTE];
	if (!index) throw new Error(`phantom-index-permanence: no ${INDEXED_ATTRIBUTE} index on ${tableName}`);
	return index;
}

function qget(query, name) {
	if (!query) return undefined;
	return typeof query.get === 'function' ? query.get(name) : query[name];
}

/** Diagnostic only — the compaction proof is the compact.write.bytes delta, because a sorted-run
 * count can legitimately already be 1 when RocksDB's own background compaction got there first.
 * L0 files overlap so each is its own sorted run, while an entire non-L0 level is one run however
 * many files it is split across; a raw sum of per-level file counts reads an L0->L1 merge that
 * splits across several files as "no change". */
function totalSortedRuns(levelStats) {
	if (typeof levelStats !== 'string') return null;
	let l0 = 0;
	let deeperNonEmptyLevels = 0;
	let sawAnyLevel = false;
	for (const line of levelStats.split('\n')) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s/);
		if (!match) continue;
		sawAnyLevel = true;
		const level = Number(match[1]);
		const files = Number(match[2]);
		if (level === 0) l0 = files;
		else if (files > 0) deeperNonEmptyLevels++;
	}
	return sawAnyLevel ? l0 + deeperNonEmptyLevels : null;
}

// Anything unreadable must reach the test as null rather than 0: a 0 would satisfy an
// "after > before" comparison without any measurement behind it.
function statsOf(store, label) {
	const stats = { compactWriteBytes: null, totalSortedRuns: null, errors: [] };
	if (typeof store?.getStats !== 'function' || typeof store?.getDBProperty !== 'function') {
		stats.errors.push(`${label}: RocksDB statistics API unavailable`);
		return stats;
	}
	try {
		const written = store.getStats(true)?.['rocksdb.compact.write.bytes'];
		if (typeof written === 'number') stats.compactWriteBytes = written;
		else stats.errors.push(`${label}: rocksdb.compact.write.bytes was ${typeof written}, not a number`);
	} catch (error) {
		stats.errors.push(`${label}: getStats threw: ${error.message}`);
	}
	try {
		const levelStats = store.getDBProperty('rocksdb.levelstats');
		stats.totalSortedRuns = totalSortedRuns(levelStats);
		if (stats.totalSortedRuns == null) stats.errors.push(`${label}: could not parse rocksdb.levelstats`);
	} catch (error) {
		stats.errors.push(`${label}: getDBProperty threw: ${error.message}`);
	}
	return stats;
}

export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

// GET /EngineInfo/?table=Host -> the class actually backing the index store, so the suite can
// assert RocksDB rather than trusting that its HARPER_STORAGE_ENGINE request was honored.
export class EngineInfo extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table') || 'Host';
		const table = getTable(tableName);
		return {
			table: tableName,
			indexStoreClass: getIndex(table, tableName).constructor?.name ?? null,
			primaryStoreClass: table.primaryStore?.constructor?.name ?? null,
		};
	}
}

// POST /Seed/ { table, rows: [{ id, category, value }] } -> ordinary puts through the normal
// write path.
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const table = getTable(b.table);
		for (const row of b.rows || []) {
			await table.put({ id: row.id, category: row.category, value: row.value ?? 'seed' });
		}
		return { ok: true, table: b.table, count: (b.rows || []).length };
	}
}

// POST /DeleteOne/ { table, id } -> an ordinary committed delete, no abort.
export class DeleteOne extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const table = getTable(b.table);
		await table.delete(b.id);
		return { ok: true, table: b.table, id: b.id };
	}
}

// POST /InjectPhantom/ { category, id } -> write [category, id] straight into Host's category
// index with no primary record behind it. Refuses if the id does exist, so the fixture cannot
// quietly produce a live entry and call it a phantom.
export class InjectPhantom extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const table = tables.Host;
		if (table.primaryStore.getEntry(b.id)?.value) {
			throw new Error(`phantom-index-permanence: id "${b.id}" exists in the primary store; it would not be a phantom`);
		}
		await getIndex(table, 'Host').put(b.category, b.id);
		return { ok: true, category: b.category, id: b.id };
	}
}

// POST /InjectStaleEntry/ { category, id } -> the contrast to InjectPhantom: an index entry
// under a value the record does NOT hold, for an id that DOES exist. Refuses if the id is
// absent, so the two endpoints cannot be confused for one another.
export class InjectStaleEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const table = tables.Host;
		if (!table.primaryStore.getEntry(b.id)?.value) {
			throw new Error(
				`phantom-index-permanence: id "${b.id}" has no primary record; that would be a phantom, not a stale entry`
			);
		}
		await getIndex(table, 'Host').put(b.category, b.id);
		return { ok: true, category: b.category, id: b.id };
	}
}

// GET /IndexDump/?table=Host&category=X -> raw index-store scan, no join through the primary
// record. Optionally filtered to one indexed value.
export class IndexDump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table') || 'Host';
		const category = qget(query, 'category');
		const index = getIndex(getTable(tableName), tableName);
		const entries = [];
		for (const entry of index.getRange({ start: null })) {
			if (category != null && entry.key !== category) continue;
			entries.push({ indexedValue: entry.key, primaryKey: entry.value });
		}
		return entries;
	}
}

// GET /PrimaryHas/?table=Host&id=X -> does the primary store hold this record at all?
export class PrimaryHas extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table') || 'Host';
		const id = qget(query, 'id');
		return { table: tableName, id, present: getTable(tableName).primaryStore.getEntry(id)?.value != null };
	}
}

// POST /FlushAndStats/ { table } and POST /CompactAndStats/ { table } fold the storage operation
// and the levelstats read into ONE handler call. Split across two requests, RocksDB's own
// background compaction can run in between and the stats read then describes a different on-disk
// state than the one the operation produced.
export class FlushAndStats extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tableName = b.table || 'Host';
		const table = getTable(tableName);
		const index = getIndex(table, tableName);
		if (typeof table.primaryStore.flush !== 'function' || typeof index.flush !== 'function') {
			throw new Error('phantom-index-permanence: flush() unavailable on this storage engine');
		}
		await table.primaryStore.flush();
		await index.flush();
		return { table: tableName, index: statsOf(index, `${tableName}.${INDEXED_ATTRIBUTE} index`) };
	}
}

export class CompactAndStats extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tableName = b.table || 'Host';
		const index = getIndex(getTable(tableName), tableName);
		if (typeof index.compact !== 'function') {
			throw new Error('phantom-index-permanence: compact() unavailable on this storage engine');
		}
		// bottommost: true rewrites every file in the range whether or not RocksDB considers it
		// worth doing, so the phantom's file is rewritten even when background compaction has
		// already merged the range — which is what makes the proof below independent of timing.
		await index.compact({ bottommost: true });
		return { table: tableName, index: statsOf(index, `${tableName}.${INDEXED_ATTRIBUTE} index`) };
	}
}

// GET /Search/?table=Host&category=X -> single-table indexed search(), the shared mechanism REST
// and search_by_value both resolve through.
export class Search extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table') || 'Host';
		const category = qget(query, 'category');
		const table = getTable(tableName);
		const ids = [];
		for await (const record of table.search({ conditions: [{ attribute: INDEXED_ATTRIBUTE, value: category }] })) {
			ids.push(record.id);
		}
		return { table: tableName, category, ids };
	}
}

// GET /ComboSearch/?tables=Companion,Host&category=X -> both tables searched by secondary index,
// in the given order, within ONE request (harper#1881's cross-table read shape).
export class ComboSearch extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const category = qget(query, 'category');
		const order = String(qget(query, 'tables') || 'Companion,Host')
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean);
		const results = {};
		for (const tableName of order) {
			const table = getTable(tableName);
			const ids = [];
			for await (const record of table.search({ conditions: [{ attribute: INDEXED_ATTRIBUTE, value: category }] })) {
				ids.push(record.id);
			}
			results[tableName] = ids;
		}
		return { order, category, results };
	}
}
