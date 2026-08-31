// Fixture for phantom-index-permanence.test.ts.
//
// Table and attribute names are fixed rather than taken from the request: these endpoints write
// raw index keys, and a generic one reused by another fixture could corrupt an unrelated store.

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

async function searchIds(tableName, category) {
	const ids = [];
	for await (const record of getTable(tableName).search({
		conditions: [{ attribute: INDEXED_ATTRIBUTE, value: category }],
	})) {
		ids.push(record.id);
	}
	return ids;
}

/** Diagnostic only. L0 files overlap so each is its own sorted run, while an entire non-L0 level
 * is one run however many files it is split across; a raw sum of per-level file counts reads an
 * L0->L1 merge that splits across several files as "no change". */
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

function statsOf(store, label) {
	const stats = { compactWriteBytes: null, totalSortedRuns: null, errors: [] };
	if (typeof store?.getStats !== 'function' || typeof store?.getDBProperty !== 'function') {
		stats.errors.push(`${label}: RocksDB statistics API unavailable`);
		return stats;
	}
	try {
		// RocksDB omits a counter that is still zero, which is a legitimate reading for the sample
		// taken before any compaction has run; only an unusable API is an error.
		const written = store.getStats(true)?.['rocksdb.compact.write.bytes'] ?? 0;
		if (typeof written === 'number') stats.compactWriteBytes = written;
		else stats.errors.push(`${label}: rocksdb.compact.write.bytes was a ${typeof written}, not a number`);
	} catch (error) {
		stats.errors.push(`${label}: getStats threw: ${error.message}`);
	}
	try {
		stats.totalSortedRuns = totalSortedRuns(store.getDBProperty('rocksdb.levelstats'));
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

// The class actually backing the index store, so the suite can assert RocksDB rather than trust
// that its HARPER_STORAGE_ENGINE request was honored.
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

export class DeleteOne extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		await getTable(b.table).delete(b.id);
		return { ok: true, table: b.table, id: b.id };
	}
}

/** Writes [category, id] into Host's category index directly, bypassing Table's write path. */
async function injectIndexEntry(category, id) {
	await getIndex(tables.Host, 'Host').put(category, id);
	return { ok: true, category, id };
}

// InjectPhantom and InjectStaleEntry differ only in which primary state they require, and that is
// the whole point of having two: a single endpoint taking a flag would let a caller inject the
// wrong kind of entry and still be believed.
export class InjectPhantom extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		if (tables.Host.primaryStore.getEntry(b.id)?.value) {
			throw new Error(`phantom-index-permanence: id "${b.id}" exists in the primary store; it would not be a phantom`);
		}
		return injectIndexEntry(b.category, b.id);
	}
}

export class InjectStaleEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		if (!tables.Host.primaryStore.getEntry(b.id)?.value) {
			throw new Error(
				`phantom-index-permanence: id "${b.id}" has no primary record; that would be a phantom, not a stale entry`
			);
		}
		return injectIndexEntry(b.category, b.id);
	}
}

// The raw index scan, with no join through the primary record — the only oracle that can see an
// entry whose primary is absent. Deliberately scans the whole index rather than seeking to the
// requested value, so an entry filed under an unexpected key is still observable.
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

export class PrimaryHas extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table') || 'Host';
		const id = qget(query, 'id');
		return { table: tableName, id, present: getTable(tableName).primaryStore.getEntry(id)?.value != null };
	}
}

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
		const label = `${tableName}.${INDEXED_ATTRIBUTE} index`;
		// Both samples are taken here rather than by the caller: rocksdb.compact.write.bytes is a
		// DB-wide lifetime counter, so a sample taken in an earlier request would let a background
		// compaction of any column family land in between and account for the whole delta.
		const before = statsOf(index, label);
		// bottommost: true rewrites every file in the range whether or not RocksDB considers it
		// worth doing, so the phantom's file is rewritten even when background compaction has
		// already merged the range — which is what makes the proof independent of timing.
		await index.compact({ bottommost: true });
		return { table: tableName, before, after: statsOf(index, label) };
	}
}

// Every named table searched by secondary index, in the given order, within one request —
// harper#1881's cross-table read shape. One table in `tables` is the ordinary single-table search.
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
			results[tableName] = await searchIds(tableName, category);
		}
		return { order, category, results };
	}
}
