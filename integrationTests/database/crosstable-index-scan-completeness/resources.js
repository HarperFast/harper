// QA-772 — arm the QA-629/F-158/GH#1881 defect oracle (>1 on-disk RocksDB sorted run per
// table) WITHOUT storage.rocks.writeBufferManagerSize, which now hangs this fixture's ~20MB/
// table seed on this machine (single request never returns, blows past undici's 300s timeout).
//
// Technique: force a REAL memtable flush between seeding waves via `table.primaryStore.flush()`
// — the same mechanism already proven safe and reachable in sibling QA fixtures (qa638-
// upgrade-sortedrun, qa731/732/746/760) that call `.flush()`/`.compact()` directly on
// `primaryStore`/`indices[attr]` (inherited from @harperfast/rocksdb-js's RocksDatabase, NOT
// exposed via the sandboxed `harper` module's flushDatabases() — see qa731's header). RocksDB's
// native flush is atomic across every column family sharing the schema's on-disk directory
// (atomic_flush=true), so ONE flush() call after each wave seals that wave's memtable into its
// own SST file for primary + every index CF, across BOTH GenA and GenB. No pathological config
// needed at all — this is candidate (a) from QA-772: no WBM cap, so no write-stall risk.

function getTable(tableName) {
	return databases['metrics-repro'][tableName];
}

function bodyOf(kb) {
	return 'x'.repeat(1024).repeat(kb);
}

// GET /Probe/ -> readiness poll target (component pre-installed; no restart needed).
export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

// POST /SeedWave/ { table, wave, keys, perKeyPerWave, bodyKb } — one wave = one transaction.
// Identical shape to qa629/qa638's proven forced-flush seeding pattern.
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

// POST /Flush/ -> force every RocksDB column family sharing this schema's directory to flush
// its memtable to a new SST file, atomically (see header). This is the sorted-run-forcing
// mechanism itself: call once between seeding waves to make each wave its own on-disk run.
export class Flush extends Resource {
	static loadAsInstance = false;
	async post() {
		const t = getTable('GenA');
		if (typeof t.primaryStore.flush !== 'function')
			throw new Error('QA-772 Flush control invalid: primaryStore.flush() not available (not RocksDB?)');
		await t.primaryStore.flush();
		return { ok: true };
	}
}

// GET /IndexStats/?table=X&attribute=repositoryId — RocksDB num-files-at-level0 proxy for
// "how many un-merged sorted runs", carried over verbatim from qa638-upgrade-sortedrun
// (getDBIntProperty('rocksdb.num-files-at-level0') reliably returns undefined on this
// @harperfast/rocksdb-js build; getDBProperty('rocksdb.levelstats') is a string property that
// DOES work, so parse the "Level 0" row's file count out of it instead).
export class IndexStats extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = (query && (query.get ? query.get('table') : query.table)) || 'GenA';
		const attribute = (query && (query.get ? query.get('attribute') : query.attribute)) || 'repositoryId';
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
			let numEntries;
			try {
				numEntries = store.getDBIntProperty('rocksdb.estimate-num-keys');
			} catch {
				/* not fatal */
			}
			return { l0Files, numEntries, levelStats };
		}
		return { table: tableName, attribute, primary: statsOf(primaryStore), index: statsOf(indexStore) };
	}
}

// GET /Drain/?tables=GenB,GenA&scan=index|full&key=repo-7 — drain `key` across `tables` IN
// ORDER, all within this ONE request/transaction. Identical to qa629's Drain (the actual
// defect oracle: does the SECOND indexed table read in a request come back short?).
export class Drain extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const q = (name, def) => {
			const v = query && (query.get ? query.get(name) : query[name]);
			return v == null ? def : v;
		};
		const tableNames = String(q('tables', 'GenB,GenA'))
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const key = q('key', 'repo-0');
		const scan = q('scan', 'index');

		const counts = {};
		// Which table each returned row actually came from, keyed by the row-id prefix. #1881's
		// worse outcome is a read resolved against a foreign column family returning a SIBLING
		// TABLE's row at the expected cardinality — invisible to a count, visible here.
		const owners = {};
		for (const tableName of tableNames) {
			const table = getTable(tableName);
			if (!table) throw new Error(`unknown table ${tableName}`);
			let count = 0;
			const seen = new Set();
			if (scan === 'full') {
				for await (const r of table.search({ conditions: [] })) {
					if (r.repositoryId === key) {
						count++;
						seen.add(String(r.id).split('-')[0]);
					}
				}
			} else {
				for await (const r of table.search({
					operator: 'and',
					conditions: [{ attribute: 'repositoryId', comparator: 'equals', value: key }],
				})) {
					count++;
					seen.add(String(r.id).split('-')[0]);
				}
			}
			counts[tableName] = count;
			owners[tableName] = [...seen].sort();
		}
		return { order: tableNames, key, scan, counts, owners };
	}
}
