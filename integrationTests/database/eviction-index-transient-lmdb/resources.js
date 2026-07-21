// QA-615 (D-232 re-audit of F-041, axis C(expiration-scan) x K(indexed), engine=LMDB).
//
// Reuses the QA-611/QA-614 direct-store oracle resources verbatim (IndexDump/IndexRangeAll/
// PrimaryIds/StorageEngineInfo/TableInfo/RemoveFromPrimaryOnly, from
// integrationTests/qa-scratch/qa611-lmdb-eviction-index/resources.js) so the settled-state check
// stays comparable to QA-614's finding, and adds ONE new resource -- SampleSweep -- that is the
// actual point of this re-audit: an in-process tight-interval sampler that reads the raw primary
// store and raw category index BOTH from inside the Harper worker (no HTTP round-trip skew
// between the two reads) repeatedly across the eviction window, so a transient phantom (index
// entry visible while its primary row is already gone) can be caught mid-sweep, not just after
// it settles.
function pad(n) {
	return String(n).padStart(6, '0');
}
function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`QA-615: unknown table "${name}"`);
	return t;
}
function qget(query, key) {
	if (!query) return undefined;
	return query.get ? query.get(key) : query[key];
}

// GET /StorageEngineInfo/?table=X -> code-derived signals for which storage engine is actually
// backing this table (do NOT just trust the HARPER_STORAGE_ENGINE env var was honored).
export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table') || 'ItemF';
		const t = getTable(tableName);
		const primaryPath = t.primaryStore?.path || t.primaryStore?.rootStore?.path || null;
		const indexHasPrefetch = !!t.indices?.category?.prefetch;
		const primaryHasPrefetch = !!t.primaryStore?.prefetch;
		const looksLikeLmdbPath = typeof primaryPath === 'string' && primaryPath.endsWith('.mdb');
		const isLmdb = looksLikeLmdbPath || indexHasPrefetch || primaryHasPrefetch;
		return {
			table: tableName,
			primaryPath,
			indexHasPrefetch,
			primaryHasPrefetch,
			looksLikeLmdbPath,
			engineGuess: isLmdb ? 'lmdb' : 'rocksdb',
		};
	}
}

// POST /SeedItems/ { table, category, count, prefix? } -> bulk, concurrent inserts (TTL armed on write).
export class SeedItems extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const n = Number(b.count) || 3;
		const cat = b.category || '__seed__';
		const prefix = b.prefix || cat;
		const ids = [];
		const CHUNK = 100;
		for (let s = 0; s < n; s += CHUNK) {
			const slice = [];
			for (let i = s; i < Math.min(s + CHUNK, n); i++) {
				const id = `${prefix}-${pad(i)}`;
				ids.push(id);
				slice.push(t.put({ id, category: cat, value: 'x'.repeat(24) }));
			}
			await Promise.all(slice);
		}
		return { ok: true, table: b.table, count: n, category: cat, ids };
	}
}

// GET /IndexDump/?table=X&category=Y -> raw ids under index key Y, NO primary join.
export class IndexDump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const category = qget(query, 'category');
		const t = getTable(tableName);
		const index = t.indices.category;
		const ids = [...index.getRange({ start: category, end: category, inclusiveEnd: true, values: true })]
			.filter((entry) => entry.key === category)
			.map((entry) => entry.value);
		return { table: tableName, category, ids };
	}
}

// GET /IndexRangeAll/?table=X -> every raw {key,value} pair in the whole category index.
export class IndexRangeAll extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const t = getTable(tableName);
		const index = t.indices.category;
		const entries = [...index.getRange({ values: true })].map(({ key, value }) => ({ key, value }));
		return { table: tableName, count: entries.length, entries };
	}
}

// GET /PrimaryIds/?table=X -> every raw id currently in the PRIMARY store, read directly.
// QA-614 fix: must request versions:true or lmdb-js's getRange yields bare keys and
// `entry.key` is undefined on every row (see qa611-lmdb-eviction-index/resources.js history).
export class PrimaryIds extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const t = getTable(tableName);
		const ids = [...t.primaryStore.getRange({ start: false, snapshot: false, versions: true })].map(
			(entry) => entry.key
		);
		return { table: tableName, count: ids.length, ids };
	}
}

// GET /TableInfo/?table=X -> whether audit:false/true actually took effect for this table.
export class TableInfo extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const t = getTable(tableName);
		return { table: tableName, audit: t.audit, hasAuditStore: !!t.auditStore };
	}
}

// POST /RemoveFromPrimaryOnly/ { table, id } -- D-232 synthetic positive-control mechanism (QA-614):
// a normal put (durably indexed), then a SEPARATE request that removes the primary row at the
// store level, bypassing updateIndices() entirely, deliberately leaving a KNOWN-dangling raw
// index entry behind so the oracle's "0 dangling" result elsewhere is earned, not vacuous.
export class RemoveFromPrimaryOnly extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const removed = await t.primaryStore.remove(b.id);
		return { ok: true, removed, table: b.table, id: b.id };
	}
}

// POST /SampleSweep/ { table, durationMs, intervalMs } -> QA-615's new instrument.
//
// Runs a tight in-process polling loop, for `durationMs`, every `intervalMs`, reading the RAW
// primary store and RAW category index directly (same D-232/D-230-safe technique as
// IndexRangeAll/PrimaryIds above -- no join through the primary record). Because both reads
// happen back-to-back inside the SAME worker with no network hop between them, this samples much
// closer to "a single instant" than two separate HTTP round trips could, which is what makes it
// possible to catch a genuinely transient window (index entry present, primary row already gone)
// rather than just the settled end-state QA-614 already checked.
//
// Read order is deliberate: primary FIRST, then index. F-041's hypothesized defect shape is
// "primary delete commits, index delete has not yet committed" -- i.e. a record already absent
// from the primary snapshot but still present in the index snapshot taken immediately after. That
// ordering biases toward catching exactly that window (a record that becomes primary-absent
// between our index read and our next primary read would just show up as consistent on both
// sides of the boundary, not as a false phantom).
//
// NOTE: this used to be a single long-held POST (SampleSweep) that looped server-side for the
// whole sweep duration inside one request. That collided with Harper's own http-worker rollover
// (restartHttpWorkers queues a background drain of the pre-restart worker generation that can
// take several more seconds after the setup call returns) -- a long-held connection landing on a
// worker that gets drained mid-request is forcefully closed ("Forcefully closing N active
// connections"), which is exactly what killed the ItemF run and is an artifact of holding one
// connection open for 15s, not a finding about F-041. Splitting into many short SampleOnce calls,
// driven by a tight loop in the TEST (not the server), sidesteps that: each call is a few ms, so
// a worker-rollover event can only ever cost a single dropped sample, never the whole run, and it
// also avoids a 15s-long single request potentially starving that worker's event loop (which
// would itself be a confound -- an artifact of the instrument, not of the eviction path).
export class SampleOnce extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const index = t.indices.category;
		const baseIds = new Set(
			[...t.primaryStore.getRange({ start: false, snapshot: false, versions: true })].map((e) => e.key)
		);
		const indexEntries = [...index.getRange({ values: true })];
		const indexIds = indexEntries.map((e) => e.value);
		const phantom = indexIds.filter((id) => !baseIds.has(id));
		return {
			table: b.table,
			t: Date.now(),
			baseCount: baseIds.size,
			indexCount: indexIds.length,
			phantomCount: phantom.length,
			phantomIds: phantom.slice(0, 10),
		};
	}
}
