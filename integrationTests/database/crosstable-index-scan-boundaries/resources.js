// QA-632 — mechanism boundaries of F-158 / GH #1881 (RocksDB secondary-index scan miss
// once a table's rows for a queried slot span >1 on-disk sorted run). See qa629's
// qa629-crosstable-index-miss.test.ts for the confirmed base repro this extends.
//
// `tables` are only ever aliased to the default 'data' database (see resources/databases.ts);
// these tables live in "f158bounds", so they must be resolved via the explicit
// `databases.<name>.<Table>` accessor.
function getTable(tableName) {
	return databases['f158bounds'][tableName];
}

function bodyOf(kb) {
	return 'x'.repeat(1024).repeat(kb);
}

// POST /SeedWave/ { table, wave, keys, perKeyPerWave, bodyKb } — one wave = one transaction.
// Mirrors qa629's SeedWave: repeated calls scatter a key's index entries across separate
// commits, which is what forces distinct RocksDB memtable flushes (sorted runs) once the
// WriteBufferManager budget is exceeded.
export class SeedWave extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tableName = b.table;
		const wave = Number(b.wave);
		const keys = Number(b.keys) || 50;
		const perKeyPerWave = Number(b.perKeyPerWave) || 5;
		const bodyKb = Number(b.bodyKb) || 4;
		const table = getTable(tableName);
		if (!table) throw new Error(`unknown table ${tableName}`);
		const payload = bodyOf(bodyKb);
		let count = 0;
		for (let r = 0; r < keys; r++) {
			for (let i = 0; i < perKeyPerWave; i++) {
				const n = wave * perKeyPerWave + i;
				await table.put({ id: `${tableName}-r${r}-n${n}`, repositoryId: `repo-${r}`, n, body: payload });
				count++;
			}
		}
		return { ok: true, table: tableName, wave, count };
	}
}

// POST /Flush/ { table? } — force every RocksDB column family sharing this schema's directory
// to flush its memtable to a new SST file, atomically (atomic_flush=true covers primary CF +
// every secondary-index CF for every table in the schema, not just the named one). This is the
// QA-772 sorted-run-forcing technique: call once between seeding waves so each wave lands in
// its own on-disk SST, instead of relying on a pathological writeBufferManagerSize cap (which
// hangs this fixture's seed — see file header).
export class Flush extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const table = getTable(b.table || 'MinRepro');
		if (typeof table.primaryStore.flush !== 'function')
			throw new Error('Flush control invalid: primaryStore.flush() not available (not RocksDB?)');
		await table.primaryStore.flush();
		return { ok: true };
	}
}

// GET /IndexStats/?table=X&attribute=repositoryId — introspects RocksDB's own view of how
// many sorted runs exist for a store (primary CF or a named secondary-index CF). NOTE:
// getDBIntProperty('rocksdb.num-files-at-level0') reliably returns undefined on this
// @harperfast/rocksdb-js build (confirmed QA-638/QA-772); parse the "Level 0" row's file
// count out of the STRING property 'rocksdb.levelstats' instead, which does work.
export class IndexStats extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const q = (name, def) => {
			const v = query && (query.get ? query.get(name) : query[name]);
			return v == null ? def : v;
		};
		const tableName = q('table', 'MinRepro');
		const attribute = q('attribute', 'repositoryId');
		const table = getTable(tableName);
		if (!table) throw new Error(`unknown table ${tableName}`);
		const primaryStore = table.primaryStore;
		const indexStore = table.indices && table.indices[attribute];
		function statsOf(store) {
			if (!store || typeof store.getDBIntProperty !== 'function') return { unavailable: true };
			let levelStats;
			try {
				levelStats = store.getDBProperty && store.getDBProperty('rocksdb.levelstats');
			} catch (e) {
				levelStats = `error: ${e.message}`;
			}
			let l0Files = null;
			if (typeof levelStats === 'string') {
				const m = levelStats.match(/^\s*0\s+(\d+)/m);
				if (m) l0Files = Number(m[1]);
			}
			let pendingFlush, numEntries;
			try {
				pendingFlush = store.getDBIntProperty('rocksdb.mem-table-flush-pending');
			} catch {
				/* not fatal */
			}
			try {
				numEntries = store.getDBIntProperty('rocksdb.estimate-num-keys');
			} catch {
				/* not fatal */
			}
			return { l0Files, levelStats, pendingFlush, numEntries };
		}
		return {
			table: tableName,
			attribute,
			primary: statsOf(primaryStore),
			index: statsOf(indexStore),
		};
	}
}

// POST /CompactTable/ { table } — manually compacts the table's primary-key column family
// plus every secondary-index column family, using @harperfast/rocksdb-js's native
// compact()/compactSync(). This is the direct analogue of a background RocksDB compaction
// merging sorted runs back into one, without waiting on auto-compaction triggers.
export class CompactTable extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tableName = b.table;
		const table = getTable(tableName);
		if (!table) throw new Error(`unknown table ${tableName}`);
		const results = {};
		async function compactStore(name, store) {
			if (!store) {
				results[name] = 'missing';
				return;
			}
			if (typeof store.compact !== 'function') {
				results[name] = 'unreachable: no compact() on store (non-RocksDB engine?)';
				return;
			}
			try {
				await store.compact();
				results[name] = 'ok';
			} catch (e) {
				results[name] = `error: ${e.message}`;
			}
		}
		await compactStore('primary', table.primaryStore);
		for (const attrName of Object.keys(table.indices || {})) {
			await compactStore(`index:${attrName}`, table.indices[attrName]);
		}
		return { table: tableName, results };
	}
}

// GET /DrainOwn/?table=X&key=repo-N&reads=2&scan=index — performs `reads` SEPARATE
// index (or full-scan) searches against the SAME table/key, all WITHIN THIS ONE REQUEST.
// This isolates whether F-158's "second access in the request" trigger requires a
// DIFFERENT table having been read first, or whether the table's OWN prior read within the
// same request already poisons its own subsequent read (single-table minimal-repro probe).
export class DrainOwn extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const q = (name, def) => {
			const v = query && (query.get ? query.get(name) : query[name]);
			return v == null ? def : v;
		};
		const tableName = q('table', 'MinRepro');
		const key = q('key', 'repo-0');
		const reads = Number(q('reads', 2));
		const scan = q('scan', 'index');
		const table = getTable(tableName);
		if (!table) throw new Error(`unknown table ${tableName}`);

		const counts = [];
		for (let i = 0; i < reads; i++) {
			let count = 0;
			if (scan === 'full') {
				for await (const r of table.search({ conditions: [] })) {
					if (r.repositoryId === key) count++;
				}
			} else {
				for await (const _r of table.search({
					operator: 'and',
					conditions: [{ attribute: 'repositoryId', comparator: 'equals', value: key }],
				})) {
					count++;
				}
			}
			counts.push(count);
		}
		return { table: tableName, key, scan, reads, counts };
	}
}

// GET /Drain/?tables=A,B&scan=index|full&key=repo-N — for EACH table in `tables` order,
// WITHIN THIS ONE REQUEST, counts rows with repositoryId===key via an indexed AND-equals
// search (scan=index, default) or an unconditioned full scan filtered in JS (scan=full,
// the index-independent oracle). Mirrors qa629's Drain endpoint (cross-table order check).
export class Drain extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const q = (name, def) => {
			const v = query && (query.get ? query.get(name) : query[name]);
			return v == null ? def : v;
		};
		const tableNames = String(q('tables', 'MinReproB,MinRepro'))
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const key = q('key', 'repo-0');
		const scan = q('scan', 'index');

		const counts = {};
		for (const tableName of tableNames) {
			const table = getTable(tableName);
			if (!table) throw new Error(`unknown table ${tableName}`);
			let count = 0;
			if (scan === 'full') {
				for await (const r of table.search({ conditions: [] })) {
					if (r.repositoryId === key) count++;
				}
			} else {
				for await (const _r of table.search({
					operator: 'and',
					conditions: [{ attribute: 'repositoryId', comparator: 'equals', value: key }],
				})) {
					count++;
				}
			}
			counts[tableName] = count;
		}
		return { order: tableNames, key, scan, counts };
	}
}

// POST /UpsertViaIndex/ { decoyTable, table, key, marker } — WRITE-reach probe (question 3).
// Models a realistic "upsert guard": within ONE request, first read a decoy table via index
// (occupies request position 1), then look up `key` in `table` via its secondary index
// (request position 2 — the position F-158 corrupts) to decide whether a marker row should
// be inserted (guard: only insert if the index lookup found ZERO existing rows for `key`).
// If F-158 makes that index lookup wrongly return 0 despite existing rows, the guard fires
// incorrectly and a DUPLICATE marker row is durably written — the read-side miss becoming a
// wrong, persisted WRITE.
export class UpsertViaIndex extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const decoyTable = b.decoyTable ? getTable(b.decoyTable) : null;
		const table = getTable(b.table);
		if (!table) throw new Error(`unknown table ${b.table}`);
		const key = b.key;
		const marker = b.marker || `dup-${Date.now()}`;

		let decoyCount = 0;
		if (decoyTable) {
			for await (const _r of decoyTable.search({
				operator: 'and',
				conditions: [{ attribute: 'repositoryId', comparator: 'equals', value: key }],
			})) {
				decoyCount++;
			}
		}

		let existing = 0;
		for await (const _r of table.search({
			operator: 'and',
			conditions: [{ attribute: 'repositoryId', comparator: 'equals', value: key }],
		})) {
			existing++;
		}

		const markerId = `${b.table}-DUPGUARD-${key}-${marker}`;
		let wroteMarker = false;
		if (existing === 0) {
			await table.put({
				id: markerId,
				repositoryId: key,
				n: -1,
				body: 'DUPGUARD marker: guard fired because index lookup found 0 existing rows',
			});
			wroteMarker = true;
		}
		return { decoyCount, existing, wroteMarker, markerId };
	}
}
