// F-149 LMDB-engine variant of the QA-611 direct-store oracle harness. Resources reused
// verbatim from integrationTests/qa-scratch/qa611-eviction-index-reaudit/resources.js (raw
// index/primary DBI reads via .getRange(), immune to D-230's transformToEntries() join-skip),
// plus a new StorageEngineInfo endpoint so the test can HARD-ASSERT the engine actually in
// effect is LMDB rather than assuming the env var took effect (per resources/databases.ts
// `database()`, HARPER_STORAGE_ENGINE is checked before the config-file storage_engine key and
// wins; LMDB env stores land at `<path>.mdb` and LMDB indices expose `.prefetch`, RocksDB does
// not — both checked here as independent, code-derived engine signals).

function pad(n) {
	return String(n).padStart(6, '0');
}
function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`QA-611-LMDB: unknown table "${name}"`);
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

// POST /DeleteThenAbort/ { table, id } — F-147 mechanism (Widget only): delete, then throw in the
// same per-request transaction. This is the D-232 POSITIVE CONTROL: it injects a KNOWN-dangling
// raw index entry so a subsequent "0 dangling" reading on the TTL tables is earned.
export class DeleteThenAbort extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.delete(b.id);
		throw new Error(`QA-611-LMDB deliberate abort after delete (table=${b.table} id=${b.id})`);
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
		// NB (LMDB): unlike RocksDB, LMDB's category index is a dupSort store, which forbids
		// combining values:true with snapshot:false ("Can not disable snapshot on a dupSort data
		// store" — node_modules/lmdb/read.js). Omit snapshot:false here; each request already runs
		// in its own short-lived transactional context, so a stale-snapshot read isn't a concern.
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
		// See IndexDump above: LMDB's dupSort index store forbids values:true + snapshot:false.
		const entries = [...index.getRange({ values: true })].map(({ key, value }) => ({ key, value }));
		return { table: tableName, count: entries.length, entries };
	}
}

// GET /PrimaryIds/?table=X -> every raw id currently in the PRIMARY store, read directly (no
// expiresAt application-level check, no join, immune to any lazy-eviction-on-read race).
//
// QA-614 oracle fix (root-caused via a standalone diag endpoint, see qa614-diag.test.ts history):
// QA-613's version called `.map((entry) => entry.key)` after `getRange({ values: false })`. Per
// lmdb-js read.js (~line 810): when `includeValues` AND `includeVersions` are both falsy, the
// iterator yields the BARE KEY itself as each entry, not a `{key, value}` wrapper object --
// `{ value: currentKey }` is returned straight from the native read, no wrapping. So
// `entry.key` on a plain string entry is `undefined` for every single row; all 750 `undefined`s
// then collapsed into a single `"undefined"` string when the test's `new Set(ids.map(String))`
// deduplicated them -- that's exactly the "1 of 750" QA-613 saw. It was never a start-bound or
// snapshot issue (confirmed empirically: `start:false` alone did not fix it; the diag endpoint's
// `getKeysResult` -- lmdb-js's own `getKeys()`, which is exactly `getRange({values:false})` with
// no extra mapping -- returned all 10 rows correctly, because it does NOT do `.key` on the bare
// string). Fix: request `versions: true` (as Table.ts's own full-range primaryStore scans do,
// e.g. the cleanup-scan ~line 5724) so the iterator switches to the `{key, version}`-wrapped
// entry shape lmdb-js uses whenever versions are requested, matching how `.key` is actually used.
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

// GET /DumpBase/?table=X -> full base-table scan via the resource layer (index-independent).
export class DumpBase extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qget(query, 'table');
		const t = getTable(tableName);
		const out = [];
		for await (const r of t.search({})) out.push({ id: r.id, category: r.category, value: r.value });
		return out;
	}
}

// POST /RemoveFromPrimaryOnly/ { table, id } — QA-614 SYNTHETIC positive-control mechanism, step 2.
//
// A2 (below, F-147's DeleteThenAbort mechanism) does NOT fire on LMDB: point-read after the
// delete+abort settles back to 200 (row still present), unlike RocksDB where the primary row
// stays deleted despite the abort. That is a real, separate, and informational finding (LMDB's
// per-record delete path appears to roll back the primary removal and the index removal
// together, i.e. genuinely atomic under abort here -- see the test file's part A2 for the
// evidence), but it means F-147 can't be reused as the LMDB positive-control mechanism the way
// it was on RocksDB. D-232 only requires SOME known-dangling entry the oracle must detect, not
// that it be produced by any particular Harper code path -- so the test seeds a row normally
// via a real REST PUT (`seed()`, `.expect(204)` -- guaranteed durably committed) and then, in
// this SEPARATE request, calls store-level primaryStore.remove() directly, bypassing
// updateIndices() entirely and deliberately leaving the raw index entry behind. Doing the put and
// the low-level remove as two separate HTTP requests (rather than both inline in one handler)
// avoids racing Harper's own event-turn write batching for the put against the raw store call.
export class RemoveFromPrimaryOnly extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const removed = await t.primaryStore.remove(b.id);
		return { ok: true, removed, table: b.table, id: b.id };
	}
}
